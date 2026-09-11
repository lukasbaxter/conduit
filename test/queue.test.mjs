// Shared queue. A plays a 3-track queue; B (mirroring) must show the same
// queue in its panel, and clicking a row / pressing next on B must move A.
// Transferring the session to B must carry the WHOLE queue, not one track.

import puppeteer from 'puppeteer';

const APP = 'http://192.168.1.85:8748';
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';
const Q = [
  { id: '48202c7882093a3cb6637bd61ac61bd4', title: "Feeling Like I'm Him" },
  { id: '93cc83e2ac2bc8c2a6cc335ccafc9a22', title: 'Sexy For Me' },
  { id: '151bc321c39bfa81c4c675484f4bd6b0', title: 'Everything Will Be OK' },
];

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2500);
  log(`${label} ready`);
  return page;
}
async function play(page, ids) {
  return page.evaluate(async (ids) => {
    const jf = window.__jf;
    const q = new URLSearchParams({ Ids: ids.join(','), userId: jf.userId, Fields: 'ArtistItems,AlbumArtists,UserData' });
    const data = await jf._fetch(`/Items?${q}`);
    const byId = new Map(data.Items.map((t) => [t.Id, t]));
    window.__player.playQueue(ids.map((id) => byId.get(id)), 0, null);
  }, ids);
}
const openQueue = async (page) => {
  const on = await page.evaluate(() => document.querySelector('.icon-btn[title="Queue"]')?.classList.contains('on'));
  if (!on) await page.click('.icon-btn[title="Queue"]');
  await sleep(500);
};
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  rows: [...document.querySelectorAll('.qrow .qrow-title')].map((e) => e.textContent),
  localQueue: window.__player.current ? 'has-own-queue' : 'no-own-queue',
}));

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const A = await newClient(browser, 'A');
  const B = await newClient(browser, 'B');

  log('\n[1] A plays a 3-track queue; B shows the same queue while mirroring');
  await play(A, Q.map((t) => t.id));
  await sleep(3500);
  await openQueue(A); await openQueue(B);
  let sa = await state(A); let sb = await state(B);
  log('A:', JSON.stringify(sa)); log('B:', JSON.stringify(sb));
  assert(sa.rows.join('|') === Q.map((t) => t.title).join('|'), 'A queue panel: now playing + 2 next');
  assert(sb.green.includes('Playing on'), 'B mirrors A');
  assert(sb.rows.join('|') === Q.map((t) => t.title).join('|'), 'B queue panel matches A');
  assert(sb.localQueue === 'no-own-queue', 'B has no queue of its own (pure mirror)');

  log('\n[2] B clicks the 2nd upcoming row: A jumps to track 3');
  await B.evaluate(() => [...document.querySelectorAll('.qrow')][2].click());
  await sleep(3000);
  sa = await state(A); sb = await state(B);
  assert(sa.title.includes(Q[2].title), `A now on "${Q[2].title}" (got "${sa.title}")`);
  assert(sb.title.includes(Q[2].title) && sb.rows[0] === Q[2].title && sb.rows.length === 1, `B mirrors track 3 with nothing left after it (${JSON.stringify(sb.rows)})`);

  log('\n[3] B presses previous twice: A goes back to track 1');
  await B.click('.player-buttons button[title="Previous"]'); await sleep(1500);
  await B.click('.player-buttons button[title="Previous"]'); await sleep(2500);
  sa = await state(A); sb = await state(B);
  assert(sa.title.includes(Q[0].title), `A back on track 1 (got "${sa.title}")`);
  assert(sb.rows.length === 3, `B shows 3 rows again (${sb.rows.length})`);

  log('\n[4] B takes the session: whole queue comes across');
  await B.evaluate(() => window.__player.setDevice({ id: 'local', kind: 'local', name: 'This Web Player' }));
  await sleep(5000);
  sa = await state(A); sb = await state(B);
  log('A:', JSON.stringify(sa)); log('B:', JSON.stringify(sb));
  assert(sb.localQueue === 'has-own-queue' && !sb.green, 'B is now the player');
  assert(sb.rows.join('|') === Q.map((t) => t.title).join('|'), `B has the full 3-track queue (${JSON.stringify(sb.rows)})`);
  assert(sa.green.includes('Playing on') && sa.rows.join('|') === Q.map((t) => t.title).join('|'), 'A mirrors B with the same queue');

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
