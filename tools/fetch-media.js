#!/usr/bin/env node
/*
 * Завантажує картинки для питань з Wikimedia Commons (лише вільні ліцензії) у KinoBattleApp/media/.
 *
 *   node tools/fetch-media.js            — докачати те, чого ще немає
 *   node tools/fetch-media.js --force    — перекачати все
 *
 * Список — у content/media.json:
 *   frames: [{ id, file }]           — кадр фільму: точна назва файлу на Commons («File:…»)
 *   actors: [{ id, name, wikidata? }] — фото актора: береться з Wikidata (властивість P18 «зображення»),
 *                                        яка посилається лише на файли Commons, тобто з вільною ліцензією
 *
 * Результат: KinoBattleApp/media/<id>.<jpg|png> і KinoBattleApp/media/credits.json
 * (автор, ліцензія, посилання — для підписів у грі та сторінки авторів).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SPEC = path.join(ROOT, 'content', 'media.json');
const OUT_DIR = path.join(ROOT, 'KinoBattleApp', 'media');
const CREDITS = path.join(OUT_DIR, 'credits.json');
const UA = 'KinoBattleQuizBuilder/0.1 (quiz question builder; https://www.mediawiki.org/wiki/API:Etiquette)';
const FORCE = process.argv.includes('--force');

const WIDTH = { frame: 640, actor: 240 };
/** Дозволені ліцензії: суспільне надбання, CC0, CC BY, CC BY-SA. GFDL-only та «fair use» — ні. */
const LICENSE_OK = /^(public domain|pd\b|cc0|cc[ -]by(-sa)?\b)/i;
const ACTOR_DESC = /actor|actress|performer|comedian|filmmaker|director|singer|musician|model/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** GET JSON з повторами: Wikimedia відповідає текстом «too many requests», коли поспішаєш. */
async function getJson(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await sleep(700 + i * 2500);
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const text = await r.text();
    if (r.ok) {
      try {
        return JSON.parse(text);
      } catch {}
    }
  }
  throw new Error(`Не вдалося отримати ${url}`);
}

async function download(url, file, tries = 5) {
  for (let i = 0; i < tries; i++) {
    await sleep(700 + i * 2500);
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return;
    }
  }
  throw new Error(`Не вдалося завантажити ${url}`);
}

const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function wikidataImage({ name, wikidata }) {
  let qid = wikidata;
  if (!qid) {
    const s = await getJson('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbsearchentities', search: name, language: 'en', type: 'item', limit: '7', format: 'json',
    }));
    const hit = s.search.find(h => ACTOR_DESC.test(h.description || ''));
    if (!hit) throw new Error(`Wikidata: не знайдено актора «${name}»`);
    qid = hit.id;
  }
  const c = await getJson('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
    action: 'wbgetclaims', entity: qid, property: 'P18', format: 'json',
  }));
  const file = c.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!file) throw new Error(`Wikidata: у ${name} (${qid}) немає фото`);
  return { qid, file: 'File:' + file };
}

async function commonsInfo(file, width) {
  const d = await getJson('https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', titles: file, prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime', iiurlwidth: String(width),
  }));
  const page = Object.values(d.query.pages)[0];
  const ii = page.imageinfo?.[0];
  if (!ii) throw new Error(`Commons: файл не знайдено — ${file}`);
  const m = ii.extmetadata || {};
  const license = stripHtml(m.LicenseShortName?.value) || 'unknown';
  if (!LICENSE_OK.test(license)) throw new Error(`Commons: ліцензія «${license}» не підходить — ${file}`);
  return {
    thumb: ii.thumburl || ii.url,
    source: ii.descriptionurl,
    license,
    licenseUrl: m.LicenseUrl?.value || null,
    author: stripHtml(m.Artist?.value) || 'невідомий автор',
  };
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
  const items = [
    ...spec.frames.map(f => ({ ...f, kind: 'frame' })),
    ...spec.actors.map(a => ({ ...a, kind: 'actor' })),
  ];
  const failed = [];
  for (const item of items) {
    const have = credits[item.id] && fs.existsSync(path.join(OUT_DIR, credits[item.id].file.replace(/^media\//, '')));
    if (have && !FORCE) continue;
    try {
      const ref = item.kind === 'actor' ? await wikidataImage(item) : { file: item.file };
      const info = await commonsInfo(ref.file, WIDTH[item.kind]);
      const ext = /\.png($|\?)/i.test(info.thumb) ? 'png' : 'jpg';
      const name = `${item.id}.${ext}`;
      await download(info.thumb, path.join(OUT_DIR, name));
      credits[item.id] = {
        file: `media/${name}`,
        title: item.name || null,
        commons: ref.file,
        wikidata: ref.qid || null,
        author: info.author,
        license: info.license,
        licenseUrl: info.licenseUrl,
        source: info.source,
      };
      fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2) + '\n');
      console.log(`✔ ${item.id}  ${info.license}  ${info.author.slice(0, 50)}`);
    } catch (e) {
      failed.push(item.id);
      console.log(`✖ ${item.id}: ${e.message}`);
    }
  }
  // Прибрати записи, яких уже немає в специфікації.
  const ids = new Set(items.map(i => i.id));
  for (const id of Object.keys(credits)) if (!ids.has(id)) delete credits[id];
  fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2) + '\n');
  console.log(`\nГотово: ${Object.keys(credits).length} картинок${failed.length ? `, не вдалося: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main();
