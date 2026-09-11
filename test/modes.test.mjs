// Repeat + smart-shuffle behaviour at the end of the queue, driven through the
// real player. Verifies the two things the user asked for:
//   - repeat one  -> the song replays instead of stopping
//   - smart shuffle -> a similar song is picked and keeps playing

import puppeteer from 'puppeteer';

const APP = 'http://192.168.1.85:8748';
const JELLYFIN = 'http://192.168.1.85:2101';
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';
const X = { id: '48202c7882093a3cb6637bd61ac61bd4', title: 'Feeling Like I' };

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2000);
  return page;
}
const play = (page, ids) => page.evaluate(async (ids) => {
  const jf = window.__jf;
  const q = new URLSearchParams({ Ids: ids.join(','), userId: jf.userId, Fields: 'ArtistItems,AlbumArtists,UserData' });
  const data = await jf._fetch(`/Items?${q}`);
  window.__player.playQueue(data.Items, 0, null);
}, ids);
const st = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  repeat: window.__player.repeat, shuffle: window.__player.shuffle,
  pos: document.querySelector('.player-seek .t')?.textContent || '',
  playing: !!document.querySelector('.player-buttons .play')?.getAttribute('title')?.includes('Pause'),
}));

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const p = await client(browser);

  // Repeat one: play a single track, set repeat=one, skip forward -> replays.
  log('[1] repeat one replays the song');
  await play(p, [X.id]);
  await sleep(3000);
  await p.evaluate(() => { window.__player.cycleRepeat(); window.__player.cycleRepeat(); }); // off->all->one
  await sleep(300);
  let s = await st(p); log('before skip:', JSON.stringify(s));
  assert(s.repeat === 'one', 'repeat mode is one');
  await p.evaluate(() => window.__player.next());
  await sleep(2500);
  s = await st(p); log('after skip:', JSON.stringify(s));
  assert(s.title.includes(X.title), 'same song still playing (replayed, not stopped)');

  // Smart shuffle: single track, enable smart, skip forward -> similar song.
  log('\n[2] smart shuffle continues with a similar song');
  await play(p, [X.id]);
  await sleep(2500);
  await p.evaluate(() => { window.__player.cycleRepeat(); }); // one->off
  await p.evaluate(() => { window.__player.cycleShuffle(); window.__player.cycleShuffle(); }); // off->on->smart
  await sleep(300);
  s = await st(p); log('before skip:', JSON.stringify(s));
  assert(s.shuffle === 'smart', 'shuffle mode is smart');
  assert(s.repeat === 'off', 'repeat is off');
  await p.evaluate(() => window.__player.next());
  await sleep(4000);
  s = await st(p); log('after skip:', JSON.stringify(s));
  assert(s.title && !s.title.includes(X.title) && s.title !== 'Nothing playing', `moved to a similar song (${s.title})`);

  // [3] A mirroring CONTROLLER must be able to cycle a mode all the way back to
  //     off (the bug: it always re-sent "on" and got stuck). A is the active
  //     player; B controls it.
  log('\n[3] controller cycles shuffle; must reach OFF');
  const A = p;
  const B = await client(browser);
  await play(A, [X.id]); // A is already active from earlier; give it a track
  await sleep(2500);
  // Wait until B actually mirrors A (sees A as the active player) before it
  // starts controlling -- otherwise the first click applies locally on B.
  await B.evaluate(() => new Promise((res) => {
    const check = () => {
      const r = window.__player.roster;
      if (r?.activeClientId && r.activeClientId !== window.__player.relay?.id) res();
      else setTimeout(check, 150);
    };
    check();
  }));
  const nextOf = { off: 'on', on: 'smart', smart: 'off' };
  let cur = await A.evaluate(() => window.__player.shuffle);
  log('  A starts at shuffle =', cur);
  const seen = [cur];
  for (let k = 0; k < 3; k += 1) {
    const expect = nextOf[cur];
    await B.evaluate(() => window.__player.cycleShuffle());
    await sleep(2400);
    const as = await A.evaluate(() => window.__player.shuffle);
    const bs = await B.evaluate(() => window.__player.shuffle);
    log(`  ${cur} -> expect ${expect}: A=${as} B=${bs}`);
    assert(as === expect, `A shuffle ${cur}->${expect} (got ${as})`);
    assert(bs === expect, `controller B shows ${expect} (got ${bs})`);
    seen.push(as);
    cur = as;
  }
  assert(seen.includes('off'), 'shuffle returned to OFF during the cycle (toggle-off works)');

  await browser.close();
  console.log(failures ? `\n  ${failures} FAILURE(S)` : '\n  ALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
