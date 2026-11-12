'use strict';
// Наскрізний тест: справжній сервер + два WebSocket-клієнти.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { WebSocket } = require('ws');

let proc;
let base;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', TIME_SCALE: '0.01' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    proc.on('exit', code => reject(new Error(`server exited ${code}`)));
    proc.stdout.on('data', d => {
      const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(String(d));
      if (m) resolve(m[1]);
    });
  });
});

test.after(() => proc.kill());

/** Клієнт, що складає повідомлення в чергу й уміє чекати на потрібне. */
function client(name) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const msg = JSON.parse(d);
    const i = waiters.findIndex(w => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const c = {
    send: msg => ws.send(JSON.stringify(msg)),
    next(t, timeout = 5000) {
      const pred = typeof t === 'function' ? t : m => m.t === t;
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`${name}: не дочекались ${t}`)), timeout);
      });
    },
    close: () => ws.close(),
    ready: new Promise(r => ws.on('open', r)),
  };
  return c.ready.then(() => { c.send({ t: 'hello', name }); return c; });
}

/** Грає весь матч: відповідає першим варіантом, доки не прийде `end`. */
async function playThrough(c) {
  for (;;) {
    const msg = await c.next(m => m.t === 'options' || m.t === 'end');
    if (msg.t === 'end') return msg;
    c.send({ t: 'answer', index: msg.index, option: 0 });
  }
}

test('превʼю та питання віддаються, а чужі файли — ні', async () => {
  assert.equal((await fetch(base + '/preview/')).status, 200);
  assert.equal((await fetch(base + '/shared/engine.js')).status, 200);
  const qs = await (await fetch(base + '/KinoBattleApp/questions.json')).json();
  assert.ok(qs.length >= 28);
  assert.equal((await fetch(base + '/server/server.js')).status, 404);
  assert.equal((await fetch(base + '/preview/..%2f..%2fREADME.md')).status, 404);
  assert.equal((await fetch(base + '/.git/config')).status, 404);
});

test('гра за кодом кімнати: повний матч і реванш', async () => {
  const anna = await client('Анна');
  const bohdan = await client('Богдан');

  anna.send({ t: 'create', length: 7 });
  const room = await anna.next('room');
  assert.match(room.code, /^[A-Z2-9]{4}$/);

  bohdan.send({ t: 'join', code: room.code.toLowerCase() });
  const [sa, sb] = await Promise.all([anna.next('start'), bohdan.next('start')]);
  assert.equal(sa.total, 7);
  assert.equal(sa.opponent.name, 'Богдан');
  assert.equal(sb.opponent.name, 'Анна');
  assert.equal(sb.opponent.isBot, false);

  const [ea, eb] = await Promise.all([playThrough(anna), playThrough(bohdan)]);
  // Обидва завжди обирали однаковий варіант → однакові правильні відповіді.
  assert.equal(ea.you.correct, eb.you.correct);
  assert.equal(ea.you.score, eb.opponent.score);
  assert.equal(ea.opponent.score, eb.you.score);
  const mirrored = { win: 'loss', loss: 'win', draw: 'draw' };
  assert.equal(eb.outcome, mirrored[ea.outcome]);

  // Код одноразовий.
  const third = await client('Третій');
  third.send({ t: 'join', code: room.code });
  assert.equal((await third.next('error')).message, 'Кімнату не знайдено');
  third.close();

  // Реванш: перший просить, другий погоджується.
  anna.send({ t: 'rematch' });
  await bohdan.next('rematchRequested');
  bohdan.send({ t: 'rematch' });
  await Promise.all([anna.next('start'), bohdan.next('start')]);

  // Анна виходить посеред реваншу → Богдан перемагає технічно.
  await bohdan.next('options');
  anna.close();
  const end = await bohdan.next('end');
  assert.equal(end.outcome, 'win');
  assert.equal(end.reason, 'opponentLeft');
  bohdan.close();
});

test('випадковий суперник: зводимо двох, хто чекає матч тієї ж довжини', async () => {
  const a = await client('A');
  const b = await client('B');
  const c = await client('C');

  a.send({ t: 'quick', length: 14 });
  await a.next('queued');
  b.send({ t: 'quick', length: 7 }); // інша довжина — не зводимо
  await b.next('queued');
  c.send({ t: 'quick', length: 14 });

  const [sa, sc] = await Promise.all([a.next('start'), c.next('start')]);
  assert.equal(sa.total, 14);
  assert.equal(sa.opponent.name, 'C');
  assert.equal(sc.opponent.name, 'A');

  // B скасовує пошук.
  b.send({ t: 'cancel' });
  for (const x of [a, b, c]) x.close();
});

test('неправильні повідомлення не ламають сервер', async () => {
  const x = await client('X');
  x.send({ t: 'answer', index: 0, option: 0 });
  x.send({ t: 'join', code: 'ZZZZ' });
  assert.equal((await x.next('error')).message, 'Кімнату не знайдено');
  x.send({ t: '__proto__' });
  x.send({ t: 'constructor' });
  x.send({ t: 'create', length: 999 });
  assert.equal((await x.next('room')).length, 7);
  x.close();
});
