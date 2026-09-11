import React, { useEffect, useRef, useState } from 'react';

export const PlayGlyph = ({ size = 20 }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor">
    <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
  </svg>
);
export const PauseGlyph = ({ size = 20 }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor">
    <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
  </svg>
);
// Spotify's subtle "now playing" mark: three animated bars in the index column.
export const NowPlayingBars = () => (
  <span className="npbars" aria-label="Now playing"><i /><i /><i /></span>
);

// Spotify's liked heart is #1DB954, one of the two places that shade is used.
export function Heart({ on, size = 16 }) {
  return on ? (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="#1db954">
      <path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor">
      <path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2zm3.158.252A3.082 3.082 0 0 0 2.49 7.337l.005.005L7.8 13.664a.264.264 0 0 0 .311.069.262.262 0 0 0 .09-.069l5.312-6.33a3.043 3.043 0 0 0 .68-2.573 3.118 3.118 0 0 0-2.551-2.463 3.079 3.079 0 0 0-2.612.816l-.007.007a1.501 1.501 0 0 1-2.045 0l-.009-.008a3.082 3.082 0 0 0-2.121-.861z" />
    </svg>
  );
}

const Dots = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
  </svg>
);

function fmtDur(ticks) {
  const secs = ticks ? ticks / 10_000_000 : 0;
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}

/**
 * One track row, used by albums, artists, playlists, search and Liked Songs.
 *
 * `onLike` toggles the Jellyfin favourite. `playlists`+`onAddTo` power the
 * "Add to playlist" menu. `draggable` + `onDragReorder` enable reordering
 * inside a user playlist. `onRemove` shows "Remove from this playlist".
 */
export default function TrackRow({
  track, n, active, isPlaying = false, onPlay, onToggle, onLike, playlists = [], onAddTo, onNewPlaylist,
  onRemove, draggable = false, onDragStart, onDragOver, onDrop, showArt = false, jf,
  onOpenArtist, onOpenAlbum, hideArtists = false,
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  const liked = Boolean(track.UserData?.IsFavorite);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  return (
    <div
      className={`trackrow ${active ? 'active' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onPlay}
    >
      <button
        className="trackrow-n"
        onClick={active && onToggle ? onToggle : onPlay}
        title={active && isPlaying ? 'Pause' : 'Play'}
      >
        <span className="trackrow-idx">{active && isPlaying ? <NowPlayingBars /> : n}</span>
        <span className="trackrow-playglyph"><PlayGlyph size={14} /></span>
      </button>

      {showArt && jf && (
        <img className="trackrow-art" src={jf.imageUrl(track.AlbumId || track.Id, { maxHeight: 80 })} alt="" loading="lazy" />
      )}

      <span className="trackrow-name">
        <span>{track.Name}</span>
        {/* On an artist's own page the artist line is redundant; Spotify's
            Popular rows show the title alone. */}
        {!hideArtists && <small>
          {(track.ArtistItems?.length ? track.ArtistItems : (track.Artists || []).map((n2) => ({ Name: n2 }))).map((a, i, arr) => (
            <React.Fragment key={a.Id || a.Name}>
              {a.Id && onOpenArtist ? (
                <button className="rowlink" onClick={(e) => { e.stopPropagation(); onOpenArtist(a.Id); }}>{a.Name}</button>
              ) : a.Name}
              {i < arr.length - 1 ? ', ' : ''}
            </React.Fragment>
          ))}
          {!track.ArtistItems?.length && !track.Artists?.length ? (track.AlbumArtist || '') : ''}
        </small>}
      </span>

      {track.AlbumId && onOpenAlbum ? (
        <button className="trackrow-album rowlink" onClick={(e) => { e.stopPropagation(); onOpenAlbum(track.AlbumId); }}>{track.Album || ''}</button>
      ) : (
        <span className="trackrow-album">{track.Album || ''}</span>
      )}

      <button
        className={`trackrow-like ${liked ? 'on' : ''}`}
        onClick={(e) => { e.stopPropagation(); onLike?.(track, !liked); }}
        title={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
      >
        <Heart on={liked} />
      </button>

      <span className="trackrow-dur">{fmtDur(track.RunTimeTicks)}</span>

      <span className="trackrow-menu" ref={menuRef}>
        <button className="trackrow-more" onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }} title="More options">
          <Dots />
        </button>
        {menu && (
          <div className="ctxmenu">
            <div className="ctxmenu-label">Add to playlist</div>
            <button onClick={() => { setMenu(false); onNewPlaylist?.(track); }}>+ New playlist</button>
            {playlists.map((p) => (
              <button key={p.Id} onClick={() => { setMenu(false); onAddTo?.(p, track); }}>{p.Name}</button>
            ))}
            {onRemove && (
              <>
                <div className="ctxmenu-sep" />
                <button className="danger" onClick={() => { setMenu(false); onRemove(track); }}>Remove from this playlist</button>
              </>
            )}
          </div>
        )}
      </span>
    </div>
  );
}
