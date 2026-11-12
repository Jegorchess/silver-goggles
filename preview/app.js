/*
 * KinoBattle — логіка веб-превʼю (макет iOS-застосунку).
 *
 * - Акаунт: гість (лише імʼя) або зареєстрований (пошта + код). Токен — у localStorage цього «телефона».
 * - Гра з ботом іде локально через shared/engine.js (той самий Match, що на сервері); результат
 *   надсилається в статистику через API.
 * - Гра з людиною та запрошення друзів — через WebSocket /ws; сервер веде матч і рахує рейтинг.
 */
'use strict';

const { MatchRules, Match, makeBot, pickQuestions, updateRecent } = window.KinoEngine;
const $ = id => document.getElementById(id);

/** Іконка зі спрайту в index.html. */
const icon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;

/** Аватар: фото, або емодзі (місце в матчі), або перша літера імені на градієнті. */
function setAvatar(el, { photo, name, emoji } = {}) {
  el.textContent = '';
  el.classList.remove('initial');
  if (photo) {
    const img = new Image();
    img.alt = '';
    img.onerror = () => setAvatar(el, { name, emoji });
    img.src = photo;
    el.appendChild(img);
  } else if (emoji) {
    el.textContent = emoji;
  } else {
    el.classList.add('initial');
    el.textContent = ([...String(name || '?').trim()][0] || '?').toUpperCase();
  }
}

// ===== Локальне збереження (лише зручності конкретного браузера) =====
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
// ?slot=1 / ?slot=2 — окремий «телефон» на сторінці duo.html: свій акаунт та історія питань.
const SLOT = (new URLSearchParams(location.search).get('slot') || '').replace(/[^\w-]/g, '');
const slotKey = k => (SLOT ? `${k}.slot${SLOT}` : k);
const RECENT_KEY = slotKey('kinobattle.recent');
const LENGTH_KEY = slotKey('kinobattle.matchLength');
const TOKEN_KEY = slotKey('kinobattle.token');

// ===== Стан =====
let bank = [];
let matchLength = MatchRules.matchLengths.includes(store.get(LENGTH_KEY)) ? store.get(LENGTH_KEY) : MatchRules.questionsPerMatch;
let token = store.get(TOKEN_KEY, null);
/** Профіль із /api/me. */
let me = null;
/** Поточна гра: { kind: 'bot' | 'online', send(msg), close() }. */
let session = null;
let ws = null;
let wsOpen = null;
let reconnectTimer = 0;
let pendingInvite = null;
/** Куди повернутись після входу / з екрана «Назад». */
let backTo = 'home';
let friendsPoll = 0;
/** Таймери екрана матчу — скасовуються при переході між питаннями. */
const ui = { timers: [], raf: 0, total: 7, opponentIsBot: true, answered: false, lobbyTimer: 0 };

const SCREENS = ['welcome', 'home', 'auth', 'profile', 'leaders', 'friends', 'credits', 'lobby', 'match', 'result'];
/** Картинки питань лежать поруч із questions.json у KinoBattleApp/media. */
const mediaUrl = file => `../KinoBattleApp/${file}`;
function show(screen) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== screen);
  if (screen !== 'friends') clearInterval(friendsPoll);
}
const visible = id => !$(id).classList.contains('hidden');

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function setToken(t) {
  token = t;
  store.set(TOKEN_KEY, t);
}

// ===== HTTP API =====
async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Помилка сервера'), { status: r.status });
  return data;
}

async function refreshMe() {
  me = await api('GET', '/me');
  renderChip();
  return me;
}

// ===== Головний =====
function renderChip() {
  if (!me) return;
  setAvatar($('chip-ava'), { photo: me.photo, name: me.name });
  $('chip-name').textContent = me.name;
  const b = $('chip-badge');
  b.textContent = me.guest ? 'Гість' : `★ ${me.rating}`;
  b.classList.toggle('rating', !me.guest);
}

function goHome() {
  endSession();
  renderChip();
  show('home');
  refreshFriendsBadge();
}

async function refreshFriendsBadge() {
  const badge = $('friends-badge');
  if (!me || me.guest) return badge.classList.add('hidden');
  try {
    const f = await api('GET', '/friends');
    badge.textContent = f.incoming.length;
    badge.classList.toggle('hidden', !f.incoming.length);
  } catch {
    badge.classList.add('hidden');
  }
}

function renderLengthPicker() {
  const box = $('length-picker');
  box.innerHTML = '';
  for (const n of MatchRules.matchLengths) {
    const b = document.createElement('button');
    b.textContent = `${n} питань`;
    b.classList.toggle('on', n === matchLength);
    b.onclick = () => { matchLength = n; store.set(LENGTH_KEY, n); renderLengthPicker(); };
    box.appendChild(b);
  }
  $('rules-count').textContent = `${matchLength} питань`;
}

// ===== Вітання та вхід =====
async function playAsGuest() {
  $('welcome-status').textContent = '';
  try {
    const r = await api('POST', '/guest', { name: $('welcome-name').value });
    setToken(r.token);
    me = r.me;
    connectSocket();
    goHome();
  } catch (e) {
    $('welcome-status').textContent = e.message;
  }
}

