// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
let el = null, unlocked = false, wanted = false, armed = false;

// One hand-made MPEG-2 Layer III frame: 8 kbps mono at 16 kHz, no main data
// (part2_3_length 0), so it decodes to exactly 576 zero samples = 36 ms.
// Repeated for an hour that is 3.6 MB of file and a timeline the OS can seek
// in: the lock screen takes its elapsed time from the element as well as
// from setPositionState, so a 1-second loop showed the right time and then
// snapped to 0 every second. The element is kept at the remote position.
const FRAME = Uint8Array.from([0xFF, 0xF3, 0x18, 0xC4, ...new Array(32).fill(0)]);
const FRAME_SECONDS = 576 / 16000;
export const KEEPALIVE_SECONDS = 3600;

function element() {
  if (el) return el;
  const frames = Math.round(KEEPALIVE_SECONDS / FRAME_SECONDS);
  const data = new Uint8Array(frames * FRAME.length);
  for (let i = 0; i < frames; i++) data.set(FRAME, i * FRAME.length);
  el = new Audio(URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' })));
  el.loop = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
  if (typeof window !== 'undefined') window.__conduitKeepAlive = el; // probes
  return el;
}

function arm() {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  const unlock = () => {
    const a = element();
    a.play().then(() => { unlocked = true; if (!wanted) a.pause(); off(); }).catch(() => { /* not a gesture yet */ });
  };
  const off = () => { for (const t of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(t, unlock, true); armed = false; };
  for (const t of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(t, unlock, true);
}

// Keep the session alive (true) or let it go (false), at the session's
// position (seconds) so the element's own timeline agrees with the song.
export function keepAlive(on, position = 0) {
  wanted = !!on;
  const a = element();
  if (wanted) {
    const p = Math.max(0, Math.min(KEEPALIVE_SECONDS - 1, position || 0));
    if (Math.abs((a.currentTime || 0) - p) > 1.5) { try { a.currentTime = p; } catch { /* not seekable yet */ } }
    if (a.paused) a.play().then(() => { unlocked = true; }).catch(() => { if (!unlocked) arm(); });
  } else if (!a.paused) a.pause();
}
