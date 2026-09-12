import React, { useEffect, useRef, useState } from 'react';

// Graphic-EQ style visualizer (audioMotion-analyzer, the spectrum engine
// Feishin ships next to its Milkdrop one), with Milkdrop (butterchurn) kept
// as the last style in the cycle. Click the stage to cycle styles.
//
// Audio source: the local <audio> element when this device plays. When the
// sound is on a speaker or another client, a silent shadow copy of the same
// stream is played in step with the session's playhead and analysed instead
// (its graph has no destination, so nothing is heard twice).
const STYLES = [
  { id: 'led', name: 'LED bars', opts: { mode: 6, ledBars: true, barSpace: .25, gradient: 'classic', reflexRatio: 0, showPeaks: true, radial: false, alphaBars: false, lumiBars: false, mirror: 0 } },
  { id: 'bars', name: 'Bars', opts: { mode: 5, ledBars: false, barSpace: .3, gradient: 'prism', reflexRatio: 0, showPeaks: true, radial: false, alphaBars: false, lumiBars: false, mirror: 0, roundBars: true } },
  { id: 'mirror', name: 'Mirror', opts: { mode: 4, ledBars: false, barSpace: .2, gradient: 'rainbow', reflexRatio: .5, reflexAlpha: .25, showPeaks: false, radial: false, mirror: -1, roundBars: false } },
  { id: 'lumi', name: 'Lumi', opts: { mode: 7, ledBars: false, lumiBars: true, barSpace: .1, gradient: 'classic', reflexRatio: 0, showPeaks: false, radial: false, mirror: 0 } },
  { id: 'radial', name: 'Radial', opts: { mode: 5, ledBars: false, radial: true, spinSpeed: 1, gradient: 'prism', showPeaks: true, barSpace: .2, mirror: 0, reflexRatio: 0 } },
  { id: 'milkdrop', name: 'Milkdrop' },
];

export default function Visualizer({ player, active, jf }) {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);
  const stageRef = useRef(null);
  const vizRef = useRef(null);
  const amRef = useRef(null);
  const shadowRef = useRef(null); // { el, ctx, source, id }
  const [styleIdx, setStyleIdx] = useState(() => Math.max(0, STYLES.findIndex((x) => x.id === (localStorage.getItem('conduit.vizStyle') || 'led'))));
  const [state, setState] = useState('loading'); // loading | ready | error
  const [presetName, setPresetName] = useState('');
  const local = player.device?.kind === 'local' && !!player.current;
  const trackId = player.nowPlayingId;
  const style = STYLES[styleIdx];
  useEffect(() => { try { localStorage.setItem('conduit.vizStyle', style.id); } catch {} }, [style.id]);

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

  // The audio graph the current style analyses.
  const graph = () => { const wa = local ? player.webAudio() : shadow(); wa?.ctx?.resume?.(); return wa; };

  // Spectrum styles (audioMotion).
  useEffect(() => {
    if (!active || style.id === 'milkdrop') return undefined;
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
          ...style.opts,
        });
        amRef.current = am;
        setPresetName(style.name);
        setState('ready');
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; try { amRef.current?.destroy(); } catch {} amRef.current = null; };
  }, [active, local, style.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Milkdrop style (butterchurn).
  useEffect(() => {
    if (!active || style.id !== 'milkdrop') return undefined;
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
        const load = (blend) => { viz.loadPreset(presets[names[i]], blend); setPresetName(`Milkdrop · ${names[i]}`); };
        load(0);
        cycle = setInterval(() => { i = (i + 1) % names.length; load(2.7); }, 25000);
        const ro = new ResizeObserver(() => { const rr = size(); viz.setRendererSize(rr.width * devicePixelRatio, rr.height * devicePixelRatio); });
        ro.observe(box);
        const frame = () => { if (!alive) return; viz.render(); raf = requestAnimationFrame(frame); };
        raf = requestAnimationFrame(frame);
        setState('ready');
        vizRef.current = { viz, ro };
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); clearInterval(cycle); vizRef.current?.ro?.disconnect?.(); vizRef.current = null; };
  }, [active, local, style.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="viz" ref={boxRef} onClick={() => setStyleIdx((i) => (i + 1) % STYLES.length)} title="Click for the next style">
      <div ref={stageRef} className="viz-stage" style={{ display: style.id === 'milkdrop' ? 'none' : 'block' }} />
      <canvas ref={canvasRef} className="viz-canvas" style={{ display: style.id === 'milkdrop' ? 'block' : 'none' }} />
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
      {state === 'ready' && presetName && <div className="viz-preset">{presetName}</div>}
      <div className="viz-styles" onClick={(e) => e.stopPropagation()}>
        {STYLES.map((st, i) => (
          <button key={st.id} className={i === styleIdx ? 'on' : ''} onClick={() => setStyleIdx(i)}>{st.name}</button>
        ))}
      </div>
    </div>
  );
}
