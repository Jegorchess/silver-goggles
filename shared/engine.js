/*
 * KinoBattle — спільний JS-рушій для веб-превʼю та онлайн-сервера.
 *
 * Правила — порт KinoBattleApp/Engine/*.swift. Якщо змінюєш правила у Swift, онови й тут
 * (тести в server/test/engine.test.js звіряють ключові значення зі Swift-тестами).
 *
 * `Match` — повний перебіг матчу для двох гравців. Гравець — це обʼєкт
 * { name, avatar, send(msg), isBot?, onOptions?(round, match, seat) }.
 * Матч надсилає гравцям повідомлення (див. протокол у server/README.md), а дії гравців
 * приходять через match.answer(...) / match.skip(...) / match.leave(...).
 * Той самий клас працює і локально (гра з ботом у браузері), і на сервері (гра з людиною).
 *
 * Працює і як <script> у браузері (window.KinoEngine), і як CommonJS-модуль у Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KinoEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const now = () => performance.now();

  // ===== Порт Engine/Scoring.swift =====
  const MatchRules = {
    questionsPerMatch: 7,
    matchLengths: [7, 14],
    questionTime: 10,
    promptLeadIn: 1,
    finalBannerDuration: 1.5,
    revealMinDuration: 3,
    revealMaxDuration: 5,
    factReadingSpeed: 60,
    /** Пауза після питання: 3 с без факту, довший факт — довша пауза, але не більше 5 с. */
    revealDuration(question) {
      // [...s].length рахує символи як Swift String.count (сурогатні пари — по одному).
      const extra = question.fact ? [...question.fact].length / this.factReadingSpeed : 0;
      return Math.min(this.revealMinDuration + extra, this.revealMaxDuration);
    },
  };

  const Scoring = {
    basePoints: 500,
    speedPoints: 500,
    multiplier(questionIndex, totalQuestions = MatchRules.questionsPerMatch) {
      return questionIndex === totalQuestions - 1 ? 2 : 1;
    },
    /** round(500 + 500·t/10) × k; t — залишок таймера, відкинутий до 0,1 с. */
    points(isCorrect, timeLeft, multiplier) {
      if (!isCorrect || timeLeft == null || timeLeft <= 0) return 0;
      const clamped = Math.min(timeLeft, MatchRules.questionTime);
      const tenths = Math.floor(clamped * 10) / 10;
      return Math.round(this.basePoints + this.speedPoints * tenths / MatchRules.questionTime) * multiplier;
    },
  };

  /** Більше очок перемагає; при рівному рахунку — більше правильних; інакше нічия. */
  function decideOutcome(playerScore, opponentScore, playerCorrect, opponentCorrect) {
    if (playerScore !== opponentScore) return playerScore > opponentScore ? 'win' : 'loss';
    if (playerCorrect !== opponentCorrect) return playerCorrect > opponentCorrect ? 'win' : 'loss';
    return 'draw';
  }

  // ===== Порт Engine/Question.swift + QuestionBank.swift =====
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Питання в конкретному матчі: варіанти перемішані, індекс правильного перераховано. */
  function makeRound(question) {
    const order = shuffled(question.options.map((_, i) => i));
    return {
      question,
      options: order.map(i => question.options[i]),
      correctIndex: order.indexOf(question.correctIndex),
    };
  }

  /**
   * Обирає `count` питань: спершу ті, яких немає в `recent`, у випадковому порядку;
   * якщо бракує — добирає з `recent`, починаючи з найдавніших.
   */
  function pickQuestions(all, count, recent = []) {
    const recentSet = new Set(recent);
    let result = shuffled(all.filter(q => !recentSet.has(q.id)));
    if (result.length >= count) return byDifficulty(result.slice(0, count));
    const byId = new Map(all.map(q => [q.id, q]));
    const added = new Set(result.map(q => q.id));
    for (const id of recent) {
      if (result.length >= count) break;
      if (byId.has(id) && !added.has(id)) {
        added.add(id);
        result.push(byId.get(id));
      }
    }
    return byDifficulty(result);
  }

  /** Від легших до важчих (стабільно; без складності — середнє), щоб матч розгонився до фіналу. */
  function byDifficulty(questions) {
    return questions.map((q, i) => [q.difficulty ?? 2, i, q]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
  }

  /** Оновлює список нещодавніх питань: прибирає повтори, тримає останні `keep`. */
  function updateRecent(recent, picked, keep = Math.max(...MatchRules.matchLengths) * 2) {
    const ids = new Set(picked.map(q => q.id));
    return [...recent.filter(id => !ids.has(id)), ...picked.map(q => q.id)].slice(-keep);
  }

  // ===== Порт Engine/Opponent.swift =====
  const BotConfig = { name: 'Кіноман', avatar: '🍿', accuracy: 0.7, answerTime: [3, 7] };

  function botPlan(round, config = BotConfig) {
    const [lo, hi] = config.answerTime;
    const delay = lo + Math.random() * (hi - lo);
    const isCorrect = Math.random() < config.accuracy;
    const wrong = round.options.map((_, i) => i).filter(i => i !== round.correctIndex);
    const optionIndex = isCorrect ? round.correctIndex : wrong[Math.floor(Math.random() * wrong.length)];
    return { optionIndex, delay };
  }

  /** Бот як гравець матчу: відповідає сам, повідомлень не читає. */
  function makeBot(config = BotConfig) {
    return {
      name: config.name,
      avatar: config.avatar,
      isBot: true,
      send() {},
      onOptions(round, match, seat) {
        const plan = botPlan(round, config);
        if (plan.delay >= MatchRules.questionTime) return;
        const index = match.index;
        match.later(() => match.answer(seat, index, plan.optionIndex), plan.delay);
      },
    };
  }

  // ===== Перебіг матчу =====
  class Match {
    /**
     * @param questions  питання матчу (вже обрані).
     * @param players    рівно два гравці.
     * @param timeScale  множник усіх пауз (для тестів: 0.01 → матч у 100 разів швидший).
     */
    constructor({ questions, players, timeScale = 1 }) {
      if (players.length !== 2) throw new Error('Match потребує рівно двох гравців');
      this.questions = questions;
      this.players = players.map(p => Object.assign(p, { score: 0, correct: 0, left: false }));
      this.timeScale = timeScale;
      this.timers = new Set();
      this.state = 'idle'; // idle → prompt → answering → reveal → … → ended
      this.index = -1;
      this.onEnd = null;
    }

    /** setTimeout у секундах гри; всі таймери скасовуються разом із матчем. */
    later(fn, seconds) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (this.state !== 'ended') fn();
      }, seconds * 1000 * this.timeScale);
      this.timers.add(t);
      return t;
    }

    cancel(t) {
      clearTimeout(t);
      this.timers.delete(t);
    }

    sendTo(seat, msg) {
      const p = this.players[seat];
      if (!p.left) p.send(msg);
    }

    broadcast(msg) {
      this.players.forEach((_, seat) => this.sendTo(seat, msg));
    }

    publicInfo(p) {
      return { name: p.name, avatar: p.avatar, photo: p.photo || null, isBot: !!p.isBot };
    }

    start() {
      this.players.forEach((p, seat) => this.sendTo(seat, {
        t: 'start',
        total: this.questions.length,
        you: this.publicInfo(p),
        opponent: this.publicInfo(this.players[1 - seat]),
      }));
      this.nextQuestion(0);
    }

    nextQuestion(i) {
      if (i >= this.questions.length) return this.finish();
      this.index = i;
      this.state = 'prompt';
      this.round = makeRound(this.questions[i]);
      this.multiplier = Scoring.multiplier(i, this.questions.length);
      this.answers = [null, null];
      this.skips = [false, false];
      this.broadcast({
        t: 'question',
        index: i,
        total: this.questions.length,
        multiplier: this.multiplier,
        type: this.round.question.type,
        prompt: this.round.question.prompt,
        image: this.round.question.image || null,
        cast: this.round.question.cast || null,
      });
      const banner = this.multiplier > 1 ? MatchRules.finalBannerDuration : 0;
      this.later(() => this.openAnswers(), banner + MatchRules.promptLeadIn);
    }

    openAnswers() {
      this.state = 'answering';
      this.openedAt = now();
      this.broadcast({ t: 'options', index: this.index, options: this.round.options, time: MatchRules.questionTime });
      this.answerTimer = this.later(() => this.reveal(), MatchRules.questionTime);
      this.players.forEach((p, seat) => { if (p.onOptions && !p.left) p.onOptions(this.round, this, seat); });
    }

    /** Відповідь гравця. Час рахується тут, у матчі, а не на клієнті. */
    answer(seat, index, option) {
      if (this.state !== 'answering' || index !== this.index || this.answers[seat]) return;
      if (!Number.isInteger(option) || option < 0 || option >= this.round.options.length) return;
      const timeLeft = MatchRules.questionTime - (now() - this.openedAt) / 1000 / this.timeScale;
      if (timeLeft <= 0) return;
      this.answers[seat] = { option, timeLeft };
      this.sendTo(seat, { t: 'answerAccepted', index, option });
      this.sendTo(1 - seat, { t: 'opponentAnswered', index });
      if (this.players.every((p, s) => this.answers[s] || p.left)) this.reveal();
    }

    reveal() {
      if (this.state !== 'answering') return;
      this.cancel(this.answerTimer);
      this.state = 'reveal';
      const correctIndex = this.round.correctIndex;
      const results = this.answers.map((a, seat) => {
        const ok = !!a && a.option === correctIndex;
        const points = Scoring.points(ok, a ? a.timeLeft : null, this.multiplier);
        const p = this.players[seat];
        p.score += points;
        if (ok) p.correct += 1;
        return { option: a ? a.option : null, points, score: p.score };
      });
      const duration = MatchRules.revealDuration(this.round.question);
      this.players.forEach((_, seat) => this.sendTo(seat, {
        t: 'reveal',
        index: this.index,
        correctIndex,
        fact: this.round.question.fact || null,
        duration,
        you: results[seat],
        opponent: results[1 - seat],
      }));
      this.revealTimer = this.later(() => this.advance(), duration);
    }

    /** Гравець натиснув «далі» на картці факту. Переходимо, коли готові всі живі гравці. */
    skip(seat, index) {
      if (this.state !== 'reveal' || index !== this.index) return;
      this.skips[seat] = true;
      if (this.players.every((p, s) => this.skips[s] || p.isBot || p.left)) this.advance();
      else this.sendTo(1 - seat, { t: 'opponentReady', index });
    }

    advance() {
      if (this.state !== 'reveal') return;
      this.cancel(this.revealTimer);
      this.nextQuestion(this.index + 1);
    }

    finish(reason = null) {
      if (this.state === 'ended') return;
      this.state = 'ended';
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      const outcomes = this.players.map((p, seat) => {
        const o = this.players[1 - seat];
        return reason === 'opponentLeft'
          ? (p.left ? 'loss' : 'win')
          : decideOutcome(p.score, o.score, p.correct, o.correct);
      });
      /** Підсумок для запису в історію (сервер читає його в onEnd). */
      this.result = {
        reason,
        total: this.questions.length,
        players: this.players.map((p, seat) => ({ score: p.score, correct: p.correct, outcome: outcomes[seat] })),
      };
      this.players.forEach((p, seat) => {
        const o = this.players[1 - seat];
        const outcome = outcomes[seat];
        this.sendTo(seat, {
          t: 'end',
          outcome,
          reason,
          total: this.questions.length,
          you: { score: p.score, correct: p.correct },
          opponent: { score: o.score, correct: o.correct },
        });
      });
      if (this.onEnd) this.onEnd();
    }

    /** Гравець вийшов посеред матчу: суперник отримує технічну перемогу. */
    leave(seat) {
      if (this.state === 'ended') return;
      this.players[seat].left = true;
      this.finish('opponentLeft');
    }

    /** Тихо зупинити матч (наприклад, гравець пішов на головний екран у грі з ботом). */
    abort() {
      this.state = 'ended';
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
    }
  }

  return {
    MatchRules, Scoring, decideOutcome,
    shuffled, makeRound, pickQuestions, byDifficulty, updateRecent,
    BotConfig, botPlan, makeBot,
    Match,
  };
});
