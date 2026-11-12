'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../shared/engine.js');

const q = (id, extra = {}) => ({ id, type: 'text', prompt: '?', options: ['A', 'B', 'C', 'D'], correctIndex: 0, ...extra });

// Ті самі значення, що в Tests/KinoBattleEngineTests/ScoringTests.swift — JS-порт має збігатися зі Swift.
test('очки збігаються зі Swift-рушієм', () => {
  assert.equal(E.Scoring.points(true, 10, 1), 1000);
  assert.equal(E.Scoring.points(true, 9.95, 1), 995);
  assert.equal(E.Scoring.points(true, 0.01, 1), 500);
  assert.equal(E.Scoring.points(true, 12, 1), 1000);
  assert.equal(E.Scoring.points(false, 5, 1), 0);
  assert.equal(E.Scoring.points(true, null, 1), 0);
  assert.equal(E.Scoring.points(true, 0, 2), 0);
  assert.equal(E.Scoring.points(true, 5, 2), 1500);
  assert.equal(E.Scoring.multiplier(6), 2);
  assert.equal(E.Scoring.multiplier(6, 14), 1);
  assert.equal(E.Scoring.multiplier(13, 14), 2);
});

test('переможець', () => {
  assert.equal(E.decideOutcome(3000, 2000, 3, 4), 'win');
  assert.equal(E.decideOutcome(2000, 2000, 4, 3), 'win');
  assert.equal(E.decideOutcome(2000, 2000, 3, 4), 'loss');
  assert.equal(E.decideOutcome(2000, 2000, 3, 3), 'draw');
});

test('пауза після питання 3–5 с', () => {
  assert.equal(E.MatchRules.revealDuration(q('a')), 3);
  assert.equal(E.MatchRules.revealDuration(q('a', { fact: 'x'.repeat(60) })), 4);
  assert.equal(E.MatchRules.revealDuration(q('a', { fact: 'x'.repeat(160) })), 5);
});

test('вибір питань уникає нещодавніх і добирає з найдавніших', () => {
  const bank = Array.from({ length: 8 }, (_, i) => q(`q${i + 1}`));
  const picked = E.pickQuestions(bank, 7, ['q1', 'q2', 'q3']).map(x => x.id);
  assert.equal(picked.length, 7);
  assert.deepEqual(picked.slice(-2), ['q1', 'q2']);
  assert.ok(!picked.includes('q3'));
});

test('перемішування зберігає правильну відповідь', () => {
  for (let i = 0; i < 50; i++) {
    const r = E.makeRound(q('a', { correctIndex: 2 }));
    assert.equal(r.options[r.correctIndex], 'C');
  }
});

/** Гравець, що записує повідомлення й відповідає за сценарієм. */
function scripted(name, choose) {
  const log = [];
  return {
    name, avatar: '🎬', log,
    send(msg) {
      log.push(msg);
      if (msg.t === 'options' && choose) {
        const option = choose(msg);
        if (option != null) setTimeout(() => this.match.answer(this.seat, msg.index, option), 0);
      }
    },
  };
}

function runMatch(players, questions, timeScale = 0.002) {
  return new Promise(resolve => {
    const match = new E.Match({ questions, players, timeScale });
    players.forEach((p, seat) => Object.assign(p, { match, seat }));
    match.onEnd = () => resolve(match);
    match.start();
  });
}

test('повний матч: правильний гравець перемагає, фінальне питання ×2', async () => {
  const questions = Array.from({ length: 7 }, (_, i) => q(`q${i}`, { fact: 'Факт' }));
  // Обидва відповідають одразу; перший — правильно, другий — завжди «A» (правильно лише випадково).
  let correctFor = {};
  const good = scripted('Добрий', msg => correctFor[msg.index]);
  const bad = scripted('Слабкий', () => null); // не відповідає зовсім
  const origSend = good.send;
  good.send = function (msg) {
    if (msg.t === 'options') {
      // Правильний індекс знає лише матч — підглянемо, щоб «добрий» гравець не помилявся.
      correctFor[msg.index] = this.match.round.correctIndex;
    }
    return origSend.call(this, msg);
  };
  const match = await runMatch([good, bad], questions);
  const end = good.log.at(-1);
  assert.equal(end.t, 'end');
  assert.equal(end.outcome, 'win');
  assert.equal(end.you.correct, 7);
  assert.equal(end.opponent.score, 0);
  // 6 питань × ≥500 + фінальне × 2 ≥ 1000
  assert.ok(end.you.score >= 6 * 500 + 1000, `score ${end.you.score}`);
  const finalReveal = good.log.filter(m => m.t === 'reveal').at(-1);
  assert.ok(finalReveal.you.points >= 1000 && finalReveal.you.points % 2 === 0);
  assert.equal(bad.log.at(-1).outcome, 'loss');
  assert.equal(match.state, 'ended');
});

test('суперник бачить, що інший відповів, але не бачить його вибору до розкриття', async () => {
  const questions = [q('a')];
  const a = scripted('A', () => 1);
  const b = scripted('B', () => null);
  await runMatch([a, b], questions);
  const notice = b.log.find(m => m.t === 'opponentAnswered');
  assert.ok(notice);
  assert.equal(notice.option, undefined);
  const reveal = b.log.find(m => m.t === 'reveal');
  assert.equal(reveal.opponent.option, 1);
  assert.equal(reveal.you.option, null);
});

test('вихід гравця посеред матчу — технічна перемога суперника', () => {
  const a = scripted('A');
  const b = scripted('B');
  const match = new E.Match({ questions: [q('a'), q('b')], players: [a, b], timeScale: 0.002 });
  match.start();
  match.leave(1);
  const end = a.log.at(-1);
  assert.equal(end.t, 'end');
  assert.equal(end.outcome, 'win');
  assert.equal(end.reason, 'opponentLeft');
  assert.equal(match.state, 'ended');
});

test('бот відповідає сам', async () => {
  const human = scripted('Я', () => null);
  const bot = E.makeBot({ ...E.BotConfig, accuracy: 1, answerTime: [1, 1] });
  await runMatch([human, bot], [q('a'), q('b')]);
  const end = human.log.at(-1);
  assert.equal(end.opponent.correct, 2);
  assert.ok(human.log.some(m => m.t === 'opponentAnswered'));
});
