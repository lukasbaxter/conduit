// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
//
// The media is an hour of hand-made silent MPEG-2 Layer III frames (8 kbps
// mono at 16 kHz, no main data: exactly 576 zero samples each, 36 bytes,
// 3.6 MB for the hour; CoreAudio and ffmpeg both decode it to zeros). An
// hour, not a 1-second loop: the lock screen takes its elapsed time from the
// element as well as from setPositionState, and a loop snapped it to 0 every
// second. The element is kept at the session's position. Should the frames
// ever be refused, a 1-second WAV loop takes over so the card still shows.
let el = null, unlocked = false, wanted = false, armed = false, pending = null, fallback = false;
const log = [];
const note = (m) => { log.push(`${Math.round(performance.now() / 1000)}s ${m}`); if (log.length > 12) log.shift(); };

const FRAME = Uint8Array.from([0xFF, 0xF3, 0x18, 0xC4, ...new Array(32).fill(0)]);
const FRAME_SECONDS = 576 / 16000;
export const KEEPALIVE_SECONDS = 3600;

function mp3Url() {
  const frames = Math.round(KEEPALIVE_SECONDS / FRAME_SECONDS);
  const data = new Uint8Array(frames * FRAME.length);
  for (let i = 0; i < frames; i++) data.set(FRAME, i * FRAME.length);
  return URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' }));
}
function wavUrl() {
  // 1 s of 8 kHz 16-bit mono silence.
  const n = 8000, data = new ArrayBuffer(44 + n * 2), v = new DataView(data);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
}

function element() {
  if (el) return el;
  el = new Audio(mp3Url());
  el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
  el.addEventListener('loadedmetadata', () => { note(`meta dur=${Math.round(el.duration)}`); if (pending != null) { const p = pending; pending = null; try { el.currentTime = p; } catch { /* not seekable */ } } });
  el.addEventListener('error', () => {
    note(`error ${el.error?.code}${fallback ? ' (wav)' : ''}`);
    if (fallback) return;
    fallback = true; el.src = wavUrl(); el.load();
    if (wanted) el.play().catch(() => {});
  });
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
    const p = fallback ? 0 : Math.max(0, Math.min(KEEPALIVE_SECONDS - 1, position || 0));
    if (!fallback && Math.abs((a.currentTime || 0) - p) > 4) {
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
  return { wanted, unlocked, armed, fallback, paused: a ? a.paused : null, t: a ? +a.currentTime.toFixed(1) : null, ready: a?.readyState ?? null, err: a?.error?.code ?? null, log: log.slice(-8) };
}
