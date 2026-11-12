'use strict';
// Акаунти, статистика, рейтинг, друзі й запрошення — наскрізно через HTTP API і WebSocket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wsClient, playThrough, apiClient } = require('./helpers.js');
const { eloDelta } = require('../db.js');
const { nameFromEmail } = require('../api.js');

test('імʼя з пошти', () => {
  assert.equal(nameFromEmail('shakhmatenko.egor@gmail.com'), 'Shakhmatenko Egor');
  assert.equal(nameFromEmail('ivan_petrenko+kino@ukr.net'), 'Ivan Petrenko');
  assert.equal(nameFromEmail('olena-k.1999@example.com'), 'Olena K');
  assert.equal(nameFromEmail('12345@example.com'), '12345');
  assert.equal([...nameFromEmail('averyveryverylongfirstname.averyverylonglastname@x.io')].length, 24);
});

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

test('Elo: рівні гравці ±16, перемога над сильнішим дає більше', () => {
  assert.equal(eloDelta(1000, 1000, 'win'), 16);
  assert.equal(eloDelta(1000, 1000, 'loss'), -16);
  assert.equal(eloDelta(1000, 1000, 'draw'), 0);
  assert.ok(eloDelta(1000, 1200, 'win') > 16);
  assert.ok(eloDelta(1200, 1000, 'win') < 16);
});

test('гість: створення, профіль, перейменування, гра з ботом у статистиці', async () => {
  const a = apiClient(srv.base);
  const me = await a.guest('  Олена   К  ');
  assert.equal(me.name, 'Олена К');
  assert.equal(me.guest, true);
  assert.equal(me.rating, null);
  assert.equal(me.friendCode, null);

  assert.equal((await a.call('PATCH', '/me', { name: 'Олена' })).name, 'Олена');

  const bot = { length: 7, outcome: 'win', you: { score: 5200, correct: 6 }, opponent: { score: 3100, correct: 4 } };
  assert.equal((await a.call('POST', '/matches/bot', bot)).ok, true);
  assert.equal((await a.call('POST', '/matches/bot', { ...bot, you: { score: 99999, correct: 6 } })).status, 400);
  const prof = await a.call('GET', '/me');
  assert.equal(prof.stats.bot.played, 1);
  assert.equal(prof.stats.bot.wins, 1);
  assert.equal(prof.stats.accuracy, 86); // 6 з 7
  const hist = await a.call('GET', '/me/history');
  assert.equal(hist.matches[0].opp_name, 'Кіноман');

  // Гостям друзі недоступні, а таблицю лідерів бачать.
  assert.equal((await a.call('GET', '/friends')).status, 403);
  const lb = await a.call('GET', '/leaderboard');
  assert.equal(lb.me.guest, true);
  assert.equal(lb.me.rank, null);

  // Без токена — 401.
  assert.equal((await apiClient(srv.base).call('GET', '/me')).status, 401);
});

test('реєстрація зберігає прогрес гостя; повторний вхід зливає нового гостя в акаунт', async () => {
  const a = apiClient(srv.base);
  const guest = await a.guest('Марко');
  await a.call('POST', '/matches/bot', { length: 7, outcome: 'loss', you: { score: 1000, correct: 1 }, opponent: { score: 4000, correct: 5 } });

  const reg = await a.register('Marko@Example.com ');
  assert.equal(reg.me.id, guest.id, 'той самий акаунт');
  assert.equal(reg.me.guest, false);
  assert.equal(reg.me.email, 'marko@example.com');
  assert.match(reg.me.friendCode, /^[A-Z2-9]{6}$/);
  assert.equal(reg.me.rating, 1000);
  assert.equal(reg.me.stats.bot.played, 1);

  // Інший пристрій: новий гість зіграв і входить тією ж поштою → матчі переїжджають в акаунт.
  const b = apiClient(srv.base);
  await b.guest('Тимчасовий');
  await b.call('POST', '/matches/bot', { length: 14, outcome: 'win', you: { score: 9000, correct: 10 }, opponent: { score: 7000, correct: 8 } });
  const login = await b.register('marko@example.com');
  assert.equal(login.me.id, guest.id);
  assert.equal(login.merged, true);
  assert.equal(login.me.stats.bot.played, 2);
  assert.equal(login.me.name, 'Марко');

  // Старий токен першого пристрою досі дійсний; вихід робить токен недійсним.
  assert.equal((await a.call('GET', '/me')).id, guest.id);
  await b.call('POST', '/auth/logout');
  assert.equal((await b.call('GET', '/me')).status, 401);
});

