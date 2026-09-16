// Silent looping <audio> that keeps a Media Session alive while the music
// plays somewhere else (another client, or a speaker driven from here). The
// lock screen, Control Center, AirPods and the Mac's Now Playing widget only
// show a page's session while that page has playing media, so this is what
// makes the remote session show up there and take its controls. iOS lets a
// media element be started only inside a user gesture; the first tap on the
// page unlocks this one (play, then pause unless it is wanted), after which
// it can be started at any time.
let el = null, unlocked = false, wanted = false, armed = false;

function element() {
  if (el) return el;
  // 1 s of 8 kHz 16-bit mono silence in a WAV container.
  const n = 8000, data = new ArrayBuffer(44 + n * 2), v = new DataView(data);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  el = new Audio(URL.createObjectURL(new Blob([data], { type: 'audio/wav' })));
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

// Keep the session alive (true) or let it go (false).
export function keepAlive(on) {
  wanted = !!on;
  const a = element();
  if (wanted) {
    if (a.paused) a.play().then(() => { unlocked = true; }).catch(() => { if (!unlocked) arm(); });
  } else if (!a.paused) a.pause();
}
