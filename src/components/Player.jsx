import React from 'react';
import DevicePicker from './DevicePicker.jsx';

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Player({ player, jf, devices }) {
  const { current, playing, position, duration, volume, device, error } = player;
  const art = current ? jf.imageUrl(current.AlbumId || current.Id, { maxHeight: 128 }) : null;
  const pct = duration > 0 ? (position / duration) * 100 : 0;

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
            <img className="player-art" src={art} alt="" />
          ) : (
            <div className="player-art placeholder" />
          )}
          <div className="player-meta">
            <div className="player-title">{current?.Name || 'Nothing playing'}</div>
            <div className="player-artist">
              {current?.Artists?.join(', ') || current?.AlbumArtist || ''}
            </div>
          </div>
        </div>

        <div className="player-controls">
          <div className="player-buttons">
            <button onClick={player.previous} disabled={!current} title="Previous">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 5h2v14H6zM20 5v14l-11-7z" />
              </svg>
            </button>
            <button className="play" onClick={player.toggle} disabled={!current}
              title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button onClick={player.next} disabled={!current} title="Next">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M16 5h2v14h-2zM4 5l11 7-11 7z" />
              </svg>
            </button>
          </div>

          <div className="player-seek">
            <span className="t">{fmt(position)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.floor(duration))}
              value={Math.floor(position)}
              onChange={(e) => player.seek(Number(e.target.value))}
              disabled={!current || !duration}
              style={{ '--pct': `${pct}%` }}
            />
            <span className="t">{fmt(duration)}</span>
          </div>
        </div>

        <div className="player-right">
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
