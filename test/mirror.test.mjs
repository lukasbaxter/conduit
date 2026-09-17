// Headless sync test. Stands up:
//   A) a raw WebSocket client that is the ACTIVE player, reporting a track with
//      an advancing playhead.
//   B) a real Conduit app instance in headless Chromium (the deployed LAN
//      build), logged in as the same user.
// Then it reads B's actual on-screen state and asserts B MIRRORS A: same song,
// advancing playhead, same volume. This is the exact "footer identical and
// live" requirement, tested against the real running code.

import puppeteer from 'puppeteer';
import WebSocket from 'ws';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = process.env.CONDUIT_TEST_PASS || '';

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (cond, msg) => { if (cond) log('PASS', msg); else { failures++; log('FAIL', msg); } };

async function token() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="test", Device="test", DeviceId="mirror-test-A", Version="1"' },
    body: JSON.stringify({ Username: USER, Pw: PASS }),
  });
  const d = await res.json();
  return d.AccessToken;
}

// Client A: raw active player.
function activePlayer(tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:8788/relay`);
    let pos = 20;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: tok, kind: 'desktop', name: 'PLAYER A' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello-ok') {
        ws.send(JSON.stringify({ type: 'claim' }));
        setInterval(() => {
          pos += 1;
          ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: {
            itemId: 'test-item', title: 'MIRROR TEST SONG', artist: 'Test Artist',
            position: pos, duration: 300, playing: true, volume: 42, at: Date.now(),
          } }));
        }, 1000);
        resolve({ ws, id: m.clientId });
      }
    });
  });
}

async function main() {
  const tok = await token();
  log('got token', tok.slice(0, 8) + '...');
  const A = await activePlayer(tok);
  log('client A (active player) online:', A.id.slice(-4));
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.text().startsWith('[b]')) log('browser:', m.text()); });

  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });

  // Log in (fresh context -> login form).
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  if (inputs.length >= 2) {
    await inputs[0].type(USER);
    await inputs[1].type(PASS);
    await page.click('.login .primary');
    log('submitted login');
  } else {
    log('already logged in (session restored)');
  }

  // Wait for the app shell + relay to settle.
  await page.waitForSelector('.player', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4000));

  // Read the debug overlay + the actual footer title.
  const read = () => page.evaluate(() => {
    const dbg = document.querySelector('div[style*="monospace"]')?.textContent || '';
    const title = document.querySelector('.player-title')?.textContent || '';
    const t = [...document.querySelectorAll('.player-seek .t')].map((e) => e.textContent);
    const vol = document.querySelector('.player-volume input')?.value;
    const greenBar = document.querySelector('.playing-elsewhere')?.textContent || '';
    return { dbg, title, timeLabels: t, vol, greenBar };
  });

  const s1 = await read();
  log('overlay:', JSON.stringify(s1.dbg));
  log('footer title:', JSON.stringify(s1.title), '| time:', s1.timeLabels, '| vol:', s1.vol);

  assert(s1.dbg.includes(`active=${A.id.slice(-4)}`), 'B sees A as the active player');
  assert(/MIRROR TEST SONG/.test(s1.title) || /MIRROR TEST SONG/.test(s1.dbg), 'B footer shows A\'s song');
  assert(String(s1.vol) === '42', 'B volume mirrors A (42)');
  log('green bar:', JSON.stringify(s1.greenBar));
  assert(/Playing on PLAYER A/.test(s1.greenBar), 'B shows green "Playing on PLAYER A" bar');

  // Playhead should advance between two reads.
  await new Promise((r) => setTimeout(r, 3000));
  const s2 = await read();
  log('time after 3s:', s2.timeLabels);
  const p1 = parseTime(s1.timeLabels[0]);
  const p2 = parseTime(s2.timeLabels[0]);
  assert(p2 > p1, `B playhead advances (${s1.timeLabels[0]} -> ${s2.timeLabels[0]})`);

  await browser.close();
  A.ws.close();
  console.log(failures ? `\n  ${failures} FAILURE(S)` : '\n  ALL PASSED');
  process.exit(failures ? 1 : 0);
}

function parseTime(s) {
  if (!s) return -1;
  const [m, sec] = s.split(':').map(Number);
  return m * 60 + sec;
}

main().catch((e) => { console.error(e); process.exit(1); });
