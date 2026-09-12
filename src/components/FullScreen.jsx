import React, { useEffect, useState } from 'react';
import { Lyrics } from './RightPanel.jsx';
import Visualizer, { EQ_STYLES, GRADIENTS, loadVizSettings } from './Visualizer.jsx';
import ContextMenu from './ContextMenu.jsx';
import { ArtistLinks, PlayGlyph, PauseGlyph, ShuffleGlyph } from './TrackRow.jsx';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Spotify's full-screen player: blurred cover behind, tabs up top (Album /
 * Visualizer / Lyrics), the track and transport along the bottom.
 */
export default function FullScreen({ player, jf, onClose, onOpenArtist, onLike }) {
  const [tab, setTab] = useState(() => localStorage.getItem('conduit.fsTab') || 'album');
  // Visualizer settings (engine, style, gradient, preset cycling) behind the
  // tab's ⋯ menu; persisted per device.
  const [viz, setViz] = useState(loadVizSettings);
  const [vizMenu, setVizMenu] = useState(null);
  const [nextPreset, setNextPreset] = useState(0);
  const setV = (patch) => setViz((v) => { const n = { ...v, ...patch }; try { localStorage.setItem('conduit.viz', JSON.stringify(n)); } catch {} return n; });
  const vizItems = [
    { label: 'Engine' },
    { label: `Graphic EQ${viz.engine === 'eq' ? '  ✓' : ''}`, onClick: () => setV({ engine: 'eq' }) },
    { label: `Milkdrop${viz.engine === 'milkdrop' ? '  ✓' : ''}`, onClick: () => setV({ engine: 'milkdrop' }) },
    { sep: true },
    ...(viz.engine === 'eq' ? [
      { label: 'Style', sub: EQ_STYLES.map((s2) => ({ key: s2.id, label: `${s2.name}${viz.style === s2.id ? '  ✓' : ''}`, onClick: () => setV({ style: s2.id }) })) },
      { label: 'Colours', sub: GRADIENTS.map((g) => ({ key: g, label: `${g[0].toUpperCase()}${g.slice(1)}${viz.gradient === g ? '  ✓' : ''}`, onClick: () => setV({ gradient: g }) })) },
    ] : [
      { label: 'Next preset', onClick: () => setNextPreset((n) => n + 1) },
      { label: `Cycle presets${viz.cycle ? '  ✓' : ''}`, onClick: () => setV({ cycle: !viz.cycle }) },
    ]),
  ];
  const { nowPlaying, playing, position, duration, shuffle, repeat } = player;
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 1000 }) : nowPlaying?.artUrl || null;
  useEffect(() => { try { localStorage.setItem('conduit.fsTab', tab); } catch {} }, [tab]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fs">
      {art && <div className="fs-bg" style={{ backgroundImage: `url("${art}")` }} />}
      <div className="fs-top">
        <div className="fs-from">{nowPlaying?.device?.name ? `Playing on ${nowPlaying.device.name}` : ''}</div>
        <div className="fs-tabs">
          {[['album', 'Album'], ['viz', 'Visualizer'], ['lyrics', 'Lyrics']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
          {tab === 'viz' && (
            <button className="fs-tabmore" title="Visualizer settings" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setVizMenu({ x: r.left, y: r.bottom + 6 }); }}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" /></svg>
            </button>
          )}
          {vizMenu && <ContextMenu x={vizMenu.x} y={vizMenu.y} items={vizItems} onClose={() => setVizMenu(null)} />}
        </div>
        <button className="fs-close" onClick={onClose} title="Exit full screen">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.53 9.47a.75.75 0 0 1 0 1.06l-2.72 2.72h1.018a.75.75 0 0 1 0 1.5H1.25v-3.579a.75.75 0 0 1 1.5 0v1.018l2.72-2.72a.75.75 0 0 1 1.06 0zm2.94-2.94a.75.75 0 0 1 0-1.06l2.72-2.72h-1.018a.75.75 0 1 1 0-1.5h3.578v3.579a.75.75 0 0 1-1.5 0V3.81l-2.72 2.72a.75.75 0 0 1-1.06 0z" /></svg>
        </button>
      </div>

      <div className="fs-stage">
        {tab === 'album' && (art ? <img className="fs-art" src={art} alt="" /> : <div className="fs-art ph" />)}
        {tab === 'viz' && <Visualizer player={player} jf={jf} active={tab === 'viz'} settings={viz} nextPresetSignal={nextPreset} />}
        {tab === 'lyrics' && <div className="fs-lyrics"><Lyrics player={player} jf={jf} /></div>}
      </div>

      <div className="fs-bottom">
        <div className="fs-meta">
          {art && tab !== 'album' && <img className="fs-thumb" src={art} alt="" />}
          <div style={{ minWidth: 0 }}>
            <div className="fs-title">{nowPlaying?.title || 'Nothing playing'}</div>
            <div className="fs-artist"><ArtistLinks artists={nowPlaying?.artists} fallback={nowPlaying?.artist || ''} onOpen={(id) => { onClose(); onOpenArtist(id); }} className="linkish" /></div>
          </div>
          {nowPlaying?.itemId && (
            <button className={`fs-like ${nowPlaying.liked ? 'on' : ''}`} onClick={() => onLike({ Id: nowPlaying.itemId, Name: nowPlaying.title, Artists: [nowPlaying.artist], AlbumId: nowPlaying.albumId, UserData: { IsFavorite: nowPlaying.liked }, _partial: true }, !nowPlaying.liked)} title={nowPlaying.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}>
              <svg viewBox="0 0 16 16" width="20" height="20" fill={nowPlaying.liked ? 'var(--seek-accent)' : 'currentColor'}>{nowPlaying.liked
                ? <path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z" />
                : <path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2zm3.158.252A3.082 3.082 0 0 0 2.49 7.337l.005.005L7.8 13.664a.264.264 0 0 0 .311.069.262.262 0 0 0 .09-.069l5.312-6.33a3.043 3.043 0 0 0 .68-2.573 3.118 3.118 0 0 0-2.551-2.463 3.079 3.079 0 0 0-2.612.816l-.007.007a1.501 1.501 0 0 1-2.045 0l-.009-.008a3.082 3.082 0 0 0-2.121-.861z" />}</svg>
            </button>
          )}
        </div>
        <div className="fs-seek">
          <span>{fmt(position || 0)}</span>
          <input type="range" min="0" max={Math.max(1, duration || 0)} value={Math.min(position || 0, duration || 0)} onChange={(e) => player.seek(Number(e.target.value))} style={{ '--pct': `${duration ? (position / duration) * 100 : 0}%` }} />
          <span>{fmt(duration || 0)}</span>
        </div>
        <div className="fs-controls">
          <button className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`} onClick={player.cycleShuffle} title="Shuffle"><ShuffleGlyph size={18} /></button>
          <button onClick={player.previous} title="Previous"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" /></svg></button>
          <button className="fs-play" onClick={player.toggle} title={playing ? 'Pause' : 'Play'}>{playing ? <PauseGlyph size={26} /> : <PlayGlyph size={26} />}</button>
          <button onClick={player.next} title="Next"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" /></svg></button>
          <button className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`} onClick={player.cycleRepeat} title="Repeat"><svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" /></svg></button>
        </div>
      </div>
    </div>
  );
}
