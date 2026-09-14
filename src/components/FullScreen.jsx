import React, { useEffect, useRef, useState } from 'react';
import { Lyrics } from './RightPanel.jsx';
import Visualizer, { EQ_STYLES, GRADIENTS, DEFAULT_VIZ, loadVizSettings } from './Visualizer.jsx';
import ContextMenu from './ContextMenu.jsx';
import DevicePicker from './DevicePicker.jsx';
import { ArtistLinks, PlayGlyph, PauseGlyph, ShuffleGlyph } from './TrackRow.jsx';
import { vibrantColor } from '../api/colors.js';
import { ctxItemId } from '../api/context.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Spotify's full-screen player: blurred cover behind, tabs up top (Album /
 * Visualizer / Lyrics), the track and transport along the bottom.
 */
export default function FullScreen({ player, jf, onClose, onOpenArtist, onLike, prefs, onUpdatePrefs, onPanel, devices = [], sessionDevice = null }) {
  const [tab, setTab] = useState(() => localStorage.getItem('conduit.fsTab') || 'album');
  // Visualizer settings (style, colours) behind the tab's ⋯ menu. They live
  // in the account's prefs, so a change here shows up on every signed-in
  // client and survives a fresh machine; localStorage only carries a copy for
  // the first paint.
  const viz = { ...DEFAULT_VIZ, ...(prefs?.viz || loadVizSettings()) };
  const [vizMenu, setVizMenu] = useState(null);
  const setV = (patch) => { const n = { ...viz, ...patch }; try { localStorage.setItem('conduit.viz', JSON.stringify(n)); } catch {} onUpdatePrefs?.({ viz: n }); };
  const vizItems = [
    { label: 'Style', sub: EQ_STYLES.map((s2) => ({ key: s2.id, label: `${s2.name}${viz.style === s2.id ? '  ✓' : ''}`, onClick: () => setV({ style: s2.id }) })) },
    { label: 'Colours', sub: GRADIENTS.map((g) => ({ key: g, label: `${g[0].toUpperCase()}${g.slice(1)}${viz.gradient === g ? '  ✓' : ''}`, onClick: () => setV({ gradient: g }) })) },
  ];
  const { nowPlaying, playing, position, duration, shuffle, repeat, volume } = player;
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 1000 }) : nowPlaying?.artUrl || null;
  useEffect(() => { try { localStorage.setItem('conduit.fsTab', tab); } catch {} }, [tab]);
  // Phone: Spotify's now-playing is a gradient of the cover's colour (no
  // blur) with "PLAYING FROM PLAYLIST / name" up top. Both read here; the
  // desktop CSS ignores them.
  const [np, setNp] = useState(null);
  useEffect(() => { let alive = true; if (!art) { setNp(null); return undefined; } vibrantColor(art).then((rgb) => { if (alive) setNp(rgb ? `rgb(${rgb.join(',')})` : null); }); return () => { alive = false; }; }, [art]);
  const [from, setFrom] = useState(null); // { kind, name }
  useEffect(() => {
    const ctx = player.contextId; let alive = true;
    if (!ctx) { setFrom(null); return undefined; }
    if (ctx === 'liked') { setFrom({ kind: 'PLAYING FROM LIKED SONGS', name: 'Liked Songs' }); return undefined; }
    if (String(ctx).startsWith('mix:')) { setFrom({ kind: 'PLAYING FROM DAILY MIX', name: '' }); return undefined; }
    if (String(ctx).startsWith('browse:')) { setFrom({ kind: 'PLAYING FROM GENRE', name: '' }); return undefined; }
    jf.itemById(ctxItemId(ctx)).then((it) => { if (!alive || !it) return; const kind = it.Type === 'MusicArtist' ? 'ARTIST' : it.Type === 'MusicAlbum' ? 'ALBUM' : 'PLAYLIST'; setFrom({ kind: `PLAYING FROM ${kind}`, name: it.Name }); }).catch(() => {});
    return () => { alive = false; };
  }, [player.contextId, jf]);
  const vizEl = <Visualizer player={player} jf={jf} active={tab === 'viz'} settings={viz} />;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fs" style={np ? { '--np': np } : undefined}>
      {art && tab !== 'viz' && <div className="fs-bg" style={{ backgroundImage: `url("${art}")` }} />}
      <div className="fs-top">
        <button className="fs-chevron" onClick={onClose} title="Close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2.793 8.043a1 1 0 0 1 1.414 0L12 15.836l7.793-7.793a1 1 0 1 1 1.414 1.414L12 18.664 2.793 9.457a1 1 0 0 1 0-1.414z" /></svg>
        </button>
        <div className="fs-from">
          {from && <span className="fs-from-phone"><small>{from.kind}</small><b>{from.name}</b></span>}
        </div>
        <div className="fs-tabs">
          {[['album', 'Album'], ['lyrics', 'Lyrics'], ['viz', 'Visualizer']].map(([k, label]) => (
            <span key={k} className={`fs-tab ${tab === k ? 'on' : ''}`}>
              <button onClick={() => setTab(k)}>{label}</button>
              {k === 'viz' && tab === 'viz' && (
                <button className="fs-kebab" title="Visualizer settings" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setVizMenu({ x: r.left - 8, y: r.bottom + 8 }); }}>
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 6l4.5 4.5L12.5 6" /></svg>
                </button>
              )}
            </span>
          ))}
          {vizMenu && <ContextMenu x={vizMenu.x} y={vizMenu.y} items={vizItems} onClose={() => setVizMenu(null)} />}
        </div>
        {/* Arrows pointing IN (collapse), the mirror of the footer's expand glyph. */}
        <button className="fs-close" onClick={onClose} title="Exit now playing view">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 1.5 9.5 6.5M9.5 2.75V6.5h3.75M1.5 14.5l5-5M6.5 13.25V9.5H2.75" />
          </svg>
        </button>
      </div>

      <div className="fs-stage">
        {tab === 'album' && (art ? <img className="fs-art" src={art} alt="" /> : <div className="fs-art ph" />)}
        {tab === 'viz' && vizEl}
        {tab === 'lyrics' && <div className="fs-lyrics"><Lyrics player={player} jf={jf} /></div>}
      </div>

      <div className="fs-bottom">
        {/* Progress across the top of the block, above the album thumb and the controls. */}
        <div className="fs-seek">
          <span>{fmt(position || 0)}</span>
          <input type="range" min="0" max={Math.max(1, duration || 0)} value={Math.min(position || 0, duration || 0)} onChange={(e) => player.seek(Number(e.target.value))} style={{ '--pct': `${duration ? (position / duration) * 100 : 0}%` }} />
          <span>{fmt(duration || 0)}</span>
        </div>
        <div className="fs-meta">
          {art && <img className="fs-thumb" src={art} alt="" />}
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
        <div className="fs-controls">
          <button className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`} onClick={player.cycleShuffle} title="Shuffle"><ShuffleGlyph size={18} /></button>
          <button onClick={player.previous} title="Previous"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" /></svg></button>
          <button className="fs-play" onClick={player.toggle} title={playing ? 'Pause' : 'Play'}>{playing ? <PauseGlyph size={26} /> : <PlayGlyph size={26} />}</button>
          <button onClick={player.next} title="Next"><svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" /></svg></button>
          <button className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`} onClick={player.cycleRepeat} title="Repeat"><svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5z" /></svg></button>
        </div>
        {/* Bottom-right: the speaker picker with the device it is on as green text, and the volume. */}
        <div className="fs-output">
          {sessionDevice && <DevicePicker devices={devices} active={sessionDevice} onSelect={player.setDevice} showName />}
          <div className="fs-volume" title={`Volume ${volume}%`}>
            <button onClick={() => player.setVolume(volume > 0 ? 0 : 60)} title={volume > 0 ? 'Mute' : 'Unmute'}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                {volume === 0 ? (
                  <><path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z" /><path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z" /></>
                ) : (
                  <><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z" />{volume > 40 && <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z" />}</>
                )}
              </svg>
            </button>
            <input type="range" min="0" max="100" value={volume} onChange={(e) => player.setVolume(Number(e.target.value))} style={{ '--pct': `${volume}%` }} />
          </div>
        </div>
        {/* Phone-only bottom row (Spotify: devices bottom-left, lyrics / queue bottom-right). */}
        <div className="fs-phone-row">
          <button onClick={() => { onClose(); onPanel?.('queue'); }} title="Queue" aria-label="Queue">
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" /></svg>
          </button>
          <span />
          <button className={tab === 'lyrics' ? 'on' : ''} onClick={() => setTab(tab === 'lyrics' ? 'album' : 'lyrics')} title="Lyrics" aria-label="Lyrics">
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797zM10.5 8.118l-2.619-2.62A63303.13 63303.13 0 0 0 4.74 9.075L1 15l5.925-3.74 3.575-3.142z" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
