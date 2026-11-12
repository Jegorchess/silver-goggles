#!/usr/bin/env node
/*
 * Збирає базу питань із тематичних файлів content/questions/*.json у KinoBattleApp/questions.json.
 *
 *   node tools/build-questions.js
 *
 * У файлах тем картинки вказуються за id з content/media.json:
 *   "image": "frame-gold-rush"
 *   "cast": [{ "name": "Том Генкс", "image": "actor-tom-hanks" }, …]
 * Скрипт підставляє шлях і підпис автора/ліцензії з KinoBattleApp/media/credits.json
 * (його створює tools/fetch-media.js), перевіряє все за правилами Swift-рушія
 * (QuestionBank.validate) і пише KinoBattleApp/questions.json та KinoBattleApp/media/CREDITS.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'content', 'questions');
const APP = path.join(ROOT, 'KinoBattleApp');
const OUT = path.join(APP, 'questions.json');
const CREDITS = path.join(APP, 'media', 'credits.json');
const CREDITS_MD = path.join(APP, 'media', 'CREDITS.md');

// Ті самі межі, що в KinoBattleApp/Engine/QuestionBank.swift.
const RULES = { options: 4, prompt: 120, option: 40, fact: 160, castMin: 2, castMax: 4, castName: 40 };
const TYPES = ['text', 'emoji', 'frame', 'cast'];
const len = s => [...String(s)].length; // як Swift String.count для звичайного тексту

const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
const errors = [];
const warnings = [];

function media(id, where) {
  const c = credits[id];
  if (!c) {
    errors.push(`${where}: картинки «${id}» немає в credits.json (запусти node tools/fetch-media.js)`);
    return null;
  }
  if (!fs.existsSync(path.join(APP, c.file))) errors.push(`${where}: немає файлу ${c.file}`);
  const pd = /^public domain|^pd\b|^cc0/i.test(c.license);
  const unknown = !c.author || c.author === 'невідомий автор' || /^unknown/i.test(c.author);
  // Іноді Commons віддає замість автора назву файлу — тоді пишемо джерело (повний опис — у CREDITS.md).
  const raw = /^\S+\.\w{2,4}$/.test(c.author) ? 'Wikimedia Commons' : c.author;
  const author = len(raw) > 60 ? [...raw].slice(0, 59).join('') + '…' : raw;
  return { file: c.file, credit: pd && unknown ? c.license : `${author} · ${c.license}` };
}

function check(q, where) {
  const err = m => errors.push(`${where} (${q.id || '?'}): ${m}`);
  if (!/^[a-z0-9-]+$/.test(q.id || '')) err('id — лише малі латинські літери, цифри й дефіс');
  if (!TYPES.includes(q.type)) err(`невідомий тип «${q.type}»`);
  if (!Array.isArray(q.options) || q.options.length !== RULES.options) err('потрібно рівно 4 варіанти');
  else {
    if (new Set(q.options).size !== q.options.length) err('варіанти повторюються');
    for (const o of q.options) if (len(o) > RULES.option) err(`варіант довший за ${RULES.option}: «${o}»`);
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) err('correctIndex поза межами');
  }
  for (const t of [q.prompt, ...(q.options || []), q.fact]) if (t != null && !String(t).trim()) err('порожній текст');
  if (len(q.prompt || '') > RULES.prompt) err(`питання довше за ${RULES.prompt}`);
  if (!q.fact) err('немає факту');
  else if (len(q.fact) > RULES.fact) err(`факт довший за ${RULES.fact} (${len(q.fact)})`);
  if (![1, 2, 3].includes(q.difficulty)) err('difficulty — 1, 2 або 3');
  if (q.type === 'frame' && !q.image) err('для кадру потрібне image');
  if (q.type === 'cast') {
    const n = q.cast?.length || 0;
    if (n < RULES.castMin || n > RULES.castMax) err(`для «складу» потрібно ${RULES.castMin}–${RULES.castMax} акторів`);
    for (const a of q.cast || []) if (!a.name || len(a.name) > RULES.castName) err(`імʼя актора: «${a.name}»`);
  }
}

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.json')).sort();
const all = [];
const stats = {};
for (const f of files) {
  const list = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
  stats[f] = list.length;
  for (const q of list) {
    check(q, f);
    const out = {
      id: q.id, type: q.type, difficulty: q.difficulty, prompt: q.prompt,
      options: q.options, correctIndex: q.correctIndex, fact: q.fact,
    };
    if (q.image) out.image = media(q.image, f);
    if (q.cast) out.cast = q.cast.map(a => ({ name: a.name, image: media(a.image, f) }));
    all.push(out);
  }
}

const ids = new Map();
const prompts = new Map();
for (const q of all) {
  if (ids.has(q.id)) errors.push(`повторюється id «${q.id}»`);
  ids.set(q.id, true);
  // Однакові формулювання можливі лише в кадрах/«складі» (там питання шаблонне).
  if (q.type === 'text' || q.type === 'emoji') {
    const key = q.prompt.toLowerCase();
    if (prompts.has(key)) warnings.push(`однакове питання: ${prompts.get(key)} і ${q.id}`);
    prompts.set(key, q.id);
  }
}

for (const w of warnings) console.warn('⚠ ' + w);
if (errors.length) {
  for (const e of errors) console.error('✖ ' + e);
  console.error(`\n${errors.length} помилок — questions.json не оновлено.`);
  process.exit(1);
}

fs.writeFileSync(OUT, '[\n' + all.map(q => '  ' + JSON.stringify(q)).join(',\n') + '\n]\n');

// Сторінка авторів (вимога ліцензій CC BY / CC BY-SA).
const used = new Set(all.flatMap(q => [q.image, ...(q.cast || []).map(a => a.image)]).filter(Boolean).map(m => m.file));
const rows = Object.entries(credits)
  .filter(([, c]) => used.has(c.file))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, c]) => `| ${c.title || c.commons.replace(/^File:/, '')} | ${c.author.replace(/\|/g, '/')} | ${c.licenseUrl ? `[${c.license}](${c.licenseUrl})` : c.license} | [Commons](${c.source}) |`);
fs.writeFileSync(CREDITS_MD, `# Автори зображень

Усі зображення — з [Wikimedia Commons](https://commons.wikimedia.org), під вільними ліцензіями
або в суспільному надбанні. Файли зменшено; інших змін не вносилося. Список генерує \`tools/build-questions.js\`.

| Зображення | Автор | Ліцензія | Джерело |
|---|---|---|---|
${rows.join('\n')}
`);

const by = (key) => all.reduce((m, q) => ((m[q[key]] = (m[q[key]] || 0) + 1), m), {});
console.log(`✔ ${all.length} питань → ${path.relative(ROOT, OUT)}`);
console.log('  за файлами:', stats);
console.log('  за типами:', by('type'));
console.log('  за складністю:', by('difficulty'));
console.log(`  картинок у грі: ${used.size} (автори — ${path.relative(ROOT, CREDITS_MD)})`);
