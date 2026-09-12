// Footer heart while mirroring. B controls a session that A owns: B's footer
// heart must show, reflect the session track's liked state, and toggling it
// must land in Jellyfin AND on A's heart (A's queue is the source of the
// mirrored state). Uses the dedicated conduittest account.

import puppeteer from 'puppeteer';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';
const X = { id: '48202c7882093a3cb6637bd61ac61bd4', title: 'Feeling Like I' };

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auth() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="test", Device="test", DeviceId="liked-test", Version="1"' },
    body: JSON.stringify({ Username: USER, Pw: PASS }),
  });
  const d = await res.json();
  return { token: d.AccessToken, userId: d.User.Id };
}
async function isFavorite(a, id) {
  const r = await fetch(`${JELLYFIN}/Items?Ids=${id}&userId=${a.userId}&Fields=UserData`, { headers: { 'X-Emby-Token': a.token } });
  return Boolean((await r.json()).Items?.[0]?.UserData?.IsFavorite);
}
async function setFavorite(a, id, on) {
  await fetch(`${JELLYFIN}/Users/${a.userId}/FavoriteItems/${id}`, { method: on ? 'POST' : 'DELETE', headers: { 'X-Emby-Token': a.token } });
}

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
    window.__player.playQueue(data.Items, 0, null);
  }, ids);
}
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  heart: document.querySelector('.player-now .trackrow-like') ? 'shown' : 'missing',
  liked: document.querySelector('.player-now .trackrow-like')?.classList.contains('on') || false,
}));

async function main() {
  const a = await auth();
  await setFavorite(a, X.id, false);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const A = await newClient(browser, 'A');
  const B = await newClient(browser, 'B');

  log('\n[1] A plays X (unliked); B mirrors');
  await play(A, [X.id]);
  await sleep(4000);
  let sa = await state(A); let sb = await state(B);
  log('A:', JSON.stringify(sa)); log('B:', JSON.stringify(sb));
  assert(sb.green.includes('Playing on'), 'B mirrors A');
  assert(sb.heart === 'shown', 'B footer heart is shown while mirroring');
  assert(!sb.liked && !sa.liked, 'both hearts off');

  log('\n[2] B likes from its footer heart');
  await B.click('.player-now .trackrow-like');
  await sleep(2500);
  sa = await state(A); sb = await state(B);
  log('A:', JSON.stringify(sa)); log('B:', JSON.stringify(sb));
  assert(await isFavorite(a, X.id), 'Jellyfin has X as favorite');
  assert(sb.liked, 'B heart on');
  assert(sa.liked, 'A (active player) heart on too');

  log('\n[3] A unlikes from its footer heart');
  await A.click('.player-now .trackrow-like');
  await sleep(2500);
  sa = await state(A); sb = await state(B);
  log('A:', JSON.stringify(sa)); log('B:', JSON.stringify(sb));
  assert(!(await isFavorite(a, X.id)), 'Jellyfin no longer has X as favorite');
  assert(!sa.liked, 'A heart off');
  assert(!sb.liked, 'B heart off (mirrored)');

  log('\n[4] B likes again, then unlikes: double toggle round-trips');
  await B.click('.player-now .trackrow-like'); await sleep(2000);
  await B.click('.player-now .trackrow-like'); await sleep(2500);
  sa = await state(A); sb = await state(B);
  assert(!(await isFavorite(a, X.id)) && !sa.liked && !sb.liked, 'ends unliked everywhere');

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
