import React, { useState } from 'react';
import DevicePicker from './DevicePicker.jsx';
import { Heart } from './TrackRow.jsx';

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PlayingElsewhereBar({ player }) {
  const { playing, device, roster } = player;
  const elsewhere = (roster?.players || []).find((p) => p.nowPlaying?.playing);
  if (!elsewhere || playing || device.kind === 'relay') return null;
  return (
    <div className="playing-elsewhere">
      <span>Playing on {elsewhere.name}</span>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
        <path d="M6 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM1 13.5a1 1 0 1 0 2 0 1 1 0 0 0-2 0zM1 9v2a2.5 2.5 0 0 1 2.5 2.5h2A4.5 4.5 0 0 0 1 9zM1 5v2a6.5 6.5 0 0 1 6.5 6.5h2A8.5 8.5 0 0 0 1 5z" />
      </svg>
    </div>
  );
}

export default function Player({ player, jf, devices, onOpenAlbum, onOpenArtist, panel, onPanel, onLike }) {
  const { current, nowPlaying, playing, position, duration, volume, device, error } = player;
  // nowPlaying covers both our own queue and a session adopted from a speaker
  // that was already playing when the app opened.
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 128 }) : null;
  // While dragging, the bar follows the thumb locally and commits ONE seek on
  // release. Committing on every change event fired a seek per pixel of drag,
  // which thrashed the speaker and made scrubbing unusable.
  const [scrub, setScrub] = useState(null);
  const shown = scrub != null ? scrub : position;
  const pct = duration > 0 ? (shown / duration) * 100 : 0;

  const commitScrub = () => {
    if (scrub == null) return;
    player.seek(scrub);
    setScrub(null);
  };

  return (
    <footer className="player">
      {error && (
        <div className="player-error" onClick={player.clearError} title="Dismiss">
          {error}
        </div>
      )}

      <div className="player-row">
        <div className="player-now">
          {art ? (
            <img
              className={`player-art ${nowPlaying?.albumId ? 'clickable' : ''}`}
              src={art}
              alt=""
              title="Go to album"
              onClick={() => nowPlaying?.albumId && onOpenAlbum?.(nowPlaying.albumId)}
            />
          ) : (
            <div className="player-art placeholder" />
          )}
          <div className="player-meta">
            <div className="player-title">{nowPlaying?.title || 'Nothing playing'}</div>
            <div className="player-artist">
              {nowPlaying?.artistId ? (
                <button className="linkish" onClick={() => onOpenArtist(nowPlaying.artistId)}>
                  {nowPlaying.artist}
                </button>
              ) : (
                nowPlaying?.artist || ''
              )}
            </div>
          </div>
          {current && (
            <button
              className={`trackrow-like ${current.UserData?.IsFavorite ? 'on' : ''}`}
              style={{ opacity: 1 }}
              onClick={() => onLike?.(current, !current.UserData?.IsFavorite)}
              title={current.UserData?.IsFavorite ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <Heart on={Boolean(current.UserData?.IsFavorite)} />
            </button>
          )}
        </div>

        <div className="player-controls">
          <div className="player-buttons">
            <button onClick={player.previous} disabled={!current} title="Previous">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
              </svg>
            </button>
            <button className="play" onClick={player.toggle} disabled={!nowPlaying}
              title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
                </svg>
              )}
            </button>
            <button onClick={player.next} disabled={!current} title="Next">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" />
              </svg>
            </button>
          </div>

          <div className="player-seek">
            <span className="t">{fmt(shown)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.floor(duration))}
              value={Math.floor(shown)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              onBlur={commitScrub}
              disabled={!nowPlaying || !duration}
              style={{ '--pct': `${pct}%` }}
            />
            <span className="t">{fmt(duration)}</span>
          </div>
        </div>

        <div className="player-right">
          <button
            className={`icon-btn ${panel === 'lyrics' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'lyrics' ? null : 'lyrics')}
            title="Lyrics"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797zM10.5 8.118l-2.619-2.62A63303.13 63303.13 0 0 0 4.74 9.075L1 15l5.925-3.74 3.575-3.142z" />
            </svg>
          </button>
          <button
            className={`icon-btn ${panel === 'queue' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'queue' ? null : 'queue')}
            title="Queue"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" />
            </svg>
          </button>
          <div className="player-volume" title={`Volume ${volume}%`}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9v6h4l5 4V5L8 9zM17 9a4 4 0 010 6" />
            </svg>
            <input
              type="range" min="0" max="100" value={volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              style={{ '--pct': `${volume}%` }}
            />
          </div>
          <DevicePicker devices={devices} active={device} onSelect={player.setDevice} />
        </div>
      </div>
    </footer>
  );
}
