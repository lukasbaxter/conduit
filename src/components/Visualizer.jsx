import React, { useEffect, useRef, useState } from 'react';
import { measureSpeakerLag } from '../api/speakerSync.js';

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
// `sync[deviceId]` (seconds): how far the picture must lag the speaker's
// reported playhead so it lines up with the sound in the room. MEASURED with
// the microphone (src/api/speakerSync.js), never assumed; `autoSync` (default
// on) re-measures whenever the visualizer opens on a speaker and every so
// often after that.
export const DEFAULT_VIZ = { style: 'line', gradient: 'prism', sync: {}, autoSync: true };
export function loadVizSettings() {
  try { return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem('conduit.viz') || '{}') }; } catch { return { ...DEFAULT_VIZ }; }
}

export default function Visualizer({ player, active, jf, settings, onSetting, controls }) {
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
    // base: the track time the current stream starts at; lead: how far ahead
    // of the playhead to ask for, to cover the transcode's start-up (learned).
    shadowRef.current = { el, ctx, source, id: null, base: 0, lead: 1.0, loading: false };
    return shadowRef.current;
  };
  useEffect(() => () => { const sh = shadowRef.current; if (sh) { sh.el.pause(); sh.el.src = ''; sh.ctx.close?.(); shadowRef.current = null; } }, []);
  // The session playhead as a live clock: the position the player last
  // reported plus the time since. The sync tick below reads THIS, never a
  // position captured when the effect ran.
  const clockRef = useRef({ pos: 0, at: Date.now(), playing: false });
  clockRef.current = { pos: player.position || 0, at: Date.now(), playing: !!player.playing };
  useEffect(() => {
    if (!active || local) { const sh = shadowRef.current; if (sh) sh.el.pause(); return undefined; }
    const sh = shadow();
    if (window.location.search.includes('debug')) { window.__shadow = sh; sh.want = () => want(); }
    const want = () => { const c = clockRef.current; return c.pos + (c.playing ? (Date.now() - c.at) / 1000 : 0) - delayRef.current; };
    // Seeking the ORIGINAL file is not accurate on VBR rips, so every (re)sync
    // is a fresh transcode that ffmpeg starts exactly at `base`; from then on
    // the element's clock is exact and small drift is taken out with
    // playbackRate instead of another seek.
    const load = () => {
      const at = Math.max(0, want() + sh.lead);
      sh.base = at; sh.id = trackId; sh.loading = true;
      sh.el.src = jf.transcodeUrl(trackId, { codec: 'mp3', bitrate: 192000, startAt: at });
      sh.el.playbackRate = 1;
      if (clockRef.current.playing) sh.el.play().catch(() => {});
    };
    const onPlaying = () => {
      if (!sh.loading) return;
      sh.loading = false;
      // Behind at start-up (drift < 0) means ask further ahead next time.
      const drift = (sh.base + sh.el.currentTime) - want();
      sh.lead = Math.min(3, Math.max(0.2, sh.lead - drift));
    };
    const tick = () => {
      const c = clockRef.current;
      if (!c.playing) { if (!sh.el.paused) sh.el.pause(); return; }
      if (sh.id !== trackId || !sh.el.src) { load(); return; }
      if (sh.el.paused) sh.el.play().catch(() => {});
      if (sh.loading) return;
      const drift = (sh.base + sh.el.currentTime) - want();
      if (Math.abs(drift) > 2) { load(); return; }
      // Ahead -> slow down, behind -> speed up; inaudible, it is silent anyway.
      sh.el.playbackRate = Math.abs(drift) < 0.04 ? 1 : Math.min(1.25, Math.max(0.8, 1 - drift * 0.6));
    };
    sh.el.addEventListener('playing', onPlaying);
    tick();
    const t = setInterval(tick, 250);
    return () => { clearInterval(t); sh.el.removeEventListener('playing', onPlaying); };
  }, [active, local, trackId, player.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- speaker sync (microphone) --------------------------------------------
  const deviceId = player.nowPlaying?.device?.id || player.device?.id || null;
  const delayRef = useRef(0);
  const learned = deviceId ? cfg.sync?.[deviceId] : undefined;
  delayRef.current = learned ?? 0;
  const [syncMsg, setSyncMsg] = useState('');
  const syncingRef = useRef(false);
  const lastSyncRef = useRef({ id: null, at: 0 });
  const runSync = async (manual = false) => {
    const sh = shadowRef.current;
    if (!sh || syncingRef.current || local || !clockRef.current.playing) return;
    syncingRef.current = true;
    const name = player.nowPlaying?.device?.name || 'speaker';
    setSyncMsg(`Listening for ${name}…`);
    try {
      // Let the shadow settle first: it must be playing at rate 1 for a clean reference.
      for (let i = 0; i < 20 && (sh.loading || sh.el.paused); i += 1) await new Promise((r) => setTimeout(r, 250)); // eslint-disable-line no-await-in-loop
      const r = await measureSpeakerLag({ ctx: sh.ctx, refSource: sh.source, seconds: 8, maxLag: 4 });
      lastSyncRef.current = { id: deviceId, at: Date.now() };
      if (r.refLevel < 0.0005) { setSyncMsg('Reference stream is silent, try again'); return; }
      if (r.level < 0.0002) { setSyncMsg(`Could not hear the speaker on ${r.mic || 'the microphone'}`); return; }
      if (r.score < 0.15 || r.margin < 0.04) { setSyncMsg(manual ? 'No clear match, try again with the music louder' : ''); return; }
      const next = Math.round((delayRef.current + r.lag) * 100) / 100;
      delayRef.current = next;
      if (deviceId) onSetting?.({ sync: { ...(cfg.sync || {}), [deviceId]: next } });
      setSyncMsg(`Synced to ${name}: ${next >= 0 ? '+' : ''}${next.toFixed(2)} s (via ${r.mic || 'microphone'})`);
    } catch (e) {
      setSyncMsg(/denied|NotAllowed/i.test(String(e)) ? 'Microphone access needed to sync' : `Sync failed: ${e.message}`);
    } finally {
      syncingRef.current = false;
      setTimeout(() => setSyncMsg(''), 6000);
    }
  };
  if (controls) controls.current = { sync: () => runSync(true) };
  useEffect(() => {
    if (!active || local || !deviceId || cfg.autoSync === false || !player.playing) return undefined;
    // First open on this speaker: measure after the shadow has had 2 s; then every 60 s.
    const due = lastSyncRef.current.id !== deviceId || Date.now() - lastSyncRef.current.at > 60000;
    const t = setTimeout(() => { if (due) runSync(false); }, learned === undefined ? 2500 : 4000);
    const iv = setInterval(() => runSync(false), 60000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [active, local, deviceId, cfg.autoSync, player.playing]); // eslint-disable-line react-hooks/exhaustive-deps

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
      {syncMsg && <div className="viz-sync">{syncMsg}</div>}
    </div>
  );
}
