// Account-level session memory + row menu test.
//  1. A plays X and seeks to 40s, then its browser context is CLOSED (no other
//     client connected). A brand-new client B (empty localStorage) must open
//     on X, paused, at ~40s -- handed over by the relay's memory of the
//     account, so "Nothing playing" never happens.
//  2. The row context menu (right-click) lists Spotify's items in order, the
//     "Add to playlist > New playlist" path creates a playlist through the
//     in-app dialog (no window.prompt), and it shows in the sidebar even while
//     empty-ish. "Add to queue" appends to the queue.
//
// Kill any real desktop/browser client first: it shares the session.

import puppeteer from 'puppeteer';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest';
const PASS = 'Conduit-Test-9921';
const X = { id: '48202c7882093a3cb6637bd61ac61bd4', title: 'Feeling Like I' };

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page) {
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER);
  await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2500);
}
async function newClient(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await login(page);
  log(`${label} ready`);
  return { page, ctx };
}
async function play(page, ids) {
  return page.evaluate(async (ids) => {
    const jf = window.__jf;
    const q = new URLSearchParams({ Ids: ids.join(','), userId: jf.userId, Fields: 'ArtistItems,AlbumArtists,UserData' });
    const data = await jf._fetch(`/Items?${q}`);
    window.__player.playQueue(data.Items, 0, null);
  }, ids);
}
const parseT = (s) => { if (!s) return -1; const [m, x] = s.split(':').map(Number); return m * 60 + x; };
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  pos: document.querySelector('.player-seek .t')?.textContent || '',
  playing: document.querySelector('.player-buttons .play')?.title === 'Pause',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  queueLen: window.__player?.queue?.length || 0,
}));

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

  log('\n[1] A plays X, seeks to 40s, then disappears');
  const A = await newClient(browser, 'A');
  await play(A.page, [X.id]);
  await sleep(3000);
  await A.page.evaluate(() => window.__player.seek(40));
  await sleep(3000);
  const sa = await state(A.page);
  log('A:', JSON.stringify(sa));
  assert(sa.playing && parseT(sa.pos) >= 40, 'A is playing past 40s');
  const posA = parseT(sa.pos);
  await A.ctx.close();
  await sleep(1500);

  log('\n[2] brand-new client B opens on X, paused, at ~the same spot');
  const B = await newClient(browser, 'B');
  await sleep(1500);
  const sb = await state(B.page);
  log('B:', JSON.stringify(sb));
  assert(sb.title.includes(X.title), 'B shows X (from the relay session memory)');
  assert(!sb.playing, 'B is paused');
  assert(Math.abs(parseT(sb.pos) - posA) <= 4, `B playhead ~${posA}s (got ${sb.pos})`);
  assert(!sb.green, 'no green bar (nobody else is playing)');

  log('\n[3] right-click menu on a row');
  await B.page.click('.navitem:nth-child(2)');
  await B.page.waitForSelector('input.search', { timeout: 5000 });
  await B.page.type('input.search', 'Feeling Like');
  await B.page.waitForSelector('.trackrow', { timeout: 10000 });
  await sleep(800);
  const row = await B.page.$('.trackrow');
  const box = await row.boundingBox();
  await B.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await B.page.waitForSelector('.ctxmenu-fixed', { timeout: 3000 });
  const labels = await B.page.$$eval('.ctxmenu-fixed .ctxitem .ctx-label', (els) => els.map((e) => e.textContent));
  log('menu:', labels.join(' | '));
  const want = ['Add to playlist', 'Liked Songs', 'Add to queue', 'taste profile', 'Go to song radio', 'Go to artist', 'Go to album', 'Download'];
  let order = 0;
  for (const w of want) { const i = labels.findIndex((l, k) => k >= order && l.includes(w)); assert(i >= 0, `menu has "${w}" in order`); if (i >= 0) order = i; }
  const rect = await B.page.$eval('.ctxmenu-fixed', (el) => { const r = el.getBoundingClientRect(); return { b: r.bottom, r: r.right, h: innerHeight, w: innerWidth }; });
  assert(rect.b <= rect.h && rect.r <= rect.w, 'menu fits on screen');

  log('\n[4] Add to queue appends');
  const before = (await state(B.page)).queueLen;
  await B.page.evaluate(() => [...document.querySelectorAll('.ctxmenu-fixed .ctxitem')].find((b) => b.textContent.includes('Add to queue')).click());
  await sleep(800);
  const after = (await state(B.page)).queueLen;
  assert(after === before + 1, `queue grew ${before} -> ${after}`);

  log('\n[5] Add to playlist > New playlist creates through the dialog');
  const name = `__conduit_menu_${Date.now().toString(36)}`;
  await B.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await B.page.waitForSelector('.ctxmenu-fixed', { timeout: 3000 });
  await B.page.hover('.ctxmenu-fixed .ctxitem');
  await B.page.waitForSelector('.ctxmenu-sub', { timeout: 3000 });
  await B.page.evaluate(() => [...document.querySelectorAll('.ctxmenu-sub .ctxitem')].find((b) => b.textContent.includes('New playlist')).click());
  await B.page.waitForSelector('.modal input', { timeout: 3000 });
  await B.page.evaluate(() => { const i = document.querySelector('.modal input'); i.select(); });
  await B.page.keyboard.press('Backspace');
  await B.page.type('.modal input', name);
  await B.page.click('.modal .primary');
  await sleep(2500);
  const inSidebar = await B.page.evaluate((n) => document.body.innerText.includes(n), name);
  assert(inSidebar, 'new playlist appears in the sidebar');
  // clean up via Jellyfin
  const tok = await B.page.evaluate(() => window.__jf.token);
  const uid = await B.page.evaluate(() => window.__jf.userId);
  const pls = await (await fetch(`${JELLYFIN}/Items?userId=${uid}&IncludeItemTypes=Playlist&Recursive=true&searchTerm=${name}`, { headers: { 'X-Emby-Token': tok } })).json();
  for (const p of pls.Items || []) await fetch(`${JELLYFIN}/Items/${p.Id}`, { method: 'DELETE', headers: { 'X-Emby-Token': tok } });

  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
