// Speakers through the relay. A "desktop" (raw WS client on the LAN) reports a
// BluOS Node. A browser on the same LAN must list the Node in its picker, and
// picking it must send that desktop a transfer naming the Node. When the
// desktop then reports playing on the Node, every client (the browser here)
// shows the green "Playing on Node" bar with the picker on the Node -- not
// "Playing on <desktop name>".

import puppeteer from 'puppeteer';
import WebSocket from 'ws';

const HOST = process.env.CONDUIT_HOST || '192.168.1.85';
const APP = `http://${HOST}:8748`;
const JELLYFIN = `http://${HOST}:2101`;
const USER = 'conduittest'; // dedicated test account: never the real session
const PASS = 'Conduit-Test-9921';
const X = { id: '48202c7882093a3cb6637bd61ac61bd4', title: 'Feeling Like I' };

const log = (...a) => console.log('  ', ...a);
let failures = 0;
const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const res = await fetch(`${JELLYFIN}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="test", Device="test", DeviceId="speaker-test", Version="1"' },
    body: JSON.stringify({ Username: USER, Pw: PASS }),
  });
  return (await res.json()).AccessToken;
}

// Fake desktop that sees a Node. Records commands it receives.
function desktop(tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:8788/relay`);
    const got = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: tok, clientId: 'c_fakedesk', kind: 'desktop', name: 'FAKE DESKTOP' }));
      // Straight behind the hello, BEFORE hello-ok -- exactly what the real
      // client does on reconnect. The relay used to drop this while it was
      // still verifying the token, and the web player never saw the Node.
      ws.send(JSON.stringify({ type: 'devices', devices: [{ id: 'bluos:node', name: 'Node', kind: 'bluos' }] }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello-ok') resolve({ ws, got });
      else if (m.type === 'command') got.push(m.command);
    });
  });
}

async function newClient(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input', { timeout: 10000 });
  const inputs = await page.$$('.login input');
  await inputs[0].type(USER); await inputs[1].type(PASS);
  await page.click('.login .primary');
  await page.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 });
  await sleep(2500);
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
const state = (page) => page.evaluate(() => ({
  title: document.querySelector('.player-title')?.textContent || '',
  green: document.querySelector('.playing-elsewhere')?.textContent || '',
  device: document.querySelector('.devicebtn-name')?.textContent || '',
  playing: document.querySelector('.player-buttons .play')?.title === 'Pause',
}));

async function main() {
  const tok = await token();
  const D = await desktop(tok);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const B = await newClient(browser, 'B');

  log('\n[1] browser lists the Node the desktop reported');
  await B.click('.devicebtn');
  await sleep(300);
  const items = await B.evaluate(() => [...document.querySelectorAll('.deviceitem-name')].map((e) => e.textContent));
  log('picker:', JSON.stringify(items));
  assert(items.includes('Node'), 'Node is in the browser picker');
  assert(items.includes('This Web Player'), 'local entry is "This Web Player"');
  await B.keyboard.press('Escape');

  log('\n[2] browser plays X locally, then picks the Node');
  await play(B, [X.id]);
  await sleep(3000);
  let s = await state(B);
  assert(s.playing && s.title.includes(X.title) && !s.green, `playing locally, no green bar (${JSON.stringify(s)})`);
  await B.click('.devicebtn'); await sleep(300);
  await B.evaluate(() => [...document.querySelectorAll('.deviceitem')].find((b) => b.textContent.includes('Node')).click());
  await sleep(1500);
  const cmd = D.got.find((c) => c.action === 'transfer');
  log('desktop got:', JSON.stringify(cmd));
  assert(cmd && cmd.deviceId === 'bluos:node', 'desktop received transfer naming the Node');
  assert(cmd && cmd.trackIds?.[0] === X.id && cmd.position > 1, 'transfer carries the current track + playhead');
  s = await state(B);
  assert(!s.playing, 'browser stopped its own playback');

  log('\n[3] desktop claims + reports playing on the Node: browser shows "Playing on Node"');
  D.ws.send(JSON.stringify({ type: 'claim' }));
  D.ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: {
    itemId: X.id, title: "Feeling Like I'm Him", artist: 'Heembeezy', albumId: '1382693660311f709793d268d3295437',
    device: { id: 'bluos:node', kind: 'bluos', name: 'Node' },
    playing: true, position: 12, duration: 146, volume: 40, at: Date.now(),
  } }));
  await sleep(1500);
  s = await state(B);
  log('B:', JSON.stringify(s));
  assert(s.green === 'Playing on Node', `green bar says "Playing on Node" (got "${s.green}")`);
  assert(s.device === 'Node', `picker shows Node (got "${s.device}")`);
  assert(s.title.includes(X.title), 'browser mirrors the track');

  log('\n[4] desktop moves to its own output: bar names the desktop again');
  D.ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: {
    itemId: X.id, title: "Feeling Like I'm Him", artist: 'Heembeezy',
    device: { id: 'local', kind: 'local', name: 'This Computer' },
    playing: true, position: 20, duration: 146, volume: 40, at: Date.now(),
  } }));
  await sleep(1500);
  s = await state(B);
  assert(s.green === 'Playing on FAKE DESKTOP', `green bar names the desktop (got "${s.green}")`);
  assert(s.device === 'FAKE DESKTOP', `picker shows the desktop (got "${s.device}")`);

  await browser.close();
  D.ws.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
