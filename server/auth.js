/*
 * Вхід через пошту одноразовим кодом (без паролів).
 *
 * Листи: якщо задано RESEND_API_KEY (+ MAIL_FROM) — надсилаємо через Resend (https://resend.com).
 * Інакше — режим розробки: код друкується в консоль сервера й повертається у відповіді API
 * як `devCode`, щоб превʼю могло показати його одразу.
 */
'use strict';

const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new AuthError(400, 'Перевір адресу пошти');
  return e;
}

function createMailer(env = process.env) {
  if (env.RESEND_API_KEY) {
    // Надсилання через Resend. Перевірено лише на рівні формату запиту — перед запуском протестуй зі своїм ключем.
    return {
      dev: false,
      async send(email, code) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.MAIL_FROM || 'KinoBattle <onboarding@resend.dev>',
            to: [email],
            subject: `Код входу в KinoBattle: ${code}`,
            text: `Твій код входу в KinoBattle: ${code}\n\nВін діє 10 хвилин. Якщо ти не намагався увійти — просто проігноруй цей лист.`,
          }),
        });
        if (!r.ok) throw new AuthError(502, 'Не вдалося надіслати лист, спробуй пізніше');
      },
    };
  }
  return {
    dev: true,
    async send(email, code) {
      console.log(`[auth] код для ${email}: ${code}`);
    },
  };
}

function createAuth({ store, mailer }) {
  return {
    /** Надсилає код. У режимі розробки повертає його ж, щоб превʼю показало. */
    async startEmail(rawEmail) {
      const email = normalizeEmail(rawEmail);
      const prev = store.getEmailCode(email);
      if (prev && Date.now() - prev.sent_at < RESEND_COOLDOWN_MS) {
        throw new AuthError(429, 'Код уже надіслано — зачекай пів хвилини перед повторною спробою');
      }
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      store.saveEmailCode(email, code, CODE_TTL_MS);
      await mailer.send(email, code);
      return { email, devCode: mailer.dev ? code : undefined };
    },

    /** Перевіряє код; при успіху код згорає. */
    verifyEmail(rawEmail, rawCode) {
      const email = normalizeEmail(rawEmail);
      const code = String(rawCode ?? '').trim();
      const row = store.getEmailCode(email);
      if (!row || row.expires_at < Date.now()) throw new AuthError(400, 'Код прострочено — надішли новий');
      if (row.attempts >= MAX_ATTEMPTS) throw new AuthError(429, 'Забагато спроб — надішли новий код');
      if (!/^\d{6}$/.test(code) || !store.checkEmailCode(row, code)) {
        store.bumpEmailCodeAttempts(email);
        throw new AuthError(400, 'Невірний код');
      }
      store.deleteEmailCode(email);
      return email;
    },
  };
}

module.exports = { createAuth, createMailer, normalizeEmail, AuthError };
