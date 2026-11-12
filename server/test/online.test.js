'use strict';
// Наскрізний тест гри: справжній сервер + WebSocket-клієнти без акаунтів.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wsClient, playThrough } = require('./helpers.js');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

test('превʼю та питання віддаються, а чужі файли — ні', async () => {
  const { base } = srv;
  assert.equal((await fetch(base + '/preview/')).status, 200);
  assert.equal((await fetch(base + '/preview/duo.html')).status, 200);
  assert.equal((await fetch(base + '/shared/engine.js')).status, 200);
  const qs = await (await fetch(base + '/KinoBattleApp/questions.json')).json();
  assert.ok(qs.length >= 28);
  assert.equal((await fetch(base + '/server/server.js')).status, 404);
  assert.equal((await fetch(base + '/server/data/kinobattle.db')).status, 404);
  assert.equal((await fetch(base + '/preview/..%2f..%2fREADME.md')).status, 404);
  assert.equal((await fetch(base + '/.git/config')).status, 404);
});

test('гра за кодом кімнати: повний матч і реванш', async () => {
  const anna = await wsClient(srv.base, { name: 'Анна' });
  const bohdan = await wsClient(srv.base, { name: 'Богдан' });

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
  assert.equal(ea.you.correct, eb.you.correct);
  assert.equal(ea.you.score, eb.opponent.score);
  const mirrored = { win: 'loss', loss: 'win', draw: 'draw' };
  assert.equal(eb.outcome, mirrored[ea.outcome]);
  // Без акаунтів матч не рейтинговий.
  assert.equal((await anna.next('rating')).rated, false);

  // Код одноразовий.
  const third = await wsClient(srv.base, { name: 'Третій' });
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
  const a = await wsClient(srv.base, { name: 'A' });
  const b = await wsClient(srv.base, { name: 'B' });
  const c = await wsClient(srv.base, { name: 'C' });

  a.send({ t: 'quick', length: 14 });
  await a.next('queued');
  b.send({ t: 'quick', length: 7 }); // інша довжина — не зводимо
  await b.next('queued');
  c.send({ t: 'quick', length: 14 });

  const [sa, sc] = await Promise.all([a.next('start'), c.next('start')]);
  assert.equal(sa.total, 14);
  assert.equal(sa.opponent.name, 'C');
  assert.equal(sc.opponent.name, 'A');

  b.send({ t: 'cancel' });
  for (const x of [a, b, c]) x.close();
});

test('неправильні повідомлення не ламають сервер', async () => {
  const x = await wsClient(srv.base, { name: 'X' });
  x.send({ t: 'answer', index: 0, option: 0 });
  x.send({ t: 'join', code: 'ZZZZ' });
  assert.equal((await x.next('error')).message, 'Кімнату не знайдено');
  x.send({ t: '__proto__' });
  x.send({ t: 'constructor' });
  x.send({ t: 'auth', token: 'nonsense' });
  assert.equal((await x.next('authError')).t, 'authError');
  x.send({ t: 'invite', friendId: 1 });
  assert.match((await x.next('error')).message, /з акаунтом/);
  x.send({ t: 'create', length: 999 });
  assert.equal((await x.next('room')).length, 7);
  x.close();
});
