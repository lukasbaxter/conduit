// Likes: store-driven hearts, relay write-through to Jellyfin, Liked Songs from ids, cross-client, reload.
// Run: node test/likes.test.mjs (hits :8748; APP=http://localhost:5173 for the dev bundle). Uses the conduittest user.
// store-driven hearts, relay write-through to Jellyfin, Liked Songs from ids, cross-client, reload.
import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a); let failures = 0; const assert = (c, m) => { if (c) log('PASS', m); else { failures++; log('FAIL', m); } };
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
const open = async () => { const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1300, height: 900 }); await p.goto(`${process.env.APP || `http://${process.env.CONDUIT_HOST || '192.168.1.85'}:8748`}/?debug=1`, { waitUntil: 'networkidle2' }); const i = await p.$$('.login input'); await i[0].type('conduittest'); await i[1].type(process.env.CONDUIT_TEST_PASS || ''); await p.click('.login .primary'); await p.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 }); await sleep(3000); return p; };
const A = await open(), B = await open();
const ids = await A.evaluate(async () => { const r = await window.__jf.search('daft punk'); const t = r.tracks.slice(0, 3); for (const x of t) await window.__jf.setFavorite(x.Id, false); return t.map((x) => x.Id); });
await sleep(500);
// like via the UI path on A (search row heart)
await A.evaluate(async (id) => { const t = await window.__jf.itemById(id); await window.__onLike(t, true); }, ids[0]);
await sleep(1500);
await A.evaluate(async (id) => { const t = await window.__jf.itemById(id); await window.__onLike(t, true); }, ids[1]);
await sleep(2500);
// B's heart state comes from the store
const bState = await B.evaluate((ids) => ids.map((i) => !!window.__jf.likedAt?.[i]), ids);
assert(bState[0] && bState[1] && !bState[2], `B sees likes [${bState}]`);
// Jellyfin got the favourite (write-through)
const jfFav = await B.evaluate(async (ids) => { const r = await window.__jf._fetch(`/Items?Ids=${ids.join(',')}&userId=${window.__jf.userId}&Fields=UserData`); return r.Items.map((t) => [t.Id, t.UserData?.IsFavorite]); }, ids);
assert(jfFav.filter((x) => x[1]).length === 2, `Jellyfin favourites written through (${JSON.stringify(jfFav)})`);
// Liked Songs page on B: both, newest first, no vanish after a few seconds
await B.evaluate(() => [...document.querySelectorAll('.libitem')].find((e) => e.textContent.includes('Liked Songs')).click());
await sleep(3000);
const rows = await B.evaluate(() => [...document.querySelectorAll('.trackrow')].map((r) => r.querySelector('.trackrow-name > span')?.textContent));
const order = await B.evaluate(() => window.__player && [...document.querySelectorAll('.trackrow')].length);
log('liked page rows', rows.slice(0, 3));
const names = await A.evaluate(async (ids) => (await window.__jf.itemsByIds(ids)).map((t) => t.Name), ids);
assert(rows[0] === names[1] && rows[1] === names[0], 'Liked Songs newest-first with both (B)');
await sleep(6000);
const rows2 = await B.evaluate(() => [...document.querySelectorAll('.trackrow')].map((r) => r.querySelector('.trackrow-name > span')?.textContent));
assert(rows2[0] === rows[0] && rows2[1] === rows[1], 'still there 6 s later (no vanish)');
// unlike on B while page open -> row drops on B and A's store agrees
await B.evaluate(async (id) => { const t = await window.__jf.itemById(id); await window.__onLike(t, false); }, ids[1]);
await sleep(2000);
const rows3 = await B.evaluate(() => [...document.querySelectorAll('.trackrow')].map((r) => r.querySelector('.trackrow-name > span')?.textContent));
assert(rows3[0] === names[0] && !rows3.includes(names[1]), 'unlike drops the row live');
const aSees = await A.evaluate((id) => !!window.__jf.likedAt?.[id], ids[1]);
assert(!aSees, 'A no longer has it');
// reload A: store reloads from relay, heart correct
await A.reload({ waitUntil: 'networkidle2' }); await A.waitForFunction('!!window.__player && !!window.__jf', { timeout: 15000 }); await sleep(3000);
const after = await A.evaluate((ids) => ids.map((i) => !!window.__jf.likedAt?.[i]), ids);
assert(after[0] && !after[1] && !after[2], `after reload A sees [${after}]`);
await A.evaluate(async (ids) => { for (const x of ids) await window.__onLike({ Id: x, _partial: true }, false); }, ids);
log(failures ? `${failures} FAILED` : 'ALL PASS');
await browser.close();
