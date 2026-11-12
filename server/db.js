/*
 * Сховище KinoBattle на вбудованому в Node SQLite (node:sqlite) — без зовнішніх залежностей.
 *
 * Акаунт без email — гість. Гість має історію й статистику, але не має рейтингу,
 * коду друга й не потрапляє в таблицю лідерів. Після підтвердження пошти той самий акаунт
 * стає зареєстрованим — увесь прогрес зберігається.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const START_RATING = 1000;
const ELO_K = 32;
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FRIEND_CODE_LENGTH = 6;
const BOT_NAME = 'Кіноман';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  friend_code TEXT UNIQUE,
  rating INTEGER NOT NULL DEFAULT ${START_RATING},
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  mode TEXT NOT NULL,                 -- 'human' | 'bot'
  length INTEGER NOT NULL,
  a_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  b_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  a_name TEXT NOT NULL,
  b_name TEXT NOT NULL,
  a_score INTEGER NOT NULL,
  b_score INTEGER NOT NULL,
  a_correct INTEGER NOT NULL,
  b_correct INTEGER NOT NULL,
  a_outcome TEXT NOT NULL,            -- 'win' | 'loss' | 'draw' з погляду гравця A
  reason TEXT,
  rated INTEGER NOT NULL DEFAULT 0,
  a_delta INTEGER NOT NULL DEFAULT 0,
  b_delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS matches_a ON matches(a_id, created_at);
CREATE INDEX IF NOT EXISTS matches_b ON matches(b_id, created_at);
CREATE TABLE IF NOT EXISTS photos (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,               -- 'pending' | 'accepted'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
-- Кожен матч з погляду кожного його учасника.
CREATE VIEW IF NOT EXISTS player_matches AS
  SELECT id, created_at, mode, length, a_id AS me, b_id AS opp_id, b_name AS opp_name,
         a_score AS my_score, b_score AS opp_score, a_correct AS my_correct, b_correct AS opp_correct,
         a_outcome AS outcome, reason, rated, a_delta AS delta
  FROM matches
  UNION ALL
  SELECT id, created_at, mode, length, b_id, a_id, a_name,
         b_score, a_score, b_correct, a_correct,
         CASE a_outcome WHEN 'win' THEN 'loss' WHEN 'loss' THEN 'win' ELSE 'draw' END,
         reason, rated, b_delta
  FROM matches WHERE mode = 'human';
`;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** Адреса фото з версією: після заміни URL змінюється, тож старе фото не застрягає в кеші. */
function photoUrl(acc) {
  return acc && acc.photo_version ? `/api/photos/${acc.id}?v=${acc.photo_version}` : null;
}