/** mode: 'upgrade' (гість створює акаунт) | 'login' (вхід в існуючий). */
function openAuth(mode, returnTo) {
  backTo = returnTo || (me ? 'home' : 'welcome');
  const upgrade = mode === 'upgrade' && me?.guest;
  $('auth-title').textContent = upgrade ? 'Створити акаунт' : 'Вхід';
  $('auth-sub').textContent = upgrade
    ? 'Вкажи пошту — надішлемо код. Усі твої матчі збережуться в акаунті.'
    : 'Вкажи пошту акаунта — надішлемо код для входу. Паролів немає.';
  $('auth-step-email').classList.remove('hidden');
  $('auth-step-code').classList.add('hidden');
  $('auth-status').textContent = '';
  $('auth-code').value = '';
  show('auth');
  setTimeout(() => $('auth-email').focus(), 50);
}

async function sendCode() {
  $('auth-status').textContent = '';
  $('auth-send').disabled = true;
  try {
    const r = await api('POST', '/auth/email/start', { email: $('auth-email').value });
    $('auth-step-email').classList.add('hidden');
    $('auth-step-code').classList.remove('hidden');
    $('auth-sent-to').textContent = `Код надіслано на ${r.email}`;
    const dev = $('auth-dev');
    dev.classList.toggle('hidden', !r.devCode);
    // Режим розробки: сервер не надсилає листів, а повертає код — показуємо його тут.
    if (r.devCode) dev.innerHTML = `Режим розробки — лист не надсилається.<br>Код: <b>${r.devCode}</b>`;
    setTimeout(() => $('auth-code').focus(), 50);
  } catch (e) {
    $('auth-status').textContent = e.message;
  } finally {
    $('auth-send').disabled = false;
  }
}

async function verifyCode() {
  $('auth-status').textContent = '';
  const wasGuest = me?.guest;
  try {
    const r = await api('POST', '/auth/email/verify', { email: $('auth-email').value, code: $('auth-code').value });
    setToken(r.token);
    me = r.me;
    reconnectSocket();
    goHome();
    toast(wasGuest && !r.merged ? '🎉 Акаунт створено — прогрес збережено' : r.merged ? '👋 Вхід виконано — матчі гостя перенесено в акаунт' : `👋 З поверненням, ${me.name}!`);
  } catch (e) {
    $('auth-status').textContent = e.message;
  }
}

// ===== Профіль =====
const fmtDate = ms => new Date(ms).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const OUTCOME = { win: 'Перемога', loss: 'Поразка', draw: 'Нічия' };

async function openProfile() {
  show('profile');
  try {
    await refreshMe();
  } catch (e) {
    return toast(e.message);
  }
  renderProfileHead();
  $('profile-cta').classList.toggle('hidden', !me.guest);
  $('profile-actions').classList.toggle('hidden', me.guest);
  const s = me.stats;
  const tiles = [
    [me.guest ? '🔒' : me.rating, 'Рейтинг'],
    [me.rank ? `#${me.rank}` : '—', 'Місце'],
    [s.accuracy == null ? '—' : `${s.accuracy}%`, 'Точність'],
    [`${s.human.wins}/${s.human.played}`, 'Перемоги з людьми'],
    [`${s.bot.wins}/${s.bot.played}`, 'Перемоги з ботом'],
    [s.bestScore || '—', 'Рекорд очок'],
  ];
  $('profile-stats').innerHTML = '';
  for (const [v, l] of tiles) {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = '<div class="v"></div><div class="l"></div>';
    d.firstChild.textContent = v;
    d.lastChild.textContent = l;
    $('profile-stats').appendChild(d);
  }
  const box = $('profile-history');
  box.innerHTML = '<div class="empty">Завантаження…</div>';
  try {
    const { matches } = await api('GET', '/me/history');
    box.innerHTML = matches.length ? '' : '<div class="empty">Ще немає матчів — час зіграти!</div>';
    for (const m of matches) {
      const delta = m.rated ? ` ${m.delta >= 0 ? '+' : ''}${m.delta}` : '';
      box.appendChild(row({
        icon: icon(m.mode === 'bot' ? 'bot' : 'user'),
        name: m.opp_name,
        sub: `${fmtDate(m.created_at)} · ${m.length} пит.${m.reason === 'opponentLeft' ? ' · суперник вийшов' : ''}`,
        side: `<div>${m.my_score} : ${m.opp_score}</div><div class="o ${m.outcome}">${OUTCOME[m.outcome]}${delta}</div>`,
      }));
    }
  } catch {
    box.innerHTML = '<div class="empty">Не вдалося завантажити історію</div>';
  }
}

/**
 * Рядок списку. icon/side — довірений HTML (наші іконки, числа й підписи);
 * name/sub — як текст; avatar — { photo, name } гравця.
 */
