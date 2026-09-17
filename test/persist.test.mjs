// Persistence test: like from a row heart and add to a playlist from the row
// menu, reload, and check both survived -- in the UI (Liked Songs page,
// playlist page) and in Jellyfin.
import puppeteer from 'puppeteer';
const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest', PASS = process.env.CONDUIT_TEST_PASS || '';
const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page) {
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2000);
}
async function search(page, q) {
  await page.click('.navitem:nth-child(2)');
  await page.waitForSelector('input.search', { timeout: 5000 });
  await page.click('input.search', { clickCount: 3 });
  await page.type('input.search', q);
  await page.waitForSelector('.trackrow', { timeout: 10000 });
  await sleep(800);
}
const jfFav = async (page, id) => page.evaluate(async (id) => {
  const jf = window.__jf; const d = await jf._fetch(`/Items?Ids=${id}&userId=${jf.userId}&Fields=UserData`);
  return d.Items[0]?.UserData?.IsFavorite;
}, id);

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  await login(page);
  const plName = `__conduit_persist_${Date.now().toString(36)}`;

  log('\n[1] like from the row heart');
  await search(page, 'Feeling Like');
  const tid = await page.$eval('.trackrow', (el) => el.querySelector('.trackrow-name span')?.textContent);
  const trackId = await page.evaluate(async () => { const jf = window.__jf; const d = await jf._fetch(`/Items?userId=${jf.userId}&IncludeItemTypes=Audio&Recursive=true&searchTerm=Feeling%20Like&Limit=1`); return d.Items[0].Id; });
  // make sure it starts unliked (server-side), then re-render the rows
  await page.evaluate(async (id) => { await window.__jf.setFavorite(id, false); }, trackId);
  await search(page, 'Feeling Like');
  await (await page.$('.trackrow .trackrow-like')).click();
  await sleep(2000);
  assert(await jfFav(page, trackId) === true, `Jellyfin has "${tid}" favorited after the row heart`);

  log('\n[2] add to a NEW playlist from the row menu');
  const box = await (await page.$('.trackrow')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.ctxmenu-fixed');
  await page.hover('.ctxmenu-fixed .ctxitem');
  await page.waitForSelector('.ctxmenu-sub');
  await page.evaluate(() => [...document.querySelectorAll('.ctxmenu-sub .ctxitem')].find((b) => b.textContent.includes('New playlist')).click());
  await page.waitForSelector('.modal input');
  await page.click('.modal input', { clickCount: 3 }); await page.type('.modal input', plName);
  await page.click('.modal .primary');
  await sleep(2500);
  const pls = await page.evaluate(async () => (await window.__jf.playlists()).items.map((p) => [p.Name, p.ChildCount]));
  const mine = pls.find((p) => p[0] === plName);
  assert(mine && mine[1] === 1, `Jellyfin playlist "${plName}" exists with 1 track (${JSON.stringify(mine)})`);

  log('\n[3] add ANOTHER track to the new playlist from the menu (Jellyfin ignores duplicates)');
  await search(page, 'Under Control');
  await page.waitForFunction(() => document.querySelector('.trackrow .trackrow-name span')?.textContent.includes('Under Control'), { timeout: 10000 });
  const box2 = await (await page.$('.trackrow')).boundingBox();
  const tid2 = await page.$eval('.trackrow', (el) => el.querySelector('.trackrow-name span')?.textContent);
  await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2, { button: 'right' });
  await page.waitForSelector('.ctxmenu-fixed');
  await page.hover('.ctxmenu-fixed .ctxitem');
  await page.waitForSelector('.ctxmenu-sub');
  const clicked = await page.evaluate((n) => { const b = [...document.querySelectorAll('.ctxmenu-sub .ctxitem')].find((x) => x.textContent.trim() === n); if (b) b.click(); return !!b; }, plName);
  assert(clicked, 'new playlist is in the Add to playlist submenu');
  await sleep(2000);
  const cnt = await page.evaluate(async (n) => (await window.__jf.playlists()).items.find((p) => p.Name === n)?.ChildCount, plName);
  assert(cnt === 2, `playlist now has 2 entries (got ${cnt})`);

  log('\n[4] reload: Liked Songs page and playlist page show it');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2500);
  const heartOn = await page.evaluate(() => document.querySelector('.player-like, .footer-like, .trackrow-like')?.classList.contains('on'));
  await page.evaluate(() => [...document.querySelectorAll('.liblist button, .liblist .librow, .liblist *')].find((b) => b.textContent?.trim().startsWith('Liked Songs'))?.click());
  await sleep(2500);
  const likedHas = await page.evaluate((t) => [...document.querySelectorAll('.trackrow .trackrow-name span')].some((e) => e.textContent === t), tid);
  assert(likedHas, 'Liked Songs page lists the track after reload');
  await page.evaluate((n) => [...document.querySelectorAll('.liblist *')].find((b) => b.textContent?.trim().startsWith(n))?.click(), plName);
  await sleep(2500);
  const names = await page.evaluate(() => [...document.querySelectorAll('.trackrow .trackrow-name span')].map((e) => e.textContent));
  assert(names.includes(tid) && names.includes(tid2), `playlist page shows both tracks after reload (${names.join(' | ')})`);

  log('\n[5] rename the playlist through the API the Edit details dialog uses');
  const newName = `${plName}_renamed`;
  const renamed = await page.evaluate(async (n, nn) => { const jf = window.__jf; const p = (await jf.playlists()).items.find((x) => x.Name === n); await jf.renameItem(p.Id, nn); return (await jf.playlists()).items.some((x) => x.Name === nn); }, plName, newName);
  assert(renamed, 'playlist renamed in Jellyfin');

  // cleanup
  await page.evaluate(async (n, id) => { const jf = window.__jf; await jf.setFavorite(id, false); for (const p of (await jf.playlists()).items.filter((x) => x.Name.startsWith(n))) await jf._fetch(`/Items/${p.Id}`, { method: 'DELETE' }).catch(() => {}); }, plName, trackId);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
