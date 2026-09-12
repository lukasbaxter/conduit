import React, { useEffect, useRef, useState } from 'react';

// Milkdrop-style visualizer (butterchurn), the same engine Feishin uses.
// Draws from the local <audio> element's WebAudio source; cycles presets.
// Nothing to draw when playback is on a speaker -- the audio is not here.
export default function Visualizer({ player, active }) {
  const canvasRef = useRef(null);
  const boxRef = useRef(null);
  const vizRef = useRef(null);
  const [state, setState] = useState('loading'); // loading | ready | nolocal | error
  const [presetName, setPresetName] = useState('');
  const local = player.device?.kind === 'local' && !!player.current;

  useEffect(() => {
    if (!active) return undefined;
    if (!local) { setState('nolocal'); return undefined; }
    let alive = true, raf = 0, cycle = 0;
    (async () => {
      try {
        const [bc, bcp] = await Promise.all([import('butterchurn'), import('butterchurn-presets')]);
        const butterchurn = bc.default || bc;
        const presets = (bcp.default || bcp).getPresets();
        const names = Object.keys(presets);
        const wa = player.webAudio();
        if (!wa || !alive) { setState('error'); return; }
        const canvas = canvasRef.current, box = boxRef.current;
        const size = () => { const r = box.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; return r; };
        const r = size();
        const viz = butterchurn.createVisualizer(wa.ctx, canvas, { width: r.width * devicePixelRatio, height: r.height * devicePixelRatio, pixelRatio: devicePixelRatio, textureRatio: 1 });
        viz.connectAudio(wa.source);
        vizRef.current = viz;
        let i = Math.floor(Math.random() * names.length);
        const load = (blend) => { viz.loadPreset(presets[names[i]], blend); setPresetName(names[i]); };
        load(0);
        cycle = setInterval(() => { i = (i + 1) % names.length; load(2.7); }, 25000);
        const ro = new ResizeObserver(() => { const rr = size(); viz.setRendererSize(rr.width * devicePixelRatio, rr.height * devicePixelRatio); });
        ro.observe(box);
        const frame = () => { if (!alive) return; viz.render(); raf = requestAnimationFrame(frame); };
        raf = requestAnimationFrame(frame);
        setState('ready');
        vizRef.current = { viz, ro, next: () => { i = (i + 1) % names.length; load(1.5); } };
      } catch (e) { console.error('visualizer', e); if (alive) setState('error'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); clearInterval(cycle); vizRef.current?.ro?.disconnect?.(); vizRef.current = null; };
  }, [active, local]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="viz" ref={boxRef} onClick={() => vizRef.current?.next?.()} title="Click for the next preset">
      <canvas ref={canvasRef} className="viz-canvas" />
      {state === 'nolocal' && <div className="viz-msg">The visualizer draws from audio playing on this device. Playback is on {player.device?.name || 'another device'}.</div>}
      {state === 'error' && <div className="viz-msg">The visualizer could not start here.</div>}
      {state === 'ready' && presetName && <div className="viz-preset">{presetName}</div>}
    </div>
  );
}