function row({ icon: iconHtml, avatar, rank, name, nameHtml, sub, side, me: isMe, actions }) {
  const r = document.createElement('div');
  r.className = 'row' + (isMe ? ' me' : '');
  if (rank != null) r.insertAdjacentHTML('beforeend', `<div class="rank">${rank}</div>`);
  if (iconHtml) r.insertAdjacentHTML('beforeend', `<div class="ic">${iconHtml}</div>`);
  if (avatar) {
    const av = document.createElement('span');
    av.className = 'av';
    setAvatar(av, avatar);
    r.appendChild(av);
  }
  const main = document.createElement('div');
  main.className = 'main';
  main.innerHTML = '<div class="n"></div>';
  if (nameHtml) main.firstChild.innerHTML = nameHtml;
  main.firstChild.append(name);
  if (sub) {
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = sub;
    main.appendChild(s);
  }
  r.appendChild(main);
  if (side) r.insertAdjacentHTML('beforeend', `<div class="side">${side}</div>`);
  for (const a of actions || []) r.appendChild(a);
  return r;
}

function renderProfileHead() {
  $('profile-name').value = me.name;
  $('profile-sub').textContent = me.guest ? 'Гість' : me.email;
  setAvatar($('profile-av'), { photo: me.photo, name: me.name });
  $('profile-cam').innerHTML = icon(me.guest ? 'lock' : 'camera');
  $('photo-remove').classList.toggle('hidden', !me.photo);
}

function pickPhoto() {
  if (!me || me.guest) {
    toast('Фото профілю — лише з акаунтом');
    return;
  }
  $('photo-input').click();
}

/** Обрізає до квадрата по центру й зменшує до 256×256 JPEG — так фото важить кілька десятків КБ без EXIF/GPS. */
async function preparePhoto(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  bmp.close?.();
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('jpeg'))), 'image/jpeg', 0.85));
}

async function uploadPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Обери зображення');
  $('profile-ava').classList.add('busy');
  try {
    let blob;
    try {
      blob = await preparePhoto(file);
    } catch {
      throw new Error('Не вдалося відкрити це зображення');
    }
    const r = await fetch('/api/me/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` },
      body: blob,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не вдалося завантажити фото');
    me = data;
    renderProfileHead();
    renderChip();
    toast('Фото оновлено');
  } catch (e) {
    toast(e.message);
  } finally {
    $('profile-ava').classList.remove('busy');
    $('photo-input').value = '';
  }
}

async function removePhoto() {
  try {
    me = await api('DELETE', '/me/photo');
    renderProfileHead();
    renderChip();
  } catch (e) {
    toast(e.message);
  }
}

async function saveName() {
  const name = $('profile-name').value;
  if (!me || name.trim() === me.name) return;
  try {
    me = await api('PATCH', '/me', { name });
    renderProfileHead();
    renderChip();
    toast('Імʼя збережено');
  } catch (e) {
    toast(e.message);
  }
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch {}
  signedOut();
}

async function deleteAccount() {
  if (!confirm('Видалити акаунт назавжди? Рейтинг, історія та друзі зникнуть.')) return;
  try {
    await api('DELETE', '/me');
    signedOut();
    toast('Акаунт видалено');
  } catch (e) {
    toast(e.message);
  }
}

function signedOut() {
  endSession();
  setToken(null);
  me = null;
  clearTimeout(reconnectTimer);
  const sock = ws;
  ws = null;
  sock?.close();
  $('welcome-name').value = '';
  show('welcome');
}

// ===== Таблиця лідерів =====
async function openLeaders() {
  show('leaders');
  $('leaders-list').innerHTML = '<div class="empty">Завантаження…</div>';
  try {
    const lb = await api('GET', '/leaderboard');
    $('leaders-cta').classList.toggle('hidden', !lb.me?.guest);
    const unranked = lb.me && !lb.me.guest && !lb.me.rank;
    $('leaders-unranked').classList.toggle('hidden', !unranked);
    $('leaders-unranked').textContent = 'Ти ще не в таблиці. Зіграй матч з іншим гравцем, у якого теж є акаунт, — і отримаєш місце в рейтингу.';
    const box = $('leaders-list');
    box.innerHTML = lb.top.length ? '' : '<div class="empty">Поки порожньо — стань першим!</div>';
    lb.top.forEach((p, i) => {
      box.appendChild(row({
        rank: ['🥇', '🥈', '🥉'][i] || i + 1,
        avatar: { photo: p.photo, name: p.name },
        name: p.name,
        sub: `${p.games} ${p.games === 1 ? 'матч' : 'матчів'}`,
        side: `<div style="font-weight:800">★ ${p.rating}</div>`,
        me: lb.me && p.id === lb.me.id,
      }));
    });
  } catch (e) {
    $('leaders-list').innerHTML = '';
    toast(e.message);
  }
}

// ===== Друзі =====
async function openFriends() {
  show('friends');
  $('friends-status').textContent = '';
  const guest = !me || me.guest;
  $('friends-cta').classList.toggle('hidden', !guest);
  $('friends-body').classList.toggle('hidden', guest);
  if (guest) return;
  await loadFriends();
  clearInterval(friendsPoll);
  friendsPoll = setInterval(() => { if (visible('friends')) loadFriends(); }, 5000);
}

