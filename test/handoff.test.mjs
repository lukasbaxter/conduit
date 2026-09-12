// Handoff test: two real Conduit app instances (isolated headless browsers) as
// the same user. Exercises switching the active player between them and the
// control-in-place behaviour, covering the four combinations:
//   1. B1 plays        -> B1 active, B2 mirrors
//   2. B2 changes song -> routes to B1 (stays active), both mirror the new song
//   3. B2 takes over   -> B2 active, B1 mirrors
//   4. B1 takes back   -> B1 active, B2 mirrors
// Playback must never "move" to the client that only changed the song (step 2).

import puppeteer from 'puppeteer';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';

// Two distinct real tracks.
const X = { id: '48202c7882093a3cb6637bd61ac61bd4', title: 'Feeling Like I' };
const Y = { id: '93cc83e2ac2bc8c2a6cc335ccafc9a22', title: 'Sexy For Me' };

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(browser, label) {
  const ctx = await browser.createBrowserContext(); // isolated storage -> own clientId
  const page = await ctx.newPage();
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER);
  await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2500); // relay connect + roster
  log(`${label} ready`);
  return page;
}

// Fetch real tracks by id and play them through the real player.
async function play(page, ids) {
  return page.evaluate(async (ids) => {
    const jf = window.__jf;
    const q = new URLSearchParams({ Ids: ids.join(','), userId: jf.userId, Fields: 'ArtistItems,AlbumArtists,UserData' });
    const data = await jf._fetch(`/Items?${q}`);
    window.__player.playQueue(data.Items, 0, null);
  }, ids);
}

// Transfer playback onto this client (pick "This device").
async function takeOver(page) {
  await page.evaluate(() => {
    const local = { id: 'local', kind: 'local', name: 'This Computer' };
    window.__player.setDevice(local);
  });
}

// This client's relay clientId (short suffix matches the debug overlay).
const clientId = (page) => page.evaluate(() => window.__player.relay?.id || null);

// Push playback onto ANOTHER client by picking it in the device picker. This is
// the browser -> desktop transfer path: the target must take over the CURRENT
// song at the CURRENT position, not restart at 0.
async function transferTo(page, targetClientId) {
  await page.evaluate((tid) => {
    window.__player.setDevice({ id: `relay:${tid}`, kind: 'relay', name: 'target', relayClientId: tid });
  }, targetClientId);
}

const parseT = (s) => { if (!s) return -1; const [m, x] = s.split(':').map(Number); return m * 60 + x; };
const state = (page) => page.evaluate(() => ({
  active: (document.querySelector('div[style*="monospace"]')?.textContent.match(/active=(\w+)/) || [])[1] || 'none',
  myId: (document.querySelector('div[style*="monospace"]')?.textContent.match(/myId=(\w+)/) || [])[1] || '?',
  title: document.querySelector('.player-title')?.textContent || '',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  pos: document.querySelector('.player-seek .t')?.textContent || '',
}));

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const B1 = await newClient(browser, 'B1');
  const B2 = await newClient(browser, 'B2');

  // 1. B1 takes over (become the active player regardless of other connected
  //    clients), then plays X.
  log('\n[1] B1 takes over + plays X');
  await takeOver(B1);
  await sleep(1500);
  await play(B1, [X.id]);
  await sleep(4000);
  let s1 = await state(B1); let s2 = await state(B2);
  log('B1:', JSON.stringify(s1)); log('B2:', JSON.stringify(s2));
  assert(s1.active === s1.myId, 'B1 is the active player');
  assert(s1.title.includes(X.title), 'B1 footer shows X');
  assert(s2.title.includes(X.title), 'B2 mirrors X');
  assert(s2.green.includes('Playing on'), 'B2 shows green bar');

  // 2. B2 changes song to Y -> should route to B1, NOT move playback to B2.
  log('\n[2] B2 changes song to Y (must stay on B1)');
  await play(B2, [Y.id]);
  await sleep(4000);
  s1 = await state(B1); s2 = await state(B2);
  log('B1:', JSON.stringify(s1)); log('B2:', JSON.stringify(s2));
  assert(s1.active === s1.myId, 'B1 is STILL the active player (playback did not move)');
  assert(s1.title.includes(Y.title), 'B1 now playing Y');
  assert(s2.title.includes(Y.title), 'B2 mirrors Y');

  // 3. B2 takes over -> B2 becomes active, B1 mirrors.
  log('\n[3] B2 takes over');
  await takeOver(B2);
  await sleep(4000);
  s1 = await state(B1); s2 = await state(B2);
  log('B1:', JSON.stringify(s1)); log('B2:', JSON.stringify(s2));
  assert(s2.active === s2.myId, 'B2 is now the active player');
  assert(s1.active === s2.myId, 'B1 sees B2 as active');
  assert(s1.green.includes('Playing on'), 'B1 shows green bar');
  assert(s1.title.includes(Y.title), 'B1 mirrors Y');
  assert(s2.title.includes(Y.title), 'B2 resumed Y after taking over');

  // 4. B1 takes back.
  log('\n[4] B1 takes back');
  await takeOver(B1);
  await sleep(4000);
  s1 = await state(B1); s2 = await state(B2);
  log('B1:', JSON.stringify(s1)); log('B2:', JSON.stringify(s2));
  assert(s1.active === s1.myId, 'B1 is the active player again');
  assert(s2.active === s1.myId, 'B2 sees B1 as active');

  // 5. B1 PUSHES playback to B2 via the device picker (browser -> desktop). The
  //    song must move to B2 and keep playing at its position, B1 must stop and
  //    show the green bar. This is the exact flow that used to restart at 0:00
  //    on the sender and do nothing on the target.
  log('\n[5] B1 pushes playback to B2 (device picker transfer)');
  const b2id = await clientId(B2);
  await sleep(2500); // let Y advance so we can prove it did NOT restart at 0
  const before = parseT((await state(B1)).pos);
  log('B1 position before transfer:', before);
  await transferTo(B1, b2id);
  await sleep(4500);
  s1 = await state(B1); s2 = await state(B2);
  log('B1:', JSON.stringify(s1)); log('B2:', JSON.stringify(s2));
  assert(s2.active === s2.myId, 'B2 became the active player');
  assert(s1.active === s2.myId, 'B1 sees B2 as active');
  assert(s2.title.includes(Y.title), 'B2 is playing the same song (Y)');
  assert(parseT(s2.pos) >= Math.max(0, before - 1), `B2 resumed at position, not 0 (${before} -> ${s2.pos})`);
  assert(s1.green.includes('Playing on'), 'B1 shows the green bar after pushing to B2');
  assert(s1.title.includes(Y.title), 'B1 mirrors Y');

  await browser.close();
  console.log(failures ? `\n  ${failures} FAILURE(S)` : '\n  ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
