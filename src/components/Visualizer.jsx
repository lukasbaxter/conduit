import React, { useEffect, useRef, useState } from 'react';

// The visualizer has two engines: a graphic-EQ family (audioMotion-analyzer,
// the spectrum engine Feishin ships) and Milkdrop (butterchurn). Settings
// come from the full-screen tab's ⋯ menu and persist in localStorage.
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
export const DEFAULT_VIZ = { engine: 'eq', style: 'line', gradient: 'prism', cycle: true };
export function loadVizSettings() {
  try { return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem('conduit.viz') || '{}') }; } catch { return { ...DEFAULT_VIZ }; }
}

export default function Visualizer({ player, active, jf, settings, nextPresetSignal = 0 }) {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);
  const stageRef = useRef(null);
  const vizRef = useRef(null);
  const amRef = useRef(null);
  const shadowRef = useRef(null); // { el, ctx, source, id }
  const [state, setState] = useState('loading'); // loading | ready | error
  const [presetName, setPresetName] = useState('');
  const local = player.device?.kind === 'local' && !!player.current;
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
  useEffect(() => {
    if (!active || local) { const sh = shadowRef.current; if (sh) sh.el.pause(); return undefined; }
    const sh = shadow();
    if (trackId && sh.id !== trackId && jf) { sh.id = trackId; sh.el.src = jf.playbackUrl(trackId); }
    const tick = () => {
      const want = player.position || 0;
      if (Math.abs((sh.el.currentTime || 0) - want) > 1.5) { try { sh.el.currentTime = want; } catch { /* not seekable yet */ } }
      if (player.playing && sh.el.paused) sh.el.play().catch(() => {});
      if (!player.playing && !sh.el.paused) sh.el.pause();
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [active, local, trackId, player.playing, Math.floor(player.position / 5)]); // eslint-disable-line react-hooks/exhaustive-deps

  const graph = () => { const wa = local ? player.webAudio() : shadow(); wa?.ctx?.resume?.(); return wa; };

  // Graphic EQ engine.
  useEffect(() => {
    if (!active || cfg.engine !== 'eq') return undefined;
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
        setPresetName(style.name);
        setState('ready');
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, local, cfg.engine, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Milkdrop engine.
  const nextRef = useRef(null);
  useEffect(() => {
    if (!active || cfg.engine !== 'milkdrop') return undefined;
    let alive = true, raf = 0, cycle = 0;
    setState('loading');
    (async () => {
      try {
        const [bc, bcp] = await Promise.all([import('butterchurn'), import('butterchurn-presets')]);
        const butterchurn = bc.default || bc;
        const presets = (bcp.default || bcp).getPresets();
        const names = Object.keys(presets);
        const wa = graph();
        if (!wa || !alive) { setState('error'); return; }
        const canvas = canvasRef.current, box = boxRef.current;
        const size = () => { const r = box.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; return r; };
        const r = size();
        const viz = butterchurn.createVisualizer(wa.ctx, canvas, { width: r.width * devicePixelRatio, height: r.height * devicePixelRatio, pixelRatio: devicePixelRatio, textureRatio: 1 });
        viz.connectAudio(wa.source);
        let i = Math.floor(Math.random() * names.length);
        const load = (blend) => { viz.loadPreset(presets[names[i]], blend); setPresetName(names[i]); };
        load(0);
        nextRef.current = () => { i = (i + 1) % names.length; load(1.5); };
        if (cfg.cycle) cycle = setInterval(() => nextRef.current?.(), 25000);
        const ro = new ResizeObserver(() => { const rr = size(); viz.setRendererSize(rr.width * devicePixelRatio, rr.height * devicePixelRatio); });
        ro.observe(box);
        const frame = () => { if (!alive) return; viz.render(); raf = requestAnimationFrame(frame); };
        raf = requestAnimationFrame(frame);
        setState('ready');
        vizRef.current = { viz, ro };
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); clearInterval(cycle); vizRef.current?.ro?.disconnect?.(); vizRef.current = null; nextRef.current = null; };
  }, [active, local, cfg.engine, cfg.cycle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (nextPresetSignal) nextRef.current?.(); }, [nextPresetSignal]);

  const md = cfg.engine === 'milkdrop';
  return (
    <div className="viz" ref={boxRef} onClick={() => md && nextRef.current?.()} title={md ? 'Click for the next preset' : undefined} style={{ cursor: md ? 'pointer' : 'default' }}>
      <div ref={stageRef} className="viz-stage" style={{ display: md ? 'none' : 'block' }} />
      <canvas ref={canvasRef} className="viz-canvas" style={{ display: md ? 'block' : 'none' }} />
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
      {state === 'ready' && md && presetName && <div className="viz-preset">{presetName}</div>}
    </div>
  );
}
