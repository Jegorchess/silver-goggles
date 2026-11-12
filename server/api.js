/*
 * HTTP API акаунтів: гість, вхід через пошту, профіль, історія, рейтинг, друзі.
 * Авторизація — заголовок `Authorization: Bearer <token>`. Опис — у server/README.md.
 */
'use strict';

const E = require('../shared/engine.js');
const { AuthError } = require('./auth.js');
const { cleanName } = require('./game.js');

const MAX_BODY = 4 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AuthError(413, 'Завеликий запит'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new AuthError(400, 'Некоректний JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Імʼя для нового акаунта з пошти: «shakhmatenko.egor+kb@…» → «Shakhmatenko Egor». */
function nameFromEmail(email) {
  const local = email.split('@')[0].split('+')[0];
  const words = local.split(/[._-]+/).map(w => w.replace(/\d+/g, '')).filter(Boolean);
  const pretty = words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return cleanName(pretty || local);
}

function createApi({ store, auth, game }) {
  function profile(acc) {
    return {
      id: acc.id,
      name: acc.name,
      guest: !acc.email,
      email: acc.email,
      friendCode: acc.friend_code,
      rating: acc.email ? acc.rating : null,
      rank: store.rank(acc.id),
      stats: store.stats(acc.id),
    };
  }

  function requireAccount(req) {
    const acc = store.accountForToken(bearer(req));
    if (!acc) throw new AuthError(401, 'Потрібно увійти');
    return acc;
  }

  function requireRegistered(req) {
    const acc = requireAccount(req);
    if (!acc.email) throw new AuthError(403, 'Доступно лише з акаунтом');
    return acc;
  }

  const routes = {
    'POST /api/guest': async req => {
      const { name } = await readJson(req);
      const acc = store.createGuest(cleanName(name));
      return { token: store.createSession(acc.id), me: profile(acc) };
    },

    'POST /api/auth/email/start': async req => {
      const { email } = await readJson(req);
      const r = await auth.startEmail(email);
      return { sent: true, email: r.email, devCode: r.devCode };
    },

    /**
     * Підтвердження коду. Якщо запит іде від гостя:
     *  - нова пошта → цей самий акаунт стає зареєстрованим (прогрес на місці);
     *  - пошта вже має акаунт → входимо в нього, а матчі гостя переносимо туди.
     */
    'POST /api/auth/email/verify': async req => {
      const body = await readJson(req);
      const email = auth.verifyEmail(body.email, body.code);
      const current = store.accountForToken(bearer(req));
      let acc = store.findByEmail(email);
      let merged = false;
      if (acc) {
        if (current && !current.email && current.id !== acc.id) {
          store.mergeGuestInto(current.id, acc.id);
          merged = true;
        }
      } else if (current && !current.email) {
        acc = store.register(current.id, email);
      } else {
        acc = store.register(store.createGuest(nameFromEmail(email)).id, email);
      }
      if (current) store.deleteSession(bearer(req));
      return { token: store.createSession(acc.id), me: profile(store.getAccount(acc.id)), merged };
    },

    'POST /api/auth/logout': async req => {
      const token = bearer(req);
      if (token) store.deleteSession(token);
      return { ok: true };
    },

    'GET /api/me': async req => profile(requireAccount(req)),

    'PATCH /api/me': async req => {
      const acc = requireAccount(req);
      const { name } = await readJson(req);
      const updated = store.rename(acc.id, cleanName(name));
      game.renamed(acc.id, updated.name);
      return profile(updated);
    },

    'DELETE /api/me': async req => {
      const acc = requireAccount(req);
      game.dropAccount(acc.id);
      store.deleteAccount(acc.id);
      return { deleted: true };
    },

    'GET /api/me/history': async req => ({ matches: store.history(requireAccount(req).id, 30) }),

    /** Результат гри з ботом (вона йде на пристрої). Лише статистика, без рейтингу. */
    'POST /api/matches/bot': async req => {
      const acc = requireAccount(req);
      const b = await readJson(req);
      const length = b.length;
      const maxScore = (length - 1) * 1000 + 2000;
      const okSide = s => s && int(s.score, 0, maxScore) && int(s.correct, 0, length);
      if (!E.MatchRules.matchLengths.includes(length) || !['win', 'loss', 'draw'].includes(b.outcome) || !okSide(b.you) || !okSide(b.opponent)) {
        throw new AuthError(400, 'Некоректний результат матчу');
      }
      store.recordBotMatch(acc.id, { length, outcome: b.outcome, you: b.you, opponent: b.opponent });
      return { ok: true };
    },

    'GET /api/leaderboard': async req => {
      const acc = store.accountForToken(bearer(req));
      return {
        top: store.leaderboard(50).map(r => ({ id: r.id, name: r.name, rating: r.rating, games: r.games })),
        me: acc ? { id: acc.id, guest: !acc.email, rating: acc.email ? acc.rating : null, rank: store.rank(acc.id) } : null,
      };
    },

    'GET /api/friends': async req => {
      const acc = requireRegistered(req);
      const f = store.friends(acc.id);
      f.friends = f.friends.map(p => ({ ...p, online: game.isOnline(p.id) }));
      return { ...f, friendCode: acc.friend_code };
    },

    'POST /api/friends': async req => {
      const acc = requireRegistered(req);
      const { code } = await readJson(req);
      const r = store.requestFriend(acc.id, code);
      if (r.error) throw new AuthError(400, r.error);
      return { status: r.status, friend: { id: r.friend.id, name: r.friend.name } };
    },
  };

  /** Маршрути з id: POST /api/friends/:id/accept, DELETE /api/friends/:id */
  async function friendById(req, method, rest) {
    const acc = requireRegistered(req);
    const m = /^(\d+)(\/accept)?$/.exec(rest);
    if (!m) return null;
    const otherId = Number(m[1]);
    if (method === 'POST' && m[2]) {
      if (!store.acceptFriend(acc.id, otherId)) throw new AuthError(404, 'Запит не знайдено');
      return { ok: true };
    }
    if (method === 'DELETE' && !m[2]) {
      store.removeFriend(acc.id, otherId);
      return { ok: true };
    }
    return null;
  }

  /** @returns {Promise<boolean>} чи оброблено запит */
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      let data;
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) data = await route(req);
      else if (url.pathname.startsWith('/api/friends/')) data = await friendById(req, req.method, url.pathname.slice('/api/friends/'.length));
      if (data == null) send(res, 404, { error: 'Не знайдено' });
      else send(res, 200, data);
    } catch (e) {
      if (e instanceof AuthError) send(res, e.status, { error: e.message });
      else {
        console.error('[api]', e);
        send(res, 500, { error: 'Помилка сервера' });
      }
    }
    return true;
  };
}

module.exports = { createApi, nameFromEmail };
