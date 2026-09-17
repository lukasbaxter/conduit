// Settings: theme persists on the account and reaches another open client live.
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
const accent = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());

async function main() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const A = await client(browser), B = await client(browser);
  // reset to default via the API first
  await A.evaluate(async () => { await window.__jf.setPrefs({ theme: { accent: '#1ed760', bg: '#121212', surface: '#1f1f1f', fg: '#ffffff' }, quality: 'original' }); });

  log('\n[1] open Settings from the avatar menu');
  await A.click('.avatar'); await sleep(300);
  await A.evaluate(() => [...document.querySelectorAll('.avatarmenu button')].find((b) => b.textContent === 'Settings').click());
  await A.waitForSelector('.settings', { timeout: 5000 });
  assert(!!(await A.$('.theme-presets')), 'settings page shows themes');

  log('\n[2] pick the Midnight preset on A: A repaints, B follows live, Jellyfin has it');
  await A.evaluate(() => [...document.querySelectorAll('.theme-preset')].find((b) => b.textContent.includes('Midnight')).click());
  await sleep(1500);
  assert((await accent(A)) === '#4c8dff', `A accent is Midnight blue (${await accent(A)})`);
  assert((await accent(B)) === '#4c8dff', `B accent followed over the relay (${await accent(B)})`);
  const saved = await A.evaluate(async () => (await window.__jf.getPrefs()).theme?.accent);
  assert(saved === '#4c8dff', `saved on the account (${saved})`);

  log('\n[3] a fresh client opens with the saved theme');
  const C = await client(browser);
  assert((await accent(C)) === '#4c8dff', `C painted from the account (${await accent(C)})`);

  log('\n[4] quality select persists');
  await A.select('.settings-field select', 'high'); await sleep(1200);
  const q = await A.evaluate(async () => (await window.__jf.getPrefs()).quality);
  assert(q === 'high', `quality saved (${q})`);
  assert(await A.evaluate(() => window.__jf.playbackUrl('x').includes('audioBitRate=320000')), 'local playback URL is the 320k transcode');

  // reset
  await A.evaluate(() => [...document.querySelectorAll('.theme-preset')].find((b) => b.textContent.includes('Spotify')).click());
  await A.select('.settings-field select', 'original'); await sleep(1000);
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
