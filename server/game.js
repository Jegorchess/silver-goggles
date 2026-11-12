/*
 * Ігрове лобі та матчі між людьми через WebSocket (/ws).
 * Протокол — у server/README.md.
 */
'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const E = require('../shared/engine.js');
const { photoUrl } = require('./db.js');

const HUMAN_AVATARS = ['🎬', '🎭'];
const MAX_NAME = 24;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O та 1/I
const CODE_LENGTH = 4;

function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, MAX_NAME).join('') || 'Гравець';
}

function validLength(n) {
  return E.MatchRules.matchLengths.includes(n) ? n : E.MatchRules.questionsPerMatch;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.name = 'Гравець';
    this.accountId = null;
    this.photo = null;
    this.room = null;
    this.queuedFor = null;
    this.alive = true;
  }
  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  get open() {
    return this.ws.readyState === WebSocket.OPEN;
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
    this.invite = null; // { id, to: Client } — кімната-запрошення другу
  }
}

/**
 * @param server  http.Server
 * @param bank    питання
 * @param store   Store (може бути null — тоді без акаунтів і запису матчів)
 * @param timeScale множник пауз (тести)
 */
function createGame({ server, bank, store, timeScale = 1 }) {
  /** @type {Map<string, Room>} кімнати з кодом */
  const rooms = new Map();
  /** @type {Map<number, Client>} черга на випадкового суперника, за довжиною матчу */
  const queue = new Map();
  /** @type {Map<string, Room>} запрошення друзям */
  const invites = new Map();
  /** @type {Map<number, Set<Client>>} хто з акаунтів зараз онлайн */
  const online = new Map();

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function onlineClient(accountId) {
    const set = online.get(accountId);
    if (!set) return null;
    return [...set].reverse().find(c => c.open) || null;
  }

  function busy(client) {
    return client.queuedFor != null || (client.room?.match && client.room.match.state !== 'ended');
  }

  /** Актуальні імʼя й фото з акаунта (їх могли змінити в профілі). */
  function refreshName(client) {
    if (store && client.accountId) {
      const acc = store.getAccount(client.accountId);
      if (acc) {
        client.name = acc.name;
        client.photo = photoUrl(acc);
      }
    }
  }

  function startMatch(room) {
    room.rematch = new Set();
    const clients = [...room.members];
    clients.forEach(refreshName);
    const questions = E.pickQuestions(bank, room.length, room.recent);
    room.recent = E.updateRecent(room.recent, questions);
    const players = clients.map((c, seat) => ({
      name: c.name,
      avatar: HUMAN_AVATARS[seat],
      photo: c.photo,
      send: msg => c.send(msg),
    }));
    const match = new E.Match({ questions, players, timeScale });
    match.onEnd = () => recordMatch(clients, match);
    room.match = match;
    match.start();
  }

  function recordMatch(clients, match) {
    if (!store) return;
    const { reason, total, players } = match.result;
    const res = store.recordHumanMatch({
      length: total,
      reason,
      players: players.map((p, i) => ({ ...p, accountId: clients[i].accountId, name: clients[i].name })),
    });
    clients.forEach((c, i) => {
      const guest = !res.ratings[i];
      c.send(res.rated
        ? { t: 'rating', rated: true, delta: res.deltas[i], rating: res.ratings[i] }
        : { t: 'rating', rated: false, why: guest ? 'guest' : 'opponentGuest' });
    });
  }

  function cancelInvite(room) {
    if (!room.invite) return;
    invites.delete(room.invite.id);
    room.invite.to.send({ t: 'inviteCancelled', inviteId: room.invite.id });
    room.invite = null;
  }

  /** Прибирає клієнта з черги та кімнати. Якщо йде матч — суперник отримує технічну перемогу. */
  function leaveCurrent(client) {
    if (client.queuedFor != null) {
      if (queue.get(client.queuedFor) === client) queue.delete(client.queuedFor);
      client.queuedFor = null;
    }
    const room = client.room;
    if (!room) return;
    cancelInvite(room);
    const seat = room.members.indexOf(client);
    if (room.match && room.match.state !== 'ended') room.match.leave(seat);
    room.members.splice(seat, 1);
    client.room = null;
    for (const other of room.members) other.send({ t: 'opponentLeft' });
    if (room.match) {
      // Після матчу з одним гравцем кімната вже не потрібна.
      for (const other of room.members) other.room = null;
      room.members = [];
    }
    if (room.members.length === 0 && room.code) rooms.delete(room.code);
  }

  function joinRoom(client, room) {
    leaveCurrent(client);
    room.members.push(client);
    client.room = room;
    startMatch(room);
  }

  const handlers = {
    /** Привʼязка зʼєднання до акаунта (токен з HTTP API). */
    auth(client, msg) {
      const acc = store?.accountForToken(msg.token);
      if (!acc) return client.send({ t: 'authError' });
      if (client.accountId && client.accountId !== acc.id) online.get(client.accountId)?.delete(client);
      client.accountId = acc.id;
      refreshName(client);
      if (!online.has(acc.id)) online.set(acc.id, new Set());
      online.get(acc.id).add(client);
      client.send({ t: 'authed', id: acc.id });
    },

    /** Імʼя для зʼєднань без акаунта. */
    hello(client, msg) {
      if (!client.accountId) client.name = cleanName(msg.name);
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
      rooms.delete(code); // код одноразовий: після старту в кімнату вже не зайти
      room.code = null;
      joinRoom(client, room);
    },

    quick(client, msg) {
      leaveCurrent(client);
      const length = validLength(msg.length);
      const waiting = queue.get(length);
      const sameAccount = waiting && client.accountId && waiting.accountId === client.accountId;
      if (waiting && waiting !== client && waiting.open && !sameAccount) {
        queue.delete(length);
        waiting.queuedFor = null;
        const room = new Room(length);
        room.members.push(waiting, client);
        waiting.room = room;
        client.room = room;
        startMatch(room);
      } else {
        if (waiting && waiting !== client) waiting.queuedFor = null;
        queue.set(length, client);
        client.queuedFor = length;
        client.send({ t: 'queued', length });
      }
    },

    /** Запросити друга, який зараз онлайн. */
    invite(client, msg) {
      if (!store || !client.accountId) return client.send({ t: 'error', message: 'Запрошувати друзів можна лише з акаунтом' });
      const friendId = Number(msg.friendId);
      if (!store.areFriends(client.accountId, friendId)) return client.send({ t: 'error', message: 'Цього гравця немає серед друзів' });
      const target = onlineClient(friendId);
      if (!target) return client.send({ t: 'error', message: 'Друг зараз не в мережі' });
      if (busy(target)) return client.send({ t: 'error', message: 'Друг зараз у грі' });
      leaveCurrent(client);
      refreshName(client);
      const room = new Room(validLength(msg.length));
      room.members.push(client);
      client.room = room;
      const id = Math.random().toString(36).slice(2, 10);
      room.invite = { id, to: target };
      invites.set(id, room);
      client.send({ t: 'inviteSent', inviteId: id, friend: { id: friendId, name: store.getAccount(friendId)?.name } });
      target.send({ t: 'invited', inviteId: id, from: { id: client.accountId, name: client.name, photo: client.photo }, length: room.length });
    },

    inviteAccept(client, msg) {
      const room = invites.get(String(msg.inviteId));
      if (!room || room.invite.to !== client || room.members.length !== 1 || !room.members[0].open) {
        return client.send({ t: 'error', message: 'Запрошення вже неактуальне' });
      }
      invites.delete(room.invite.id);
      room.invite = null;
      joinRoom(client, room);
    },

    inviteDecline(client, msg) {
      const room = invites.get(String(msg.inviteId));
      if (!room || room.invite.to !== client) return;
      invites.delete(room.invite.id);
      room.invite = null;
      const inviter = room.members[0];
      inviter?.send({ t: 'inviteDeclined', name: client.name });
      if (inviter) inviter.room = null;
      room.members = [];
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
    ws.kbClient = client;
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
    ws.on('close', () => {
      leaveCurrent(client);
      // Якщо цей клієнт мав запрошення від друга — інвайтер дізнається, що його відхилено.
      for (const room of invites.values()) {
        if (room.invite.to === client) handlers.inviteDecline(client, { inviteId: room.invite.id });
      }
      if (client.accountId) {
        const set = online.get(client.accountId);
        set?.delete(client);
        if (set && set.size === 0) online.delete(client.accountId);
      }
    });
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

  return {
    wss,
    isOnline: accountId => !!onlineClient(accountId),
    /** Змінили імʼя чи фото в профілі — оновлюємо відкриті зʼєднання. */
    profileChanged(accountId) {
      for (const c of online.get(accountId) || []) refreshName(c);
    },
    /** Видалення акаунта — відключаємо його зʼєднання. */
    dropAccount(accountId) {
      for (const c of online.get(accountId) || []) c.ws.close();
    },
  };
}

module.exports = { createGame, cleanName };
