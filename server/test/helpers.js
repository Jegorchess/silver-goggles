'use strict';
// Спільне для наскрізних тестів: окремий процес сервера з базою в памʼяті та тестові клієнти.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { WebSocket } = require('ws');

/** Запускає сервер і повертає { base, stop }. */
async function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', TIME_SCALE: '0.01', DB_PATH: ':memory:', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = await new Promise((resolve, reject) => {
    proc.on('exit', code => reject(new Error(`server exited ${code}`)));
    proc.stdout.on('data', d => {
      const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(String(d));
      if (m) resolve(m[1]);
    });
  });
  return { base, stop: () => proc.kill() };
}

/** WebSocket-клієнт: складає повідомлення в чергу, `next(t)` чекає на потрібне. */
async function wsClient(base, { name, token } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const msg = JSON.parse(d);
    const i = waiters.findIndex(w => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise(r => ws.on('open', r));
  const c = {
    send: msg => ws.send(JSON.stringify(msg)),
    next(t, timeout = 5000) {
      const pred = typeof t === 'function' ? t : m => m.t === t;
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`${name || token}: не дочекались ${typeof t === 'string' ? t : 'повідомлення'}`)), timeout);
      });
    },
    close: () => ws.close(),
  };
  if (token) {
    c.send({ t: 'auth', token });
    await c.next('authed');
  } else if (name) {
    c.send({ t: 'hello', name });
  }
  return c;
}

/** Грає весь матч: відповідає варіантом `option(msg)`, доки не прийде `end`. */
async function playThrough(c, option = () => 0) {
  for (;;) {
    const msg = await c.next(m => m.t === 'options' || m.t === 'end');
    if (msg.t === 'end') return msg;
    const o = option(msg);
    if (o != null) c.send({ t: 'answer', index: msg.index, option: o });
  }
}

/** HTTP-клієнт API з токеном. */
function apiClient(base) {
  const c = {
    token: null,
    async call(method, p, body) {
      const r = await fetch(base + '/api' + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json();
      return { status: r.status, ...data };
    },
    async guest(name) {
      const r = await c.call('POST', '/guest', { name });
      c.token = r.token;
      return r.me;
    },
    async register(email) {
      const s = await c.call('POST', '/auth/email/start', { email });
      const v = await c.call('POST', '/auth/email/verify', { email, code: s.devCode });
      if (v.token) c.token = v.token;
      return v;
    },
  };
  return c;
}

module.exports = { startServer, wsClient, playThrough, apiClient };
