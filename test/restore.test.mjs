// Restore + mirror-art test.
//  1. A client plays X, seeks to 40s, is reloaded: the footer must come back
//     showing X, PAUSED, at ~40s (never "Nothing playing"), on "This Web
//     Player" -- and pressing play must resume from there, not 0:00.
//  2. Playing past the end of a 1-track queue parks on the last track paused
//     instead of going blank.
//  3. A second client mirroring the session must get the cover art built from
//     ITS OWN Jellyfin base URL + token (by item id), not the active player's
//     artUrl, which does not load across runtimes (desktop vs web).
//
// Kill any real desktop/browser client first: it shares the session.

import puppeteer from 'puppeteer';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = process.env.CONDUIT_TEST_PASS || '';
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
  await login(page);
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

const parseT = (s) => { if (!s) return -1; const [m, x] = s.split(':').map(Number); return m * 60 + x; };
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  pos: document.querySelector('.player-seek .t')?.textContent || '',
  playing: document.querySelector('.player-buttons .play')?.title === 'Pause',
  device: document.querySelector('.devicebtn-name')?.textContent || '',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  art: document.querySelector('img.player-art')?.getAttribute('src') || '',
  artLoaded: (document.querySelector('img.player-art')?.naturalWidth || 0) > 0,
  audioSrc: window.__player && window.__player.current ? 'has-current' : 'no-current',
}));

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const A = await newClient(browser, 'A');

  log('\n[1] A plays X, seeks to 40s');
  await play(A, [X.id]);
  await sleep(3000);
  await A.evaluate(() => window.__player.seek(40));
  await sleep(6500); // > one 5s playhead save
  let s = await state(A);
  log('A before reload:', JSON.stringify(s));
  assert(s.title.includes(X.title), 'A plays X');
  assert(s.playing, 'A is playing');
  assert(parseT(s.pos) >= 40, `A is past 40s (${s.pos})`);
  assert(s.device === 'This Web Player', `browser local device is "This Web Player" (got "${s.device}")`);
  const posBefore = parseT(s.pos);

  log('\n[2] reload A: must come back on X, paused, at the same spot');
  await A.reload({ waitUntil: 'networkidle2' });
  await A.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(3000);
  s = await state(A);
  log('A after reload:', JSON.stringify(s));
  assert(s.title.includes(X.title), 'footer shows X after reload (not "Nothing playing")');
  assert(!s.playing, 'restored paused');
  assert(Math.abs(parseT(s.pos) - posBefore) <= 3, `restored playhead ~${posBefore}s (got ${s.pos})`);
  assert(s.artLoaded, 'restored cover art loads');

  log('\n[3] press play: resumes from the saved spot, not 0:00');
  await A.click('.player-buttons .play');
  await sleep(4000);
  s = await state(A);
  log('A resumed:', JSON.stringify(s));
  assert(s.playing, 'playing after resume');
  assert(parseT(s.pos) >= posBefore, `resumed at >= ${posBefore}s (got ${s.pos})`);

  log('\n[4] a second client mirrors A: art comes from its OWN base URL by id');
  const B = await newClient(browser, 'B');
  await sleep(2500);
  const sb = await state(B);
  const bBase = await B.evaluate(() => window.__jf.baseUrl);
  log('B:', JSON.stringify(sb));
  assert(sb.green.includes('Playing on'), 'B shows the green bar');
  assert(sb.title.includes(X.title), 'B mirrors X');
  assert(sb.art.startsWith(bBase) && sb.art.includes('api_key='), `B art is built by B's own client (${sb.art.slice(0, 60)}...)`);
  assert(sb.artLoaded, 'B mirrored cover art loads');

  log('\n[5] end of queue: park on the last track, paused, not blank');
  await A.evaluate(() => window.__player.next()); // 1-track queue -> past the end
  await sleep(2500);
  s = await state(A);
  log('A at end:', JSON.stringify(s));
  assert(s.title.includes(X.title), 'still shows X after the queue ended');
  assert(!s.playing, 'paused at the end');
  assert(parseT(s.pos) === 0, `parked at 0:00 (got ${s.pos})`);
  await A.click('.player-buttons .play');
  await sleep(3000);
  s = await state(A);
  assert(s.playing && parseT(s.pos) >= 1, `play restarts the parked track (${s.pos})`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
