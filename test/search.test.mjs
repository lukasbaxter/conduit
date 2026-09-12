// Search through the relay/Meilisearch: typos, lyrics, top result, keyboard.
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

  const q = async (text) => {
    await page.click('.navitem:nth-child(2)'); await page.waitForSelector('input.search');
    await page.click('input.search', { clickCount: 3 }); await page.keyboard.press('Backspace');
    await page.type('input.search', text, { delay: 20 });
    await page.waitForFunction(() => document.querySelector('.search-took'), { timeout: 8000 }); await sleep(400);
    return page.evaluate(() => ({
      took: document.querySelector('.search-took')?.textContent,
      top: document.querySelector('.topresult h3')?.textContent, topKind: document.querySelector('.topresult .kind b')?.textContent,
      songs: [...document.querySelectorAll('.searchgrid .trackrow .trackrow-name > span')].map((e) => e.textContent),
      snippets: [...document.querySelectorAll('.lyric-snippet')].map((e) => e.textContent.slice(0, 60)),
      artists: [...document.querySelectorAll('.grid .card.round .card-title')].map((e) => e.textContent).slice(0, 3),
    }));
  };

  log('\n[1] typo: "dft punk"');
  let r = await q('dft punk'); log(JSON.stringify(r));
  assert(r.top === 'Daft Punk' && r.topKind === 'Artist', 'Daft Punk is the Top result despite the typo');
  assert(r.took && /ms$/.test(r.took) && parseInt(r.took) < 300, `engine answered fast (${r.took})`);

  log('\n[2] typing "daft" letter by letter keeps Daft Punk');
  r = await q('daft'); assert(r.top === 'Daft Punk', 'daft -> Daft Punk');

  log('\n[3] lyric line: "up all night to get lucky"');
  r = await q('up all night to get lucky'); log(JSON.stringify(r));
  assert(r.songs[0] === 'Get Lucky', 'Get Lucky is the first song');
  assert(r.snippets.some((s) => /night/i.test(s)), 'a lyric snippet is shown');

  log('\n[4] accent: "beyonce"');
  r = await q('beyonce'); assert(r.top === 'Beyoncé', `top is Beyoncé (${r.top})`);

  log('\n[5] Enter plays the top song');
  await q('sit next to me');
  await page.keyboard.press('Enter'); await sleep(2500);
  const np = await page.evaluate(() => document.querySelector('.player-title')?.textContent);
  assert(np === 'Sit Next to Me', `Enter played it (${np})`);
  await page.evaluate(() => window.__player.toggle());
  await page.screenshot({ path: `${OUT}/s_search.png` });
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