function iconButton(label, cls, onClick, title) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}

async function loadFriends() {
  let f;
  try {
    f = await api('GET', '/friends');
  } catch (e) {
    $('friends-status').textContent = e.message;
    return;
  }
  $('my-friend-code').textContent = f.friendCode;
  $('incoming-wrap').classList.toggle('hidden', !f.incoming.length);
  $('outgoing-wrap').classList.toggle('hidden', !f.outgoing.length);
  const inc = $('incoming-list');
  inc.innerHTML = '';
  for (const p of f.incoming) {
    inc.appendChild(row({
      avatar: p, name: p.name, sub: `★ ${p.rating} · хоче дружити`,
      actions: [
        iconButton('✕', 'icon-btn', () => friendAction('DELETE', `/friends/${p.id}`), 'Відхилити'),
        iconButton('✓', 'icon-btn ok', () => friendAction('POST', `/friends/${p.id}/accept`), 'Прийняти'),
      ],
    }));
  }
  const list = $('friends-list');
  list.innerHTML = f.friends.length ? '' : '<div class="empty">Поки нікого. Поділись своїм кодом або введи код друга.</div>';
  for (const p of f.friends) {
    const invite = iconButton('', 'btn small', () => inviteFriend(p));
    invite.innerHTML = `${icon('swords')}Позвати`;
    invite.disabled = !p.online;
    list.appendChild(row({
      avatar: p,
      nameHtml: `<span class="online-dot${p.online ? ' on' : ''}"></span>`,
      name: p.name,
      sub: `★ ${p.rating} · ${p.online ? 'онлайн' : 'не в мережі'}`,
      actions: [invite],
    }));
  }
  const out = $('outgoing-list');
  out.innerHTML = '';
  for (const p of f.outgoing) {
    out.appendChild(row({
      avatar: p, name: p.name, sub: 'Запит надіслано',
      actions: [iconButton('✕', 'icon-btn', () => friendAction('DELETE', `/friends/${p.id}`), 'Скасувати')],
    }));
  }
  refreshFriendsBadge();
}

async function friendAction(method, path) {
  try {
    await api(method, path);
    await loadFriends();
  } catch (e) {
    $('friends-status').textContent = e.message;
  }
}

async function addFriend() {
  $('friends-status').textContent = '';
  const code = $('friend-code-input').value.trim();
  if (!code) return;
  try {
    const r = await api('POST', '/friends', { code });
    $('friend-code-input').value = '';
    toast(r.status === 'accepted' ? `🤝 Ви з ${r.friend.name} тепер друзі` : `Запит надіслано: ${r.friend.name}`);
    await loadFriends();
  } catch (e) {
    $('friends-status').textContent = e.message;
  }
}

function inviteFriend(friend) {
  showLobby();
  showLobbyWait({ text: `Кличемо ${friend.name}…`, hint: `Матч на ${matchLength} питань` });
  goOnline({ t: 'invite', friendId: friend.id, length: matchLength });
}

// ===== WebSocket =====
function connectSocket() {
  if (ws && ws.readyState <= WebSocket.OPEN) return wsOpen;
  clearTimeout(reconnectTimer);
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  wsOpen = new Promise((resolve, reject) => {
    sock.onopen = () => {
      if (token) sock.send(JSON.stringify({ t: 'auth', token })); // першим, до будь-яких інших повідомлень
      resolve(sock);
    };
    sock.onerror = () => reject(new Error('ws'));
  });
  wsOpen.catch(() => {});
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    onDisconnect();
    if (token) reconnectTimer = setTimeout(connectSocket, 3000);
  };
  sock.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    routeSocket(msg);
  };
  return wsOpen;
}

/** Після входу в інший акаунт — нове зʼєднання з новим токеном. */
function reconnectSocket() {
  const old = ws;
  ws = null;
  old?.close();
  connectSocket();
}

function routeSocket(msg) {
  if (msg.t === 'invited') return showInvite(msg);
  if (msg.t === 'inviteCancelled') {
    if (pendingInvite?.inviteId === msg.inviteId) hideInvite();
    return;
  }
  if (msg.t === 'authed' || msg.t === 'authError') return;
  if (session?.kind === 'online') onMessage(msg);
}

async function goOnline(msg) {
  endSession();
  $('lobby-status').textContent = '';
  let sock;
  try {
    sock = await connectSocket();
  } catch {
    showLobbyMenu();
    $('lobby-status').textContent = 'Немає звʼязку з сервером. Запусти його: завдання VS Code «Preview: запустити сервер».';
    return;
  }
  const s = {
    kind: 'online',
    send(m) { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)); },
    close() { this.send({ t: 'leave' }); },
  };
  session = s;
  s.send(msg);
}

function onDisconnect() {
  if (!session || session.kind !== 'online') return;
  session = null;
  clearUi();
  clearTimeout(ui.lobbyTimer);
  showLobby();
  $('lobby-status').textContent = 'Звʼязок із сервером втрачено.';
}

