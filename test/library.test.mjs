// Your Library sidebar: saved albums, right-click menu, drag order persisted + live on another client.
import puppeteer from 'puppeteer';
const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const USER = 'conduittest', PASS = process.env.CONDUIT_TEST_PASS || '';
const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(page) {
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input'); await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 }); await sleep(2500);
}
async function client(browser) { const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.setViewport({ width: 1280, height: 800 }); await login(page); return page; }
const names = (page) => page.evaluate(() => [...document.querySelectorAll('.liblist .libitem .libitem-name')].map((e) => e.textContent));

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const A = await client(browser), B = await client(browser);
  // clean slate: unfavourite all albums, clear order
  await A.evaluate(async () => { const jf = window.__jf; const { items } = await jf.favoriteAlbums(); for (const a of items) await jf.setFavorite(a.Id, false); await jf.setPrefs({ libraryOrder: [] }); });
  await A.reload({ waitUntil: 'networkidle2' }); await A.waitForFunction('!!window.__player', { timeout: 15000 }); await sleep(2000);

  log('\n[1] save an album from its page');
  await A.click('.shortcut:nth-child(2)'); await sleep(2500);
  const albumName = await A.evaluate(() => document.querySelector('.hero h1')?.textContent);
  await A.click('.actions .iconbtn[title="Save to Your Library"]'); await sleep(2500);
  let n = await names(A); log('A sidebar:', n.join(' | '));
  assert(n.includes(albumName), `album "${albumName}" appears in A's library`);
  const nb = await names(B); log('B sidebar:', nb.join(' | '));
  assert(nb.includes(albumName), 'B got it live over the relay');

  log('\n[2] right-click menu on the album entry');
  const el = await A.evaluateHandle((nm) => [...document.querySelectorAll('.liblist .libitem')].find((b) => b.textContent.includes(nm)), albumName);
  const box = await el.boundingBox();
  await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' }); await sleep(400);
  const items = await A.$$eval('.ctxmenu-fixed .ctx-label', (els) => els.map((e) => e.textContent));
  log('menu:', items.join(' | '));
  assert(items.includes('Play') && items.includes('Remove from Your Library'), 'album menu has Play / Remove');
  await A.keyboard.press('Escape');

  log('\n[3] drag the album above the first playlist; order persists and B follows');
  const before = await names(A);
  const src = await A.evaluateHandle((nm) => [...document.querySelectorAll('.liblist .libitem')].find((b) => b.textContent.includes(nm)), albumName);
  const dst = await A.evaluateHandle(() => [...document.querySelectorAll('.liblist .libitem')].filter((b) => !/Liked Songs/.test(b.textContent))[0]);
  const sb = await src.boundingBox(), db = await dst.boundingBox();
  if (sb && db) {
    // HTML5 DnD via synthetic events (puppeteer's mouse does not fire dragstart reliably)
    await A.evaluate((nm) => {
      const items = [...document.querySelectorAll('.liblist .libitem')].filter((b) => !/Liked Songs/.test(b.textContent));
      const from = items.find((b) => b.textContent.includes(nm)); const to = items[0];
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, albumName);
    await sleep(2000);
    const after = await names(A); log('A after drag:', after.join(' | '));
    assert(after.join() !== before.join() && after.indexOf(albumName) === 1, 'album moved above the playlist');
    const saved = await A.evaluate(async () => (await window.__jf.getPrefs()).libraryOrder);
    assert(Array.isArray(saved) && saved.length >= 2, 'order saved on the account');
    const bAfter = await names(B); assert(bAfter.join() === after.join(), 'B shows the same order live');
  } else { log('skip drag (not enough entries)'); }

  // cleanup
  await A.evaluate(async () => { const jf = window.__jf; const { items } = await jf.favoriteAlbums(); for (const a of items) await jf.setFavorite(a.Id, false); await jf.setPrefs({ libraryOrder: [] }); });
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
