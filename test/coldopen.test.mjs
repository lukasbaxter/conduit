// Cold-open recovery test. Simulates the state after a relay restart: an active
// player is genuinely playing but never sent a 'claim' (its claim was forgotten
// when the relay's memory was wiped). A freshly-opened client must STILL grab
// the current playback and show the green bar -- proving the server adopts a
// playing client as active when nobody holds the claim.

import puppeteer from 'puppeteer';
import WebSocket from 'ws';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="test", Device="test", DeviceId="coldopen-A", Version="1"' },
    body: JSON.stringify({ Username: USER, Pw: PASS }),
  });
  return (await res.json()).AccessToken;
}

// Active player that NEVER claims -- only reports nowplaying. Mimics a client
// that was playing before the relay restarted and just reconnected.
function playerNoClaim(tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:8788/relay`);
    let pos = 30;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: tok, kind: 'desktop', name: 'RECOVERED PLAYER' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello-ok') {
        // NO claim on purpose.
        setInterval(() => {
          pos += 1;
          ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: {
            itemId: 'x', title: 'RECOVERY SONG', artist: 'A', position: pos, duration: 300, playing: true, volume: 55, at: Date.now(),
          } }));
        }, 1000);
        resolve({ ws, id: m.clientId });
      }
    });
  });
}

async function main() {
  const tok = await token();
  const A = await playerNoClaim(tok);
  log('active player (no claim) online:', A.id.slice(-4));
  await sleep(2000); // let it report nowplaying a couple times

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(3500);

  const s = await page.evaluate(() => ({
    title: document.querySelector('.player-title')?.textContent || '',
    green: document.querySelector('.playing-elsewhere')?.textContent || '',
    active: (document.querySelector('div[style*="monospace"]')?.textContent.match(/active=(\w+)/) || [])[1] || 'none',
  }));
  log('fresh client:', JSON.stringify(s));
  assert(s.active === A.id.slice(-4), 'server adopted the playing client as active');
  assert(s.title.includes('RECOVERY SONG'), 'fresh client grabbed the current song');
  assert(s.green.includes('Playing on RECOVERED PLAYER'), 'fresh client shows the green bar');

  await browser.close();
  A.ws.close();
  console.log(failures ? `\n  ${failures} FAILURE(S)` : '\n  ALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
