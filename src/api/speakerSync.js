// Speaker sync: measure how far the sound in the room is from the shadow
// stream the visualizer analyses, by listening with the microphone.
//
// Both signals are reduced to a loudness envelope (RMS per 512-sample block,
// ~10 ms), log-compressed, high-passed so onsets dominate, then cross-
// correlated over +-maxLag. The lag with the strongest correlation is how
// much LATER the room is than the reference; the caller shifts its clock by
// that much. Nothing about the speaker is assumed; the number comes from the
// air.

const BLOCK = 512;

function envelopeRecorder(ctx, source) {
  const proc = ctx.createScriptProcessor(BLOCK, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0; // the processor must reach the destination to run
  const t = [], v = [];
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let s = 0; for (let i = 0; i < d.length; i += 1) s += d[i] * d[i];
    t.push(e.playbackTime); v.push(Math.sqrt(s / d.length));
  };
  source.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  return { t, v, stop: () => { try { source.disconnect(proc); proc.disconnect(); mute.disconnect(); } catch { /* already gone */ } } };
}

// Envelope on a common grid (index = block number since t0), log-compressed,
// minus a 0.5 s moving mean, unit variance.
function shape(rec, t0, bin, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < rec.t.length; i += 1) { const k = Math.round((rec.t[i] - t0) / bin); if (k >= 0 && k < n) out[k] = Math.log1p(rec.v[i] * 60); }
  const w = Math.max(1, Math.round(0.5 / bin)); const hp = new Float32Array(n);
  let acc = 0; for (let i = 0; i < n; i += 1) { acc += out[i]; if (i >= w) acc -= out[i - w]; hp[i] = out[i] - acc / Math.min(w, i + 1); }
  let m = 0; for (let i = 0; i < n; i += 1) m += hp[i]; m /= n;
  let s = 0; for (let i = 0; i < n; i += 1) { hp[i] -= m; s += hp[i] * hp[i]; }
  s = Math.sqrt(s / n) || 1; for (let i = 0; i < n; i += 1) hp[i] /= s;
  return hp;
}

/**
 * Record `seconds` of the reference (`refSource`, the shadow stream's node)
 * and the microphone on the SAME AudioContext, then find the room's lag.
 * Resolves { lag, score, level } -- lag in seconds (positive = the room is
 * behind the reference), score = normalised correlation peak (0..1), level =
 * mean mic RMS (to tell silence from a bad match).
 */
export async function measureSpeakerLag({ ctx, refSource, seconds = 8, maxLag = 4, signal } = {}) {
  // Desktop: macOS needs the app to ask before the mic carries any sound.
  if (window.conduit?.askMic) {
    const status = await window.conduit.askMic().catch(() => 'granted');
    if (status && status !== 'granted') throw new Error(status === 'denied' ? 'NotAllowed: microphone denied in System Settings > Privacy > Microphone' : `microphone ${status}`);
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const track = stream.getAudioTracks()[0];
  if (!track || track.muted || track.readyState !== 'live') throw new Error('microphone track is muted');
  const mic = ctx.createMediaStreamSource(stream);
  await ctx.resume?.();
  const ref = envelopeRecorder(ctx, refSource), room = envelopeRecorder(ctx, mic);
  try {
    await new Promise((ok, no) => { const t = setTimeout(ok, seconds * 1000); signal?.addEventListener('abort', () => { clearTimeout(t); no(new Error('aborted')); }); });
  } finally {
    ref.stop(); room.stop();
    stream.getTracks().forEach((tr) => tr.stop());
  }
  return lagFromRecordings(ref, room, ctx.sampleRate, maxLag);
}

// Pure part, so it can be tested with synthetic envelopes.
export function lagFromRecordings(ref, room, sampleRate, maxLag = 4) {
  if (ref.t.length < 50 || room.t.length < 50) throw new Error('not enough audio');
  const bin = BLOCK / sampleRate;
  const t0 = Math.max(ref.t[0], room.t[0]);
  const n = Math.floor((Math.min(ref.t[ref.t.length - 1], room.t[room.t.length - 1]) - t0) / bin);
  const a = shape(ref, t0, bin, n), b = shape(room, t0, bin, n);
  const L = Math.round(maxLag / bin);
  const corr = new Float32Array(2 * L + 1);
  let best = -Infinity, bestLag = 0;
  for (let lag = -L; lag <= L; lag += 1) {
    let c = 0, cnt = 0;
    for (let i = Math.max(0, lag); i < n && i - lag < n; i += 1) { c += b[i] * a[i - lag]; cnt += 1; }
    c /= cnt || 1; corr[lag + L] = c;
    if (c > best) { best = c; bestLag = lag; }
  }
  // Runner-up outside the peak's own slope (+-150 ms): how unambiguous the match is.
  const guard = Math.round(0.15 / bin); let second = -Infinity;
  for (let lag = -L; lag <= L; lag += 1) if (Math.abs(lag - bestLag) > guard && corr[lag + L] > second) second = corr[lag + L];
  const level = room.v.reduce((s, x) => s + x, 0) / room.v.length;
  return { lag: bestLag * bin, score: best, margin: best - second, level, refLevel: ref.v.reduce((s2, x) => s2 + x, 0) / ref.v.length };
}
