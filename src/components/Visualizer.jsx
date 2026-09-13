import React, { useEffect, useRef, useState } from 'react';

// The visualizer is a graphic-EQ family (audioMotion-analyzer, the spectrum
// engine Feishin ships). Settings come from the full-screen tab's ⋯ menu and
// live in the account's prefs.
//
// Audio source: the local <audio> element when this device plays. When the
// sound is on a speaker or another client, a silent shadow copy of the same
// stream is played in step with the session's playhead and analysed instead
// (its graph has no destination, so nothing is heard twice).
export const EQ_STYLES = [
  // "Line": Feishin's default preset (mode 10 line graph, 1.9px, prism, faint reflection).
  { id: 'line', name: 'Line', opts: { mode: 10, lineWidth: 1.9, fillAlpha: 0, barSpace: .7, reflexRatio: .5, reflexAlpha: .1, reflexBright: 1, showPeaks: false, ledBars: false, lumiBars: false, radial: false, mirror: 0, smoothing: .6, fftSize: 16384, maxFreq: 22050, minFreq: 20, gravity: 11, linearBoost: 4, maxDecibels: -25, minDecibels: -85 } },
  { id: 'area', name: 'Area', opts: { mode: 10, lineWidth: 1.5, fillAlpha: .35, reflexRatio: .4, reflexAlpha: .15, showPeaks: false, ledBars: false, radial: false, mirror: 0, smoothing: .65, fftSize: 8192 } },
  { id: 'led', name: 'LED bars', opts: { mode: 6, ledBars: true, barSpace: .25, reflexRatio: 0, showPeaks: true, radial: false, mirror: 0, lumiBars: false, fillAlpha: 1, lineWidth: 0 } },
  { id: 'bars', name: 'Bars', opts: { mode: 5, ledBars: false, barSpace: .3, reflexRatio: 0, showPeaks: true, radial: false, mirror: 0, roundBars: true, fillAlpha: 1, lineWidth: 0 } },
  { id: 'mirror', name: 'Mirror', opts: { mode: 4, ledBars: false, barSpace: .2, reflexRatio: .5, reflexAlpha: .25, showPeaks: false, radial: false, mirror: -1, fillAlpha: 1, lineWidth: 0 } },
  { id: 'radial', name: 'Radial', opts: { mode: 5, radial: true, spinSpeed: 1, showPeaks: true, barSpace: .2, mirror: 0, reflexRatio: 0, ledBars: false, fillAlpha: 1, lineWidth: 0 } },
];
export const GRADIENTS = ['prism', 'classic', 'rainbow', 'orangered', 'steelblue'];
export const DEFAULT_VIZ = { style: 'line', gradient: 'prism' };
export function loadVizSettings() {
  try { return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem('conduit.viz') || '{}') }; } catch { return { ...DEFAULT_VIZ }; }
}

export default function Visualizer({ player, active, jf, settings }) {
  const boxRef = useRef(null);
  const stageRef = useRef(null);
  const amRef = useRef(null);
  const shadowRef = useRef(null); // { el, ctx, source, id }
  const [state, setState] = useState('loading'); // loading | ready | error
  // Sound comes out of this client only when it is the active player on its
  // own local output. Mirroring another client (a browser playing while you
  // look at the desktop app) counts as remote even if a paused local queue
  // is still around, so the shadow stream is what gets analysed.
  const local = !player.mirroring && player.device?.kind === 'local' && !!player.current;
  const trackId = player.nowPlayingId;
  const cfg = settings || DEFAULT_VIZ;
  const style = EQ_STYLES.find((x) => x.id === cfg.style) || EQ_STYLES[0];

  const shadow = () => {
    if (shadowRef.current) return shadowRef.current;
    const el = new Audio(); el.crossOrigin = 'anonymous'; el.preload = 'auto';
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(el);
    shadowRef.current = { el, ctx, source, id: null };
    return shadowRef.current;
  };
  useEffect(() => () => { const sh = shadowRef.current; if (sh) { sh.el.pause(); sh.el.src = ''; sh.ctx.close?.(); shadowRef.current = null; } }, []);
  // The session playhead as a live clock: the position the player last
  // reported plus the time since. The sync tick below reads THIS, never a
  // position captured when the effect ran -- that copy stood still while the
  // shadow ran on, so every couple of seconds it was dragged back to it and
  // the picture jerked behind the speaker.
  const clockRef = useRef({ pos: 0, at: Date.now(), playing: false });
  clockRef.current = { pos: player.position || 0, at: Date.now(), playing: !!player.playing };
  useEffect(() => {
    if (!active || local) { const sh = shadowRef.current; if (sh) sh.el.pause(); return undefined; }
    const sh = shadow();
    // The original file (byte-range seekable), not a transcode: seeking a live
    // transcode is unreliable and the analyser does not care about bitrate.
    if (trackId && sh.id !== trackId && jf) { sh.id = trackId; sh.el.src = jf.streamUrl(trackId); }
    const want = () => { const c = clockRef.current; return c.pos + (c.playing ? (Date.now() - c.at) / 1000 : 0); };
    const tick = () => {
      const w = want();
      if (Math.abs((sh.el.currentTime || 0) - w) > 0.35) { try { sh.el.currentTime = w; } catch { /* not seekable yet */ } }
      if (player.playing && sh.el.paused) sh.el.play().catch(() => {});
      if (!player.playing && !sh.el.paused) sh.el.pause();
    };
    // Snap as soon as the element can seek, instead of waiting for the next tick.
    const onReady = () => tick();
    sh.el.addEventListener('loadedmetadata', onReady);
    tick();
    const t = setInterval(tick, 500);
    return () => { clearInterval(t); sh.el.removeEventListener('loadedmetadata', onReady); };
  }, [active, local, trackId, player.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const graph = () => { const wa = local ? player.webAudio() : shadow(); wa?.ctx?.resume?.(); return wa; };

  // Graphic EQ engine.
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setState('loading');
    (async () => {
      try {
        const mod = await import('audiomotion-analyzer');
        const AudioMotion = mod.default || mod;
        const wa = graph();
        if (!wa || !alive) { setState('error'); return; }
        const stage = stageRef.current;
        stage.innerHTML = '';
        const am = new AudioMotion(stage, {
          audioCtx: wa.ctx, source: wa.source, connectSpeakers: false,
          overlay: true, bgAlpha: 0, showBgColor: false, showScaleX: false, showScaleY: false,
          smoothing: .7, minFreq: 30, maxFreq: 16000, weightingFilter: 'D', maxFPS: 60,
          ...style.opts, gradient: cfg.gradient,
        });
        amRef.current = am;
        if (window.location.search.includes('debug')) window.__vizAm = am;
        setState('ready');
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, local, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps


  return (
    <div className="viz" ref={boxRef}>
      <div ref={stageRef} className="viz-stage" />
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
    </div>
  );
}
