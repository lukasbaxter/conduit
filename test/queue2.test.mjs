// Queue panel: Add to queue lands right after the current track, sections split, remove/move/clear work.
import puppeteer from 'puppeteer';
const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const USER = 'conduittest', PASS = 'Conduit-Test-9921';
const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = '/private/tmp/claude-501/-Users-lukasbaxter/04f2cfb8-74c1-482e-a813-f284c03a3c31/scratchpad';
async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', (e) => log('pageerror', e.message));
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  const inputs = await page.$$('.login input'); await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 }); await sleep(2000);
  // play an album (context) then add two searched tracks to the queue
  await page.evaluate(async () => { const jf = window.__jf; const al = (await jf.albums({ limit: 40 })).items.find((a) => (a.ChildCount || 0) >= 6); const { items } = await jf.tracks({ albumId: al.Id }); window.__player.playQueue(items, 0, al.Id); });
  await sleep(2500);
  await page.evaluate(async () => { const jf = window.__jf; const d = await jf._fetch(`/Items?userId=${jf.userId}&IncludeItemTypes=Audio&Recursive=true&searchTerm=Get%20Lucky&Limit=2&Fields=ArtistItems,AlbumArtists,UserData`); window.__player.addToQueue(d.Items); });
  await sleep(800);
  await page.click('.player-right .icon-btn[title="Queue"]'); await sleep(800);
  const heads = await page.$$eval('.panel-body .section-head h2', (els) => els.map((e) => e.textContent));
  log('sections:', heads.join(' | '));
  assert(heads[0] === 'Now playing' && heads[1] === 'Next in queue' && /^Next from: /.test(heads[2] || ''), 'three sections in Spotify order');
  const q = await page.evaluate(() => window.__player.queue.map((t) => t._queued ? 'Q' : 'c').join(''));
  log('queue shape:', q);
  assert(/^cQQc/.test(q), 'queued tracks sit right after the current one');
  await page.screenshot({ path: `${OUT}/s_queue.png` });
  // remove the first queued via menu
  const rows = await page.$$('.panel-body .qrow');
  const r1 = rows[1]; const bb = await r1.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: 'right' }); await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.ctxmenu-fixed .ctxitem')].find((b) => b.textContent.includes('Remove from queue')).click()); await sleep(500);
  const q2 = await page.evaluate(() => window.__player.queue.map((t) => t._queued ? 'Q' : 'c').join(''));
  assert(/^cQc/.test(q2), `removed one queued track (${q2})`);
  await page.evaluate(() => window.__player.clearQueued()); await sleep(400);
  const q3 = await page.evaluate(() => window.__player.queue.map((t) => t._queued ? 'Q' : 'c').join(''));
  assert(!q3.includes('Q'), `clear queue emptied the queued section (${q3.slice(0, 6)}…)`);
  await page.evaluate(() => window.__player.moveInQueue(3, 1)); await sleep(300);
  const names = await page.evaluate(() => window.__player.queue.slice(0, 4).map((t) => t.Name));
  log('after move:', names.join(' | '));
  await page.evaluate(() => window.__player.toggle());
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