test('коди входу: неправильний код, ліміт спроб, повторне надсилання', async () => {
  const a = apiClient(srv.base);
  assert.equal((await a.call('POST', '/auth/email/start', { email: 'not-an-email' })).status, 400);
  const s = await a.call('POST', '/auth/email/start', { email: 'x@example.com' });
  assert.match(s.devCode, /^\d{6}$/);
  assert.equal((await a.call('POST', '/auth/email/start', { email: 'x@example.com' })).status, 429);
  const wrong = s.devCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    assert.equal((await a.call('POST', '/auth/email/verify', { email: 'x@example.com', code: wrong })).error, 'Невірний код');
  }
  // Після 5 помилок навіть правильний код не приймається.
  assert.equal((await a.call('POST', '/auth/email/verify', { email: 'x@example.com', code: s.devCode })).status, 429);
});

/** Два зареєстровані гравці, що є друзями. */
async function twoFriends(nameA, nameB) {
  const a = apiClient(srv.base);
  const b = apiClient(srv.base);
  await a.guest(nameA);
  await b.guest(nameB);
  const ra = await a.register(`${nameA.toLowerCase()}@test.dev`);
  const rb = await b.register(`${nameB.toLowerCase()}@test.dev`);
  return { a, b, ra, rb };
}

test('друзі: запит за кодом, прийняття, список, видалення', async () => {
  const { a, b, ra, rb } = await twoFriends('Ira', 'Petro');
  assert.equal((await a.call('POST', '/friends', { code: 'NOPE00' })).status, 400);
  assert.equal((await a.call('POST', '/friends', { code: ra.me.friendCode })).error, 'Це твій власний код');

  assert.equal((await a.call('POST', '/friends', { code: rb.me.friendCode.toLowerCase() })).status, 'pending');
  assert.equal((await a.call('POST', '/friends', { code: rb.me.friendCode })).error, 'Запит уже надіслано');
  const fb = await b.call('GET', '/friends');
  assert.deepEqual(fb.incoming.map(p => p.name), ['Ira']);
  assert.equal((await a.call('GET', '/friends')).outgoing.length, 1);

  assert.equal((await b.call('POST', `/friends/${ra.me.id}/accept`)).ok, true);
  const fa = await a.call('GET', '/friends');
  assert.deepEqual(fa.friends.map(p => p.name), ['Petro']);
  assert.equal(fa.friends[0].online, false);

  // Онлайн-статус — коли є WebSocket із токеном.
  const wsB = await wsClient(srv.base, { token: b.token });
  assert.equal((await a.call('GET', '/friends')).friends[0].online, true);
  wsB.close();

  await a.call('DELETE', `/friends/${rb.me.id}`);
  assert.equal((await b.call('GET', '/friends')).friends.length, 0);
});