// ===== Запрошення від друга =====
function showInvite(msg) {
  pendingInvite = msg;
  setAvatar($('invite-av'), { photo: msg.from.photo, name: msg.from.name });
  $('invite-title').textContent = `${msg.from.name} кличе на дуель`;
  const inGame = visible('match') || visible('lobby');
  $('invite-desc').textContent = `Матч на ${msg.length} питань.` + (inGame ? ' Поточна гра завершиться.' : '');
  $('invite-modal').classList.remove('hidden');
}

function hideInvite() {
  pendingInvite = null;
  $('invite-modal').classList.add('hidden');
}

function acceptInvite() {
  const inv = pendingInvite;
  hideInvite();
  if (!inv) return;
  showLobby();
  showLobbyWait({ text: 'Підключаємось…' });
  goOnline({ t: 'inviteAccept', inviteId: inv.inviteId });
}

function declineInvite() {
  const inv = pendingInvite;
  hideInvite();
  if (inv && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'inviteDecline', inviteId: inv.inviteId }));
}

// ===== Сесії гри =====
function uiLater(fn, ms) { ui.timers.push(setTimeout(fn, ms)); }
function clearUi() {
  ui.timers.forEach(clearTimeout);
  ui.timers = [];
  cancelAnimationFrame(ui.raf);
}

function endSession() {
  clearUi();
  clearTimeout(ui.lobbyTimer);
  const s = session;
  session = null;
  s?.close();
}

/** Гра з ботом: той самий Match, що й на сервері, але локально. */
function startBotMatch() {
  endSession();
  const recent = store.get(RECENT_KEY, []);
  const questions = pickQuestions(bank, matchLength, recent);
  store.set(RECENT_KEY, updateRecent(recent, questions));
  const player = { name: me?.name || 'Гравець', avatar: '🎬', send: msg => { if (session === s) onMessage(msg); } };
  const match = new Match({ questions, players: [player, makeBot()] });
  const s = {
    kind: 'bot',
    send(msg) {
      if (session !== s) return;
      if (msg.t === 'answer') match.answer(0, msg.index, msg.option);
      else if (msg.t === 'skip') match.skip(0, msg.index);
      else if (msg.t === 'rematch') startBotMatch();
    },
    close() { match.abort(); },
  };
  session = s;
  match.start();
}

// ===== Лобі =====
function showLobby() {
  $('lobby-sub').textContent = `${matchLength} питань · граєш як «${me?.name || 'Гравець'}»`;
  $('lobby-status').textContent = '';
  showLobbyMenu();
  show('lobby');
}

function showLobbyMenu() {
  clearTimeout(ui.lobbyTimer);
  $('lobby-menu').classList.remove('hidden');
  $('lobby-wait').classList.add('hidden');
  $('lobby-back').classList.remove('hidden');
}

function showLobbyWait({ text, hint = '', code = null }) {
  $('lobby-menu').classList.add('hidden');
  $('lobby-wait').classList.remove('hidden');
  $('lobby-back').classList.add('hidden');
  $('wait-text').textContent = text;
  $('wait-hint').textContent = hint;
  $('room-code').classList.toggle('hidden', !code);
  $('room-code').textContent = code || '';
  $('bot-instead').classList.add('hidden');
}

