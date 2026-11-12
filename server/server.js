/*
 * Сервер KinoBattle.
 *
 * - HTTP: веб-превʼю (preview/, shared/, KinoBattleApp/questions.json) і API акаунтів (/api/…).
 * - WebSocket (/ws): матчі 1 на 1 між людьми — за кодом кімнати, випадковий суперник, запрошення друзів.
 *
 * Сервер — єдине джерело правди в матчах між людьми: він обирає питання, міряє час відповіді,
 * рахує очки й рейтинг (через спільний shared/engine.js).
 *
 * Змінні середовища: PORT (5180), HOST (127.0.0.1), TIME_SCALE (1),
 * DB_PATH (server/data/kinobattle.db; ':memory:' — для тестів),
 * RESEND_API_KEY / MAIL_FROM — справжні листи з кодами (інакше коди в консоль).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./db.js');
const { createAuth, createMailer } = require('./auth.js');
const { createApi } = require('./api.js');
const { createGame } = require('./game.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST || '127.0.0.1';
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kinobattle.db');

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'KinoBattleApp', 'questions.json'), 'utf8'));
const store = new Store(DB_PATH);
const mailer = createMailer();
const auth = createAuth({ store, mailer });

// ===== Статика =====

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const PUBLIC_DIRS = ['preview', 'shared', 'KinoBattleApp/media'];
const PUBLIC_FILES = ['KinoBattleApp/questions.json'];

function resolvePublic(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel.endsWith('/') || rel === 'preview') rel = rel.replace(/\/?$/, '/index.html');
  const full = path.resolve(ROOT, rel);
  const relNorm = path.relative(ROOT, full).split(path.sep).join('/');
  if (relNorm.startsWith('..')) return null;
  const allowed = PUBLIC_FILES.includes(relNorm) || PUBLIC_DIRS.some(d => relNorm.startsWith(d + '/'));
  return allowed ? full : null;
}

function serveStatic(req, res, url) {
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/preview/' });
    return res.end();
  }
  const file = resolvePublic(url.pathname);
  if (!file) {
    res.writeHead(404);
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ===== Збірка =====

let api;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await api(req, res, url)) return;
  serveStatic(req, res, url);
});

const game = createGame({ server, bank, store, timeScale: TIME_SCALE });
api = createApi({ store, auth, game });

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  // Перший рядок виводу читають тести, щоб дізнатися порт.
  console.log(`KinoBattle server listening on http://${HOST}:${port}`);
  console.log(`Preview: http://localhost:${port}/preview/  ·  два телефони: http://localhost:${port}/preview/duo.html`);
  if (mailer.dev) console.log('[auth] RESEND_API_KEY не задано — коди входу друкуються сюди й показуються в превʼю');
});

module.exports = { server };