/** Зміна рейтингу Elo для гравця A (для B — з протилежним знаком). */
function eloDelta(ratingA, ratingB, outcomeA) {
  const expected = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const actual = outcomeA === 'win' ? 1 : outcomeA === 'loss' ? 0 : 0.5;
  return Math.round(ELO_K * (actual - expected));
}

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Додає колонки, яких не було в старих базах. */
  migrate() {
    const cols = this.db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
    if (!cols.includes('photo_version')) this.db.exec('ALTER TABLE accounts ADD COLUMN photo_version INTEGER');
  }

  q(sql) {
    return this.db.prepare(sql);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ===== Акаунти =====

  createGuest(name) {
    const { lastInsertRowid } = this.q('INSERT INTO accounts (name, created_at) VALUES (?, ?)').run(name, Date.now());
    return this.getAccount(Number(lastInsertRowid));
  }

  getAccount(id) {
    return this.q('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  }

  findByEmail(email) {
    return this.q('SELECT * FROM accounts WHERE email = ?').get(email) || null;
  }

  findByFriendCode(code) {
    return this.q('SELECT * FROM accounts WHERE friend_code = ?').get(code) || null;
  }

  /** Гість → зареєстрований: привʼязуємо пошту й видаємо код друга. */
  register(id, email) {
    this.q('UPDATE accounts SET email = ?, friend_code = ? WHERE id = ?').run(email, this.newFriendCode(), id);
    return this.getAccount(id);
  }

  newFriendCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < FRIEND_CODE_LENGTH; i++) code += FRIEND_CODE_ALPHABET[crypto.randomInt(FRIEND_CODE_ALPHABET.length)];
      if (!this.findByFriendCode(code)) return code;
    }
  }

  rename(id, name) {
    this.q('UPDATE accounts SET name = ? WHERE id = ?').run(name, id);
    return this.getAccount(id);
  }

  /** Гість увійшов в існуючий акаунт: його матчі переходять туди, гостьовий акаунт зникає. */
  mergeGuestInto(guestId, targetId) {
    this.tx(() => {
      this.q('UPDATE matches SET a_id = ? WHERE a_id = ?').run(targetId, guestId);
      this.q('UPDATE matches SET b_id = ? WHERE b_id = ?').run(targetId, guestId);
      this.q('DELETE FROM accounts WHERE id = ?').run(guestId);
    });
  }

  /** Видалення акаунта (вимога App Store). Матчі лишаються в історії суперників під збереженим імʼям. */
  deleteAccount(id) {
    this.q('DELETE FROM accounts WHERE id = ?').run(id);
  }

  // ===== Фото профілю =====

  setPhoto(id, data) {
    this.tx(() => {
      this.q(`INSERT INTO photos (account_id, data) VALUES (?, ?)
              ON CONFLICT(account_id) DO UPDATE SET data = excluded.data`).run(id, data);
      this.q('UPDATE accounts SET photo_version = ? WHERE id = ?').run(Date.now(), id);
    });
    return this.getAccount(id);
  }

  getPhoto(id) {
    return this.q('SELECT data FROM photos WHERE account_id = ?').get(id)?.data || null;
  }

  deletePhoto(id) {
    this.tx(() => {
      this.q('DELETE FROM photos WHERE account_id = ?').run(id);
      this.q('UPDATE accounts SET photo_version = NULL WHERE id = ?').run(id);
    });
    return this.getAccount(id);
  }

  // ===== Сесії =====

  createSession(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    this.q('INSERT INTO sessions (token_hash, account_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(sha256(token), accountId, t, t);
    return token;
  }

  accountForToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = this.q('SELECT account_id FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!row) return null;
    this.q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), sha256(token));
    return this.getAccount(row.account_id);
  }

  deleteSession(token) {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(String(token)));
  }

  // ===== Коди з пошти =====

  saveEmailCode(email, code, ttlMs) {
    const t = Date.now();
    this.q(`INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
            attempts = 0, sent_at = excluded.sent_at`).run(email, sha256(email + ':' + code), t + ttlMs, t);
  }

  getEmailCode(email) {
    return this.q('SELECT * FROM email_codes WHERE email = ?').get(email) || null;
  }

  bumpEmailCodeAttempts(email) {
    this.q('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
  }

  deleteEmailCode(email) {
    this.q('DELETE FROM email_codes WHERE email = ?').run(email);
  }

  checkEmailCode(row, code) {
    return row.code_hash === sha256(row.email + ':' + code);
  }

  // ===== Матчі =====

  /**
   * Записує матч між людьми. Рейтинг змінюється, лише якщо обидва зареєстровані.
   * @returns {{ rated: boolean, deltas: [number, number], ratings: [number|null, number|null] }}
   */
  recordHumanMatch({ length, reason, players }) {
    return this.tx(() => {
      const accs = players.map(p => (p.accountId ? this.getAccount(p.accountId) : null));
      const rated = accs.every(a => a && a.email) && accs[0].id !== accs[1].id;
      let deltas = [0, 0];
      if (rated) {
        const d = eloDelta(accs[0].rating, accs[1].rating, players[0].outcome);
        deltas = [d, -d];
        accs.forEach((a, i) => this.q('UPDATE accounts SET rating = rating + ? WHERE id = ?').run(deltas[i], a.id));
      }
      this.q(`INSERT INTO matches (created_at, mode, length, a_id, b_id, a_name, b_name, a_score, b_score,
              a_correct, b_correct, a_outcome, reason, rated, a_delta, b_delta)
              VALUES (?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Date.now(), length, accs[0]?.id ?? null, accs[1]?.id ?? null, players[0].name, players[1].name,
        players[0].score, players[1].score, players[0].correct, players[1].correct, players[0].outcome,
        reason, rated ? 1 : 0, deltas[0], deltas[1]);
      const ratings = accs.map(a => (a && a.email ? this.getAccount(a.id).rating : null));
      return { rated, deltas, ratings };
    });
  }

  /** Матч із ботом грається на пристрої, тому лише йде в статистику — без рейтингу. */
  recordBotMatch(accountId, { length, outcome, you, opponent }) {
    const acc = this.getAccount(accountId);
    this.q(`INSERT INTO matches (created_at, mode, length, a_id, b_id, a_name, b_name, a_score, b_score,
            a_correct, b_correct, a_outcome, reason, rated)
            VALUES (?, 'bot', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`).run(
      Date.now(), length, accountId, acc.name, BOT_NAME, you.score, opponent.score, you.correct, opponent.correct, outcome);
  }

  history(accountId, limit = 20) {
    return this.q(`SELECT id, created_at, mode, length, opp_name, my_score, opp_score, my_correct, outcome, reason, rated, delta
                   FROM player_matches WHERE me = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(accountId, limit);
  }

  stats(accountId) {
    const rows = this.q(`SELECT mode,
                          COUNT(*) AS played,
                          SUM(outcome = 'win') AS wins,
                          SUM(outcome = 'loss') AS losses,
                          SUM(outcome = 'draw') AS draws,
                          SUM(my_correct) AS correct,
                          SUM(length) AS questions,
                          MAX(my_score) AS best_score
                        FROM player_matches WHERE me = ? GROUP BY mode`).all(accountId);
    const empty = { played: 0, wins: 0, losses: 0, draws: 0 };
    const out = { human: { ...empty }, bot: { ...empty }, accuracy: null, bestScore: 0 };
    let correct = 0;
    let questions = 0;
    for (const r of rows) {
      out[r.mode] = { played: r.played, wins: r.wins, losses: r.losses, draws: r.draws };
      correct += r.correct;
      questions += r.questions;
      out.bestScore = Math.max(out.bestScore, r.best_score);
    }
    if (questions) out.accuracy = Math.round((correct / questions) * 100);
    return out;
  }

  // ===== Рейтинг =====

  /** Лише зареєстровані, що зіграли хоч один рейтинговий матч. */
  leaderboard(limit = 50) {
    return this.q(`SELECT a.id, a.name, a.rating, a.photo_version,
                     (SELECT COUNT(*) FROM player_matches pm WHERE pm.me = a.id AND pm.rated = 1) AS games
                   FROM accounts a
                   WHERE a.email IS NOT NULL
                     AND EXISTS (SELECT 1 FROM player_matches pm WHERE pm.me = a.id AND pm.rated = 1)
                   ORDER BY a.rating DESC, a.id ASC LIMIT ?`).all(limit);
  }

  rank(accountId) {
    const acc = this.getAccount(accountId);
    if (!acc?.email) return null;
    const ranked = this.q('SELECT 1 FROM player_matches WHERE me = ? AND rated = 1 LIMIT 1').get(accountId);
    if (!ranked) return null;
    const { above } = this.q(`SELECT COUNT(*) AS above FROM accounts a
                              WHERE a.email IS NOT NULL AND (a.rating > ? OR (a.rating = ? AND a.id < ?))
                                AND EXISTS (SELECT 1 FROM player_matches pm WHERE pm.me = a.id AND pm.rated = 1)`)
      .get(acc.rating, acc.rating, acc.id);
    return above + 1;
  }

  // ===== Друзі =====

  friendship(a, b) {
    return this.q(`SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?)
                                                OR (requester_id = ? AND addressee_id = ?)`).get(a, b, b, a) || null;
  }

  areFriends(a, b) {
    return this.friendship(a, b)?.status === 'accepted';
  }

  /** Запит у друзі за кодом. Якщо зустрічний запит уже є — одразу дружба. */
  requestFriend(fromId, code) {
    const target = this.findByFriendCode(String(code || '').trim().toUpperCase());
    if (!target) return { error: 'Гравця з таким кодом не знайдено' };
    if (target.id === fromId) return { error: 'Це твій власний код' };
    const existing = this.friendship(fromId, target.id);
    if (existing?.status === 'accepted') return { error: 'Ви вже друзі' };
    if (existing && existing.requester_id === fromId) return { error: 'Запит уже надіслано' };
    if (existing) {
      this.acceptFriend(fromId, target.id);
      return { status: 'accepted', friend: target };
    }
    this.q('INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, \'pending\', ?)')
      .run(fromId, target.id, Date.now());
    return { status: 'pending', friend: target };
  }

  acceptFriend(meId, otherId) {
    const r = this.q(`UPDATE friendships SET status = 'accepted'
                      WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`).run(otherId, meId);
    return r.changes > 0;
  }

  removeFriend(meId, otherId) {
    this.q(`DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?)
                                       OR (requester_id = ? AND addressee_id = ?)`).run(meId, otherId, otherId, meId);
  }

  friends(meId) {
    const rows = this.q(`SELECT f.requester_id, f.addressee_id, f.status, a.id, a.name, a.rating, a.photo_version
                         FROM friendships f
                         JOIN accounts a ON a.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
                         WHERE f.requester_id = ? OR f.addressee_id = ?
                         ORDER BY a.name COLLATE NOCASE`).all(meId, meId, meId);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const r of rows) {
      const person = { id: r.id, name: r.name, rating: r.rating, photo: photoUrl(r) };
      if (r.status === 'accepted') out.friends.push(person);
      else if (r.addressee_id === meId) out.incoming.push(person);
      else out.outgoing.push(person);
    }
    return out;
  }
}

module.exports = { Store, eloDelta, photoUrl, START_RATING, BOT_NAME };
