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
export const DEFAULT_VIZ = { engine: 'eq', style: 'line', gradient: 'prism', cycle: true, favorites: [], favOnly: false };
// Only presets that actually listen to the music are offered. A preset is
// reactive when its equations/shaders read the audio levels several times, or
// at least once while also drawing a visible base waveform.
const AUDIO_VARS = /\b(bass|mid|treb|bass_att|mid_att|treb_att|vol|vol_att)\b/g;
export function isReactivePreset(preset) {
  const refs = (JSON.stringify(preset).match(AUDIO_VARS) || []).length;
  const wave = preset?.baseVals?.wave_a ?? 0;
  return refs >= 3 || (refs >= 1 && wave >= 0.1);
}
export function loadVizSettings() {
  try { return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem('conduit.viz') || '{}') }; } catch { return { ...DEFAULT_VIZ }; }
}

export default function Visualizer({ player, active, jf, settings, nextPresetSignal = 0, onPreset, controls, sharedViz, onShareViz }) {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);
  const stageRef = useRef(null);
  const vizRef = useRef(null);
  const amRef = useRef(null);
  const shadowRef = useRef(null); // { el, ctx, source, id }
  const [state, setState] = useState('loading'); // loading | ready | error
  const [presetName, setPresetName] = useState('');
  // Sound comes out of this client only when it is the active player on its
  // own local output. Mirroring another client (a browser playing while you
  // look at the desktop app) counts as remote even if a paused local queue
  // is still around, so the shadow stream is what gets analysed.
  const local = !player.mirroring && player.device?.kind === 'local' && !!player.current;
  const trackId = player.nowPlayingId;
  const cfg = settings || DEFAULT_VIZ;
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
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
        if (window.location.search.includes('debug')) window.__vizAm = am;
        setPresetName(style.name);
        setState('ready');
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, local, cfg.engine, style.id, cfg.gradient]); // eslint-disable-line react-hooks/exhaustive-deps

  // Milkdrop engine.
  const nextRef = useRef(null);
  const followRef = useRef(null);
  const sharedRef = useRef(sharedViz); sharedRef.current = sharedViz;
  // Another client moved to a preset: show the same one here.
  useEffect(() => { if (sharedViz?.preset) followRef.current?.(sharedViz.preset); }, [sharedViz]);
  useEffect(() => {
    if (!active || cfg.engine !== 'milkdrop') return undefined;
    let alive = true, raf = 0, cycle = 0;
    setState('loading');
    (async () => {
      try {
        const [bc, bcp] = await Promise.all([import('butterchurn'), import('butterchurn-presets')]);
        const butterchurn = bc.default || bc;
        const presets = (bcp.default || bcp).getPresets();
        const names = Object.keys(presets).filter((n) => isReactivePreset(presets[n]));
        const wa = graph();
        if (!wa || !alive) { setState('error'); return; }
        const canvas = canvasRef.current, box = boxRef.current;
        const size = () => { const r = box.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; return r; };
        const r = size();
        const viz = butterchurn.createVisualizer(wa.ctx, canvas, { width: r.width * devicePixelRatio, height: r.height * devicePixelRatio, pixelRatio: devicePixelRatio, textureRatio: 1 });
        viz.connectAudio(wa.source);
        // The pool is every preset, or only the saved favourites when asked.
        const pool = () => { const f = (cfgRef.current.favOnly && cfgRef.current.favorites?.filter((n) => presets[n])) || []; return f.length ? f : names; };
        let current = '';
        // Cycling is a resettable timer so a preset arriving from another client
        // restarts the wait here instead of stacking a second advance on top.
        const arm = () => { clearTimeout(cycle); if (cfgRef.current.cycle) cycle = setTimeout(() => nextRef.current?.(), 25000 + Math.random() * 3000); };
        const load = (name, blend, share = true) => {
          if (!presets[name] || name === current) return;
          current = name; viz.loadPreset(presets[name], blend); setPresetName(name); onPreset?.(name);
          if (share) onShareViz?.(name);
          arm();
        };
        // Start on what the account's other screens show, else pick at random.
        const shared = sharedRef.current;
        if (shared?.preset && presets[shared.preset]) load(shared.preset, 0, false);
        else { const start = pool(); load(start[Math.floor(Math.random() * start.length)], 0); }
        nextRef.current = () => { const list = pool(); const i = list.indexOf(current); load(list[(i + 1) % list.length], 1.5); };
        followRef.current = (name) => load(name, 1.5, false);
        if (controls) controls.current = { next: () => nextRef.current?.(), load: (name) => load(name, 1.5), names };
        let last = `${r.width}x${r.height}`;
        const ro = new ResizeObserver(() => { const b2 = box.getBoundingClientRect(); const k = `${b2.width}x${b2.height}`; if (k === last) return; last = k; const rr = size(); viz.setRendererSize(rr.width * devicePixelRatio, rr.height * devicePixelRatio); });
        ro.observe(box);
        const frame = () => { if (!alive) return; viz.render(); raf = requestAnimationFrame(frame); };
        raf = requestAnimationFrame(frame);
        setState('ready');
        vizRef.current = { viz, ro };
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(cycle); vizRef.current?.ro?.disconnect?.(); vizRef.current = null; nextRef.current = null; followRef.current = null; if (controls) controls.current = null; onPreset?.(''); };
  }, [active, local, cfg.engine, cfg.cycle]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (nextPresetSignal) nextRef.current?.(); }, [nextPresetSignal]);

  const md = cfg.engine === 'milkdrop';
  return (
    <div className="viz" ref={boxRef} onClick={() => md && nextRef.current?.()} title={md ? 'Click for the next preset' : undefined} style={{ cursor: md ? 'pointer' : 'default' }}>
      <div ref={stageRef} className="viz-stage" style={{ display: md ? 'none' : 'block' }} />
      <canvas ref={canvasRef} className="viz-canvas" style={{ display: md ? 'block' : 'none' }} />
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
      {state === 'ready' && md && presetName && <div className="viz-preset"><span>{presetName}</span></div>}
    </div>
  );
}