// ===== Повідомлення матчу (однакові від локального Match і від сервера) =====
const handlers = {
  queued() {
    showLobbyWait({ text: 'Шукаємо суперника…', hint: `Матч на ${matchLength} питань` });
    clearTimeout(ui.lobbyTimer);
    ui.lobbyTimer = setTimeout(() => {
      $('wait-hint').textContent = 'Поки нікого немає. Можна зачекати ще або зіграти з ботом.';
      $('bot-instead').classList.remove('hidden');
    }, 20000);
  },

  room(m) {
    showLobbyWait({ text: 'Кімнату створено', code: m.code, hint: `Скажи другу цей код — він вводить його в «Гра з людиною». Матч на ${m.length} питань.` });
  },

  inviteSent(m) {
    showLobbyWait({ text: `Чекаємо на ${m.friend.name}…`, hint: 'Запрошення надіслано. Щойно друг прийме — почнеться матч.' });
  },

  inviteDeclined(m) {
    showLobbyMenu();
    $('lobby-status').textContent = `${m.name} відхилив запрошення`;
  },

  error(m) {
    if (visible('lobby')) {
      showLobbyMenu();
      $('lobby-status').textContent = m.message;
    } else {
      toast(m.message);
    }
  },

  start(m) {
    clearTimeout(ui.lobbyTimer);
    clearUi();
    ui.total = m.total;
    ui.opponentIsBot = m.opponent.isBot;
    ui.you = m.you;
    ui.opp = m.opponent;
    setAvatar($('me-ava'), { photo: m.you.photo, emoji: m.you.avatar });
    $('me-name').textContent = 'Ти';
    setAvatar($('opp-ava'), { photo: m.opponent.photo, emoji: m.opponent.avatar });
    $('opp-name').textContent = m.opponent.name;
    $('me-score').textContent = '0';
    $('opp-score').textContent = '0';
    for (const [col, p, nm] of [['res-me', m.you, 'Ти'], ['res-opp', m.opponent, m.opponent.name]]) {
      setAvatar($(col).querySelector('.ava'), { photo: p.photo, emoji: p.avatar });
      $(col).querySelector('.nm').textContent = nm;
    }
    $('options').innerHTML = '';
    $('prompt').textContent = '';
    $('fact').classList.add('hidden');
    show('match');
  },

  question(m) {
    clearUi();
    const isFinal = m.multiplier > 1;
    $('counter').textContent = isFinal ? 'Фінал ×2' : `${m.index + 1}/${m.total}`;
    $('counter').classList.toggle('final', isFinal);
    $('me-tick').classList.add('hidden');
    $('opp-tick').classList.add('hidden');
    $('options').innerHTML = '';
    $('fact').classList.add('hidden');
    $('question').classList.remove('revealing');
    setTimer(MatchRules.questionTime);
    const showPrompt = () => {
      $('banner').classList.add('hidden');
      const isEmoji = m.type === 'emoji';
      $('hint').classList.toggle('hidden', !isEmoji);
      $('prompt').classList.toggle('emoji', isEmoji);
      $('prompt').textContent = m.prompt;
      renderQuestionMedia(m);
    };
    renderQuestionMedia(null);
    if (isFinal) {
      $('prompt').textContent = '';
      $('hint').classList.add('hidden');
      $('banner').classList.remove('hidden');
      uiLater(showPrompt, MatchRules.finalBannerDuration * 1000);
    } else {
      showPrompt();
    }
  },

  options(m) {
    ui.answered = false;
    const box = $('options');
    box.innerHTML = '';
    m.options.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.innerHTML = '<span></span><span class="marks"></span>';
      b.firstChild.textContent = text;
      b.onclick = () => {
        if (ui.answered) return;
        ui.answered = true;
        b.classList.add('picked');
        for (const x of box.children) x.disabled = true;
        session?.send({ t: 'answer', index: m.index, option: i });
      };
      box.appendChild(b);
    });
    // Відлік лише для показу; час відповіді міряє матч (на сервері — сервер).
    const start = performance.now();
    const frame = () => {
      const left = m.time - (performance.now() - start) / 1000;
      setTimer(left);
      if (left > 0) ui.raf = requestAnimationFrame(frame);
    };
    ui.raf = requestAnimationFrame(frame);
  },

  answerAccepted() { $('me-tick').classList.remove('hidden'); },
  opponentAnswered() { $('opp-tick').classList.remove('hidden'); },

  reveal(m) {
    cancelAnimationFrame(ui.raf);
    [...$('options').children].forEach((b, i) => {
      b.disabled = true;
      b.classList.remove('picked');
      const marks = b.querySelector('.marks');
      const mark = p => {
        const s = document.createElement('span');
        setAvatar(s, { photo: p.photo, emoji: p.avatar });
        marks.appendChild(s);
      };
      if (m.you.option === i) mark(ui.you);
      if (m.opponent.option === i) mark(ui.opp);
      if (i === m.correctIndex) b.classList.add('correct');
      else if (m.you.option === i || m.opponent.option === i) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    $('me-score').textContent = m.you.score;
    $('opp-score').textContent = m.opponent.score;
    floatGain($('me-score'), m.you.points);
    floatGain($('opp-score'), m.opponent.points);

    if (m.fact) {
      $('fact-text').textContent = m.fact;
      $('fact-skip').textContent = 'Торкніться, щоб продовжити';
      $('question').classList.add('revealing');
      const card = $('fact');
      card.classList.remove('hidden');
      const bar = $('fact-bar');
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(1)';
      void bar.offsetWidth; // перезапуск анімації
      bar.style.transition = `transform ${m.duration * 1000}ms linear`;
      bar.style.transform = 'scaleX(0)';
      card.onclick = () => {
        card.onclick = null;
        if (!ui.opponentIsBot) $('fact-skip').textContent = 'Чекаємо на суперника…';
        session?.send({ t: 'skip', index: m.index });
      };
    }
  },

  opponentReady() {
    if (!$('fact').classList.contains('hidden') && $('fact').onclick) $('fact-skip').textContent = 'Суперник готовий — торкніться, щоб продовжити';
  },

  end(m) {
    clearUi();
    $('banner').classList.add('hidden');
    const left = m.reason === 'opponentLeft';
    const text = left ? ['🏆', 'Перемога!'] : { win: ['🏆', 'Перемога!'], loss: ['😤', 'Поразка'], draw: ['🤝', 'Нічия'] }[m.outcome];
    $('verdict-emoji').textContent = text[0];
    $('verdict').textContent = text[1];
    $('verdict').className = `verdict ${m.outcome}`;
    $('verdict-note').textContent = left ? 'Суперник вийшов з матчу' : '';
    const fill = (id, p, isWinner) => {
      $(id).querySelector('.pts').textContent = p.score;
      $(id).querySelector('.cr').textContent = `${p.correct} з ${m.total} правильно`;
      $(id).classList.toggle('winner', isWinner);
    };
    fill('res-me', m.you, m.outcome === 'win');
    fill('res-opp', m.opponent, m.outcome === 'loss');
    $('rematch').disabled = left;
    $('rematch').textContent = 'Реванш';
    $('rematch-note').textContent = '';
    $('rating-note').textContent = '';
    $('rating-note').className = 'rating-note soft';
    $('result-cta').classList.add('hidden');

    if (session?.kind === 'bot') {
      setRatingNote('Матчі з ботом не впливають на рейтинг', true);
      api('POST', '/matches/bot', { length: m.total, outcome: m.outcome, you: m.you, opponent: m.opponent })
        .then(() => refreshMe()).catch(() => {});
    }
    show('result');
  },

  /** Після матчу з людиною сервер повідомляє, що сталося з рейтингом. */
  rating(m) {
    if (m.rated) {
      const n = $('rating-note');
      n.className = 'rating-note';
      n.innerHTML = `Рейтинг: ★ ${m.rating} <span class="${m.delta >= 0 ? 'up' : 'down'}">(${m.delta >= 0 ? '+' : ''}${m.delta})</span>`;
    } else if (m.why === 'guest') {
      setRatingNote('Гості не отримують рейтинг', true);
    } else {
      $('rating-note').className = 'rating-note soft';
      $('rating-note').textContent = 'Суперник — гість, тож матч без рейтингу';
    }
    refreshMe().catch(() => {});
  },

  rematchRequested() {
    $('rematch').textContent = 'Прийняти реванш';
    $('rematch-note').textContent = 'Суперник хоче реванш!';
  },

  opponentLeft() {
    if (visible('result')) {
      $('rematch').disabled = true;
      $('rematch').textContent = 'Реванш';
      // Якщо матч і так завершився через вихід суперника, про це вже сказано над рахунком.
      $('rematch-note').textContent = $('verdict-note').textContent ? '' : 'Суперник пішов';
    } else if (visible('lobby')) {
      showLobbyMenu();
    }
  },
};

/** Кадр (image) або фото акторів (cast) над питанням; підпис автора — вимога ліцензій. */
function renderQuestionMedia(m) {
  const box = $('q-media');
  box.innerHTML = '';
  box.className = 'q-media';
  const hasMedia = !!(m && (m.image || m.cast));
  box.classList.toggle('hidden', !hasMedia);
  $('question').classList.toggle('media', hasMedia);
  if (!hasMedia) return;
  const credit = document.createElement('div');
  credit.className = 'q-credit';
  if (m.image) {
    box.classList.add('q-frame');
    const img = new Image();
    img.alt = 'Кадр із фільму';
    img.src = mediaUrl(m.image.file);
    box.appendChild(img);
    credit.textContent = `Кадр: ${m.image.credit}`;
  } else {
    const grid = document.createElement('div');
    grid.className = 'q-cast';
    for (const a of m.cast) {
      const p = document.createElement('div');
      const img = new Image();
      img.alt = a.name;
      img.src = mediaUrl(a.image.file);
      img.title = `${a.name} — фото: ${a.image.credit}`;
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = a.name;
      p.append(img, n);
      grid.appendChild(p);
    }
    box.appendChild(grid);
    credit.textContent = `Фото: ${m.cast.map(a => a.image.credit).join('; ')}`;
  }
  credit.title = credit.textContent;
  box.appendChild(credit);
}

async function openCredits() {
  show('credits');
  const box = $('credits-list');
  box.innerHTML = '<div class="empty">Завантаження…</div>';
  try {
    const credits = await (await fetch('../KinoBattleApp/media/credits.json', { cache: 'no-store' })).json();
    box.innerHTML = '';
    const entries = Object.values(credits).sort((a, b) => (a.title || a.commons).localeCompare(b.title || b.commons));
    for (const c of entries) {
      const r = row({
        name: c.title || c.commons.replace(/^File:/, '').replace(/\.\w+$/, ''),
        sub: `${/^\S+\.\w{2,4}$/.test(c.author) ? 'Wikimedia Commons' : c.author} · ${c.license}`,
      });
      r.style.cursor = 'pointer';
      r.onclick = () => window.open(c.source, '_blank', 'noopener');
      box.appendChild(r);
    }
  } catch {
    box.innerHTML = '<div class="empty">Не вдалося завантажити список</div>';
  }
}

/** Підпис під рахунком; гостям — ще й кнопка «Створити акаунт». */
function setRatingNote(text, withCta) {
  $('rating-note').className = 'rating-note soft';
  $('rating-note').textContent = text;
  $('result-cta').classList.toggle('hidden', !(withCta && me?.guest));
  if (withCta && me?.guest) $('rating-note').innerHTML = `${icon('lock')}Гості не потрапляють у рейтинг`;
}

function onMessage(msg) {
  const h = Object.hasOwn(handlers, msg.t) ? handlers[msg.t] : null;
  if (h) h(msg);
}

// ===== Дрібниці UI =====
function fitToWindow() {
  const s = Math.min(1, (innerHeight - 40) / 844, (innerWidth - 40) / 390);
  $('stage').style.transform = `scale(${s})`;
}

function tickClock() {
  const d = new Date();
  $('clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function setTimer(left) {
  const frac = Math.max(0, left) / MatchRules.questionTime;
  const fill = $('timer-fill');
  fill.style.width = `${frac * 100}%`;
  fill.style.background = frac > 0.5 ? 'var(--good)' : frac > 0.25 ? 'var(--gold)' : 'var(--bad)';
  $('timer-num').textContent = Math.ceil(Math.max(0, left));
}

function floatGain(anchor, points) {
  if (!points) return;
  const el = document.createElement('div');
  el.className = 'gain';
  el.textContent = `+${points}`;
  const host = $('match');
  const a = anchor.getBoundingClientRect(), h = host.getBoundingClientRect();
  const scale = h.width / host.offsetWidth;
  el.style.left = `${(a.left - h.left) / scale}px`;
  el.style.top = `${(a.bottom - h.top) / scale + 2}px`;
  host.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

/** Логотип із шаблону; id градієнтів робимо унікальними для кожної копії. */
function mountLogos() {
  const tpl = $('logo-tpl').innerHTML;
  document.querySelectorAll('[data-logo]').forEach((el, i) => {
    el.innerHTML = tpl.replace(/kb-(bg|bolt|shine|clapper|band)/g, `kb-$1-${i}`);
  });
}

function fatal(text) {
  show('welcome');
  $('welcome').innerHTML = `<div class="error"><b>${text}</b>Запусти сервер (VS Code: завдання «Preview: запустити сервер») і відкрий http://localhost:5180/preview/</div>`;
}

// ===== Старт =====
async function init() {
  mountLogos();
  renderLengthPicker();
  fitToWindow();
  addEventListener('resize', fitToWindow);
  tickClock();
  setInterval(tickClock, 10000);

  $('welcome-guest').onclick = playAsGuest;
  $('welcome-name').addEventListener('keydown', e => { if (e.key === 'Enter') playAsGuest(); });
  $('welcome-login').onclick = () => openAuth('login', 'welcome');

  $('me-chip').onclick = openProfile;
  $('play-bot').onclick = startBotMatch;
  $('play-online').onclick = showLobby;
  $('open-leaders').onclick = openLeaders;
  $('open-friends').onclick = openFriends;

  document.querySelectorAll('[data-back]').forEach(b => { b.onclick = () => (b.closest('#auth') && backTo === 'welcome' ? show('welcome') : goHome()); });
  document.querySelectorAll('[data-upgrade]').forEach(b => { b.onclick = () => openAuth('upgrade'); });

  $('auth-send').onclick = sendCode;
  $('auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
  $('auth-verify').onclick = verifyCode;
  $('auth-code').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
  $('auth-change').onclick = () => { $('auth-step-code').classList.add('hidden'); $('auth-step-email').classList.remove('hidden'); };

  $('profile-name').addEventListener('change', saveName);
  $('profile-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('profile-ava').onclick = pickPhoto;
  $('photo-input').addEventListener('change', e => uploadPhoto(e.target.files[0]));
  $('photo-remove').onclick = removePhoto;
  $('open-credits').onclick = openCredits;
  $('credits-back').onclick = openProfile;
  $('logout').onclick = logout;
  $('delete-account').onclick = deleteAccount;

  $('add-friend').onclick = addFriend;
  $('friend-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') addFriend(); });

  $('lobby-back').onclick = goHome;
  $('quick').onclick = () => { showLobbyWait({ text: 'Підключаємось…' }); goOnline({ t: 'quick', length: matchLength }); };
  $('create').onclick = () => { showLobbyWait({ text: 'Створюємо кімнату…' }); goOnline({ t: 'create', length: matchLength }); };
  const join = () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { $('lobby-status').textContent = 'Код кімнати — 4 символи'; return; }
    showLobbyWait({ text: 'Підключаємось…' });
    goOnline({ t: 'join', code });
  };
  $('join').onclick = join;
  $('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $('cancel-wait').onclick = () => { endSession(); showLobbyMenu(); };
  $('bot-instead').onclick = startBotMatch;

  $('rematch').onclick = () => {
    if (session?.kind === 'online') {
      $('rematch').disabled = true;
      $('rematch-note').textContent = 'Чекаємо на суперника…';
    }
    session?.send({ t: 'rematch' });
  };
  $('to-home').onclick = goHome;

  $('invite-accept').onclick = acceptInvite;
  $('invite-decline').onclick = declineInvite;

  try {
    const r = await fetch('../KinoBattleApp/questions.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bank = await r.json();
  } catch {
    return fatal('Не вдалося завантажити питання');
  }

  if (token) {
    try {
      await refreshMe();
    } catch (e) {
      if (e.status === 401) setToken(null);
      else return fatal('Немає звʼязку з сервером');
    }
  }
  if (me) {
    connectSocket();
    goHome();
  } else {
    show('welcome');
    setTimeout(() => $('welcome-name').focus(), 50);
  }
}
init();
