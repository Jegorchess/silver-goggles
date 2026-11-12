/*
 * Онлайн-сервер KinoBattle.
 *
 * - HTTP: роздає веб-превʼю (preview/, shared/, KinoBattleApp/questions.json).
 * - WebSocket (/ws): матчі 1 на 1 між людьми — за кодом кімнати або випадковий суперник.
 *
 * Сервер — єдине джерело правди: він обирає питання, перемішує варіанти, міряє час відповіді
 * й рахує очки (через спільний shared/engine.js). Клієнт лише показує й надсилає вибір.
 *
 * Змінні середовища: PORT (5180), HOST (127.0.0.1; 0.0.0.0 — щоб зайти з телефона в тій самій Wi-Fi),
 * TIME_SCALE (1; для тестів — менше, щоб матч ішов швидше).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const E = require('../shared/engine.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST || '127.0.0.1';
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);

const QUESTIONS_PATH = path.join(ROOT, 'KinoBattleApp', 'questions.json');
const bank = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));

const HUMAN_AVATARS = ['🎬', '🎭'];
const MAX_NAME = 16;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O та 1/I
const CODE_LENGTH = 4;

// ===== HTTP: статика =====

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const PUBLIC_DIRS = ['preview', 'shared'];
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
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
});

// ===== WebSocket: лобі та матчі =====

/** @type {Map<string, Room>} кімнати з кодом */
const rooms = new Map();
/** @type {Map<number, Client>} хто чекає на випадкового суперника, за довжиною матчу */
const queue = new Map();

class Client {
  constructor(ws) {
    this.ws = ws;
    this.name = 'Гравець';
    this.room = null;
    this.queuedFor = null;
    this.alive = true;
  }
  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

class Room {
  constructor(length, code = null) {
    this.length = length;
    this.code = code;
    this.members = [];
    this.match = null;
    this.recent = [];
    this.rematch = new Set();
  }
}

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function validLength(n) {
  return E.MatchRules.matchLengths.includes(n) ? n : E.MatchRules.questionsPerMatch;
}

function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, MAX_NAME).join('') || 'Гравець';
}

function startMatch(room) {
  room.rematch = new Set();
  const questions = E.pickQuestions(bank, room.length, room.recent);
  room.recent = E.updateRecent(room.recent, questions);
  const players = room.members.map((c, seat) => ({
    name: c.name,
    avatar: HUMAN_AVATARS[seat],
    send: msg => c.send(msg),
  }));
  room.match = new E.Match({ questions, players, timeScale: TIME_SCALE });
  room.match.start();
}

/** Прибирає клієнта з черги та кімнати. Якщо йде матч — суперник отримує технічну перемогу. */
function leaveCurrent(client) {
  if (client.queuedFor != null) {
    if (queue.get(client.queuedFor) === client) queue.delete(client.queuedFor);
    client.queuedFor = null;
  }
  const room = client.room;
  if (!room) return;
  const seat = room.members.indexOf(client);
  if (room.match && room.match.state !== 'ended') room.match.leave(seat);
  room.members.splice(seat, 1);
  client.room = null;
  for (const other of room.members) {
    other.send({ t: 'opponentLeft' });
  }
  if (room.match) {
    // Після матчу з одним гравцем кімната вже не потрібна.
    for (const other of room.members) other.room = null;
    room.members = [];
  }
  if (room.members.length === 0 && room.code) rooms.delete(room.code);
}

const handlers = {
  hello(client, msg) {
    client.name = cleanName(msg.name);
  },

  create(client, msg) {
    leaveCurrent(client);
    const room = new Room(validLength(msg.length), newCode());
    room.members.push(client);
    client.room = room;
    rooms.set(room.code, room);
    client.send({ t: 'room', code: room.code, length: room.length });
  },

  join(client, msg) {
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.match) return client.send({ t: 'error', message: 'Кімнату не знайдено' });
    if (room.members.includes(client)) return;
    if (room.members.length >= 2) return client.send({ t: 'error', message: 'Кімната вже заповнена' });
    leaveCurrent(client);
    room.members.push(client);
    client.room = room;
    rooms.delete(code); // код одноразовий: після старту в кімнату вже не зайти
    room.code = null;
    startMatch(room);
  },

  quick(client, msg) {
    leaveCurrent(client);
    const length = validLength(msg.length);
    const waiting = queue.get(length);
    if (waiting && waiting !== client && waiting.ws.readyState === WebSocket.OPEN) {
      queue.delete(length);
      waiting.queuedFor = null;
      const room = new Room(length);
      room.members.push(waiting, client);
      waiting.room = room;
      client.room = room;
      startMatch(room);
    } else {
      queue.set(length, client);
      client.queuedFor = length;
      client.send({ t: 'queued', length });
    }
  },

  cancel(client) {
    leaveCurrent(client);
  },

  leave(client) {
    leaveCurrent(client);
  },

  answer(client, msg) {
    const room = client.room;
    if (room?.match) room.match.answer(room.members.indexOf(client), msg.index, msg.option);
  },

  skip(client, msg) {
    const room = client.room;
    if (room?.match) room.match.skip(room.members.indexOf(client), msg.index);
  },

  rematch(client) {
    const room = client.room;
    if (!room?.match || room.match.state !== 'ended' || room.members.length !== 2) return;
    room.rematch.add(client);
    if (room.rematch.size === 2) startMatch(room);
    else room.members.find(c => c !== client).send({ t: 'rematchRequested' });
  },
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

wss.on('connection', ws => {
  const client = new Client(ws);
  ws.on('pong', () => { client.alive = true; });
  ws.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const handler = msg && typeof msg.t === 'string' && Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
    if (handler) handler(client, msg);
  });
  ws.on('close', () => leaveCurrent(client));
  ws.kbClient = client;
});

// Відрізаємо «мертві» зʼєднання (телефон заснув, пропала мережа).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const client = ws.kbClient;
    if (!client) continue;
    if (!client.alive) {
      ws.terminate();
      continue;
    }
    client.alive = false;
    ws.ping();
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  // Перший рядок виводу читають тести, щоб дізнатися порт.
  console.log(`KinoBattle server listening on http://${HOST}:${port}`);
  console.log(`Preview: http://localhost:${port}/preview/`);
});

module.exports = { server, wss };