test('запрошення друга → рейтинговий матч → рейтинг, історія, таблиця лідерів', async () => {
  const { a, b, ra, rb } = await twoFriends('Sofia', 'Taras');
  await a.call('POST', '/friends', { code: rb.me.friendCode });
  await b.call('POST', '/friends', { code: ra.me.friendCode }); // зустрічний запит = одразу друзі

  const wa = await wsClient(srv.base, { token: a.token });
  const wb = await wsClient(srv.base, { token: b.token });

  // Відхилене запрошення.
  wa.send({ t: 'invite', friendId: rb.me.id, length: 7 });
  assert.equal((await wa.next('inviteSent')).friend.name, 'Taras');
  const inv1 = await wb.next('invited');
  assert.equal(inv1.from.name, 'Sofia');
  wb.send({ t: 'inviteDecline', inviteId: inv1.inviteId });
  assert.equal((await wa.next('inviteDeclined')).name, 'Taras');

  // Скасоване запрошення.
  wa.send({ t: 'invite', friendId: rb.me.id, length: 7 });
  const inv2 = await wb.next('invited');
  wa.send({ t: 'cancel' });
  assert.equal((await wb.next('inviteCancelled')).inviteId, inv2.inviteId);
  wb.send({ t: 'inviteAccept', inviteId: inv2.inviteId });
  assert.equal((await wb.next('error')).message, 'Запрошення вже неактуальне');

  // Прийняте запрошення → матч. Софія відповідає правильно, Тарас — ні.
  wa.send({ t: 'invite', friendId: rb.me.id, length: 7 });
  const inv3 = await wb.next('invited');
  wb.send({ t: 'inviteAccept', inviteId: inv3.inviteId });
  const [sa] = await Promise.all([wa.next('start'), wb.next('start')]);
  assert.equal(sa.opponent.name, 'Taras');
  const [, eb] = await Promise.all([
    playThrough(wa, () => null), // Софія не відповідає…
    playThrough(wb, () => 0),    // …Тарас відповідає першим варіантом
  ]);
  const ratingA = await wa.next('rating');
  const ratingB = await wb.next('rating');
  assert.equal(ratingA.rated, true);
  assert.equal(ratingA.delta, -ratingB.delta);
  assert.equal(ratingA.rating + ratingB.rating, 2000);
  if (eb.outcome === 'win') assert.equal(ratingB.delta, 16);

  const histA = await a.call('GET', '/me/history');
  assert.equal(histA.matches[0].opp_name, 'Taras');
  assert.equal(histA.matches[0].rated, 1);
  assert.equal(histA.matches[0].delta, ratingA.delta);
  assert.equal((await b.call('GET', '/me')).stats.human.played, 1);

  const lb = await a.call('GET', '/leaderboard');
  const names = lb.top.map(r => r.name);
  assert.ok(names.includes('Sofia') && names.includes('Taras'));
  assert.ok(lb.me.rank >= 1);

  // Друг не в мережі.
  wb.close();
  await new Promise(r => setTimeout(r, 100));
  wa.send({ t: 'invite', friendId: rb.me.id, length: 7 });
  assert.equal((await wa.next('error')).message, 'Друг зараз не в мережі');
  wa.close();
});

test('матч гостя з зареєстрованим не рейтинговий', async () => {
  const g = apiClient(srv.base);
  await g.guest('Гість');
  const r = apiClient(srv.base);
  await r.guest('Reg');
  await r.register('reg@test.dev');
  const wg = await wsClient(srv.base, { token: g.token });
  const wr = await wsClient(srv.base, { token: r.token });
  wg.send({ t: 'create', length: 7 });
  const { code } = await wg.next('room');
  wr.send({ t: 'join', code });
  await Promise.all([playThrough(wg), playThrough(wr)]);
  assert.deepEqual(await wg.next('rating'), { t: 'rating', rated: false, why: 'guest' });
  assert.deepEqual(await wr.next('rating'), { t: 'rating', rated: false, why: 'opponentGuest' });
  assert.equal((await r.call('GET', '/me')).rating, 1000);
  assert.equal((await g.call('GET', '/me')).stats.human.played, 1);
  wg.close();
  wr.close();
});

test('видалення акаунта', async () => {
  const a = apiClient(srv.base);
  await a.guest('Del');
  await a.register('del@test.dev');
  assert.equal((await a.call('DELETE', '/me')).deleted, true);
  assert.equal((await a.call('GET', '/me')).status, 401);
  // Пошту можна використати знову — це вже новий акаунт.
  const again = await apiClient(srv.base).register('del@test.dev');
  assert.equal(again.me.stats.bot.played, 0);
  assert.equal(again.me.name, 'Del'); // вхід без гостя — імʼя з пошти
});
