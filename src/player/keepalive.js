// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
//
// The media is `keepalive.wav` next to the app (tools/vite-keepalive.js: 20
// minutes of 8 kHz 8-bit mono PCM silence, generated at build), played from
// its URL so the OS seeks it with range requests. Not a 1-second loop: the
// lock screen takes its elapsed time from the element as well as from
// setPositionState, and a loop snapped it to 0 every second. Not blob: media:
// on the iPhone the clock froze at every seek target (mp3 and WAV alike), so
// each re-sync was another snap to 0. Should the clock ever freeze again the
// element is left alone after that and setPositionState carries the time.
let el = null, unlocked = false, wanted = false, armed = false, pending = null, frozen = false, lastT = -1, lastAt = 0;
const log = [];
const note = (m) => { log.push(`${Math.round(performance.now() / 1000)}s${typeof document !== 'undefined' && document.hidden ? ' bg' : ''} ${m}`); if (log.length > 12) log.shift(); };

export const KEEPALIVE_SECONDS = 20 * 60;

function element() {
  if (el) return el;
  el = new Audio(new URL('keepalive.wav', document.baseURI).href);
  el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
  el.addEventListener('loadedmetadata', () => { note(`meta dur=${Math.round(el.duration)}`); if (pending != null) { const p = pending; pending = null; try { el.currentTime = p; } catch { /* not seekable */ } } });
  el.addEventListener('error', () => note(`error ${el.error?.code}`));
  el.addEventListener('playing', () => note(`playing t=${el.currentTime.toFixed(1)}`));
  el.addEventListener('pause', () => note('pause'));
  if (typeof window !== 'undefined') { window.__conduitKeepAlive = el; window.__conduitKeepAliveState = state; } // diagnostics
  return el;
}

function arm() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  const unlock = () => {
    const a = element();
    a.play().then(() => { unlocked = true; note('unlocked'); if (!wanted) a.pause(); off(); }).catch((e) => { note(`unlock ${e?.name}`); });
  };
  const off = () => { for (const t of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(t, unlock, true); armed = false; };
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, unlock, true);
}

// Keep the session alive (true) or let it go (false), at the session's
// position (seconds) so the element's own timeline agrees with the song.
// A remote pause shorter than 2 s (the gap between tracks, a reconnect) does
// not stop the element: every pause/play and every seek is a moment where
// iOS shows the elapsed time as 0, so both are kept rare (seeks only when
// the element is more than 4 s off).
let pauseTimer = null;
export function keepAlive(on, position = 0) {
  if (wanted !== !!on) note(`want ${on ? 'on' : 'off'} @${Math.round(position || 0)}`);
  wanted = !!on;
  const a = element();
  if (wanted) {
    clearTimeout(pauseTimer); pauseTimer = null;
    const p = Math.max(0, (position || 0) % KEEPALIVE_SECONDS);
    // A clock that has not moved in 3 s of "playing" is frozen: no more seeks.
    const now = performance.now();
    if (!a.paused && a.readyState >= 3) {
      if (a.currentTime !== lastT) { if (frozen && lastT >= 0) { frozen = false; note(`moving again at ${a.currentTime.toFixed(1)}`); } lastT = a.currentTime; lastAt = now; }
      else if (!frozen && lastAt && now - lastAt > 3000) { frozen = true; note(`frozen at ${a.currentTime.toFixed(1)}`); }
    }
    if (!frozen && Math.abs((a.currentTime || 0) - p) > 4) {
      note(`seek ${a.currentTime.toFixed(1)} -> ${p.toFixed(1)}`);
      if (a.readyState >= 1) { try { a.currentTime = p; } catch { pending = p; } } else pending = p;
      lastT = -1; lastAt = 0;
    }
    if (a.paused) a.play().then(() => { unlocked = true; }).catch((e) => { note(`play ${e?.name}`); if (!unlocked) arm(); });
  } else if (!a.paused && !pauseTimer) {
    pauseTimer = setTimeout(() => { pauseTimer = null; if (!wanted && !a.paused) a.pause(); }, 2000);
  }
}

export function state() {
  const a = el;
  return { wanted, unlocked, armed, frozen, paused: a ? a.paused : null, t: a ? +a.currentTime.toFixed(1) : null, ready: a?.readyState ?? null, err: a?.error?.code ?? null, log: log.slice(-8) };
}
