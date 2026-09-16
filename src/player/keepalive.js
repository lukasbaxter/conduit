// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
//
// The media is 20 minutes of 8 kHz 8-bit mono PCM silence in a WAV (9.6 MB
// as a Blob). Not a 1-second loop: the lock screen takes its elapsed time
// from the element as well as from setPositionState, and a loop snapped it
// to 0 every second. Not a compact hand-made mp3 either: on the iPhone that
// one never advanced after a seek (currentTime frozen at the seek target),
// so every re-sync was another snap to 0. PCM seeks by byte offset and just
// plays. The element is kept at the session's position.
let el = null, unlocked = false, wanted = false, armed = false, pending = null;
const log = [];
const note = (m) => { log.push(`${Math.round(performance.now() / 1000)}s ${m}`); if (log.length > 12) log.shift(); };

export const KEEPALIVE_SECONDS = 20 * 60;

function wavUrl() {
  const rate = 8000, n = KEEPALIVE_SECONDS * rate, data = new ArrayBuffer(44 + n), v = new DataView(data);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(data, 44).fill(128); // 8-bit PCM is unsigned: 128 is silence
  return URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
}

function element() {
  if (el) return el;
  el = new Audio(wavUrl());
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
    if (Math.abs((a.currentTime || 0) - p) > 4) {
      note(`seek ${a.currentTime.toFixed(1)} -> ${p.toFixed(1)}`);
      if (a.readyState >= 1) { try { a.currentTime = p; } catch { pending = p; } } else pending = p;
    }
    if (a.paused) a.play().then(() => { unlocked = true; }).catch((e) => { note(`play ${e?.name}`); if (!unlocked) arm(); });
  } else if (!a.paused && !pauseTimer) {
    pauseTimer = setTimeout(() => { pauseTimer = null; if (!wanted && !a.paused) a.pause(); }, 2000);
  }
}

export function state() {
  const a = el;
  return { wanted, unlocked, armed, paused: a ? a.paused : null, t: a ? +a.currentTime.toFixed(1) : null, ready: a?.readyState ?? null, err: a?.error?.code ?? null, log: log.slice(-8) };
}
