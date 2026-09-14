import React, { useState } from 'react';
import ContextMenu from './ContextMenu.jsx';
import { FORMATS } from '../api/download.js';
import { useLiked } from '../api/likes.js';

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
// Spotify's shuffle glyph (the two crossing arrows), shared by the footer and
// the entity header so they never drift apart.
export const ShuffleGlyph = ({ size = 16 }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor">
    <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
    <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
  </svg>
);
// "A, B, C" where each name is its own link (footer, now-playing view, rows).
// The links are INLINE spans, not buttons: an inline-block button that spills
// past an ellipsized line is hidden whole by the ellipsis yet stays clickable
// in the blank space after it, so a narrow row opened an artist you could not
// see. Inline text ellipsizes character by character and clips its hit area.
export function ArtistLinks({ artists, fallback = '', onOpen, className = 'rowlink' }) {
  const list = (artists || []).filter((a) => a && a.Name);
  if (!list.length) return <>{fallback}</>;
  return (
    <>
      {list.map((a, i) => (
        <React.Fragment key={a.Id || a.Name}>
          {a.Id && onOpen ? (
            <span
              className={className} role="button" tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onOpen(a.Id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(a.Id); } }}
            >{a.Name}</span>
          ) : a.Name}
          {i < list.length - 1 ? ', ' : ''}
        </React.Fragment>
      ))}
    </>
  );
}
// The Liked Songs cover: Spotify's purple-to-mint gradient with a white filled
// heart. One component so the hero, sidebar, home shortcut and browse tile match.
export function LikedCover({ className = '', heart = 45 }) {
  return (
    <div className={`liked-art ${className}`} style={{ '--heart': `${heart}%` }}>
      <svg viewBox="0 0 16 16" fill="#fff" aria-hidden="true">
        <path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z" />
      </svg>
    </div>
  );
}
// Spotify's subtle "now playing" mark: three animated bars in the index column.
export const NowPlayingBars = () => (
  <span className="npbars" aria-label="Now playing"><i /><i /><i /></span>
);

// Spotify's liked heart is #1DB954, one of the two places that shade is used.
export function Heart({ on, size = 16 }) {
  return on ? (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="var(--seek-accent, #1db954)">
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

// Menu glyphs, 16px, Spotify's outline weight.
const I = {
  plus: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15.25 8a.75.75 0 0 1-.75.75H8.75v5.75a.75.75 0 0 1-1.5 0V8.75H1.5a.75.75 0 0 1 0-1.5h5.75V1.5a.75.75 0 0 1 1.5 0v5.75h5.75a.75.75 0 0 1 .75.75z" /></svg>,
  queue: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" /></svg>,
  ban: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" /><path d="M4.97 4.97a.75.75 0 0 1 1.06 0L8 6.94l1.97-1.97a.75.75 0 1 1 1.06 1.06L9.06 8l1.97 1.97a.75.75 0 1 1-1.06 1.06L8 9.06l-1.97 1.97a.75.75 0 0 1-1.06-1.06L6.94 8 4.97 6.03a.75.75 0 0 1 0-1.06z" /></svg>,
  radio: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" /><path d="M3.05 3.05a7 7 0 0 0 0 9.9l1.06-1.06a5.5 5.5 0 0 1 0-7.78L3.05 3.05zm9.9 0-1.06 1.06a5.5 5.5 0 0 1 0 7.78l1.06 1.06a7 7 0 0 0 0-9.9z" /></svg>,
  artist: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.233.371a4.388 4.388 0 0 1 5.002 1.052c.421.459.713.992.904 1.554.143.421.263 1.173.22 1.894-.078 1.322-.638 2.408-1.399 3.316l-.127.152a.75.75 0 0 0 .201 1.13l2.209 1.275a4.75 4.75 0 0 1 2.375 4.114V16H0v-1.142a4.75 4.75 0 0 1 2.375-4.114l2.209-1.275a.75.75 0 0 0 .201-1.13l-.126-.152c-.761-.908-1.322-1.994-1.4-3.316-.043-.721.077-1.473.22-1.894a4.346 4.346 0 0 1 .904-1.554c.411-.448.91-.807 1.85-1.052zM8 1.5a2.9 2.9 0 0 0-2.8 2.087 5.53 5.53 0 0 0-.131 1.293c.055.934.44 1.717 1.062 2.459l.126.152a2.25 2.25 0 0 1-.603 3.39L3.445 12.156A3.25 3.25 0 0 0 1.5 14.5h13a3.25 3.25 0 0 0-1.945-2.344L10.346 10.88a2.25 2.25 0 0 1-.603-3.39l.127-.152c.62-.742 1.006-1.525 1.061-2.46a5.53 5.53 0 0 0-.13-1.292A2.9 2.9 0 0 0 8 1.5z" /></svg>,
  album: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" /></svg>,
  down: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" /><path d="M7.25 4v5.19L5.03 6.97 3.97 8.03 8 12.06l4.03-4.03-1.06-1.06-2.22 2.22V4h-1.5z" /></svg>,
  trash: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M5.25 3v-.917C5.25.958 6.271 0 7.5 0h1c1.229 0 2.25.958 2.25 2.083V3h4.25v1.5h-1.028l-.86 10.28A1.5 1.5 0 0 1 11.617 16H4.383a1.5 1.5 0 0 1-1.495-1.22L2.028 4.5H1V3h4.25zm1.5-.917V3h2.5v-.917c0-.283-.278-.583-.75-.583h-1c-.472 0-.75.3-.75.583zM3.533 4.5l.848 10h7.238l.848-10H3.533z" /></svg>,
  heart: <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2zm3.158.252A3.082 3.082 0 0 0 2.49 7.337l.005.005L7.8 13.664a.264.264 0 0 0 .311.069.262.262 0 0 0 .09-.069l5.312-6.33a3.043 3.043 0 0 0 .68-2.573 3.118 3.118 0 0 0-2.551-2.463 3.079 3.079 0 0 0-2.612.816l-.007.007a1.501 1.501 0 0 1-2.045 0l-.009-.008a3.082 3.082 0 0 0-2.121-.861z" /></svg>,
  heartOn: <svg viewBox="0 0 16 16" width="16" height="16" fill="var(--seek-accent, #1db954)"><path d="M15.724 4.22A4.313 4.313 0 0 0 12.192.814a4.269 4.269 0 0 0-3.622 1.13.837.837 0 0 1-1.14 0 4.272 4.272 0 0 0-6.21 5.855l5.916 7.05a1.128 1.128 0 0 0 1.727 0l5.916-7.05a4.228 4.228 0 0 0 .945-3.577z" /></svg>,
};

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
  onAddToQueue, onExclude, onRadio, onDownload, hideAlbum = false, snippet = null, snippetAt = null, onPlayAt, highlight = false,
}) {
  // {x, y} while the context menu is open (from the dots button or a right-click).
  const [menu, setMenu] = useState(null);
  // From the like store, never from the row's UserData (which can be stale).
  const liked = useLiked(track.Id);
  const excluded = track.UserData?.Likes === false;
  const artistsOf = track.ArtistItems?.length ? track.ArtistItems : (track.Artists || []).map((n2) => ({ Name: n2 }));

  // Spotify's row menu, top to bottom. Submenus open on hover.
  const menuItems = [
    { label: 'Add to playlist', icon: I.plus, sub: [
      { label: 'New playlist', icon: I.plus, onClick: () => onNewPlaylist?.(track) },
      playlists.length ? { sep: true } : null,
      ...playlists.map((p) => ({ key: p.Id, label: p.Name, onClick: () => onAddTo?.(p, track) })),
    ] },
    onRemove ? { label: 'Remove from this playlist', icon: I.trash, onClick: () => onRemove(track) } : null,
    { label: liked ? 'Remove from your Liked Songs' : 'Save to your Liked Songs', icon: liked ? I.heartOn : I.heart, onClick: () => onLike?.(track, !liked) },
    onAddToQueue ? { label: 'Add to queue', icon: I.queue, onClick: () => onAddToQueue(track) } : null,
    onExclude ? { label: excluded ? 'Include in your taste profile' : 'Exclude from your taste profile', icon: I.ban, onClick: () => onExclude(track, !excluded) } : null,
    { sep: true },
    onRadio ? { label: 'Go to song radio', icon: I.radio, onClick: () => onRadio(track) } : null,
    onOpenArtist && artistsOf.some((a) => a.Id) ? (
      artistsOf.filter((a) => a.Id).length > 1
        ? { label: 'Go to artist', icon: I.artist, sub: artistsOf.filter((a) => a.Id).map((a) => ({ key: a.Id, label: a.Name, onClick: () => onOpenArtist(a.Id) })) }
        : { label: 'Go to artist', icon: I.artist, onClick: () => onOpenArtist(artistsOf.find((a) => a.Id).Id) }
    ) : null,
    onOpenAlbum && track.AlbumId ? { label: 'Go to album', icon: I.album, onClick: () => onOpenAlbum(track.AlbumId) } : null,
    onDownload ? { sep: true } : null,
    onDownload ? { label: 'Download', icon: I.down, sub: FORMATS.map((f) => ({ key: f.id, label: f.label, onClick: () => onDownload(track, f.id) })) } : null,
  ];
  const openMenuAt = (e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); };

  return (
    <div
      className={`trackrow ${active ? 'active' : ''} ${highlight ? 'hi' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onPlay}
      onContextMenu={openMenuAt}
    >
      <button
        className="trackrow-n"
        onClick={active && onToggle ? onToggle : onPlay}
        title={active && isPlaying ? 'Pause' : 'Play'}
      >
        <span className="trackrow-idx">{active && isPlaying ? <NowPlayingBars /> : n}</span>
        {/* Hovering the row that is playing offers pause (the two bars), like Spotify. */}
        <span className="trackrow-playglyph">{active && isPlaying ? <PauseGlyph size={14} /> : <PlayGlyph size={14} />}</span>
      </button>

      {showArt && jf && (
        <img
          className={`trackrow-art ${track.AlbumId && onOpenAlbum ? 'link' : ''}`}
          src={jf.imageUrl(track.AlbumId || track.Id, { maxHeight: 80 })} alt="" loading="lazy"
          title={track.AlbumId && onOpenAlbum ? track.Album || 'Open album' : undefined}
          onClick={track.AlbumId && onOpenAlbum ? (e) => { e.stopPropagation(); onOpenAlbum(track.AlbumId); } : undefined}
        />
      )}

      <span className="trackrow-name">
        <span>{track.Name}</span>
        {/* On an artist's own page the artist line is redundant; Spotify's
            Popular rows show the title alone. */}
        {!hideArtists && <small>
          <ArtistLinks artists={artistsOf} fallback={track.AlbumArtist || ''} onOpen={onOpenArtist} />
        </small>}
        {/* A lyric match: the line that matched, with the words lit. */}
        {snippet && (
          <small
            className={`lyric-snippet ${snippetAt != null && onPlayAt ? 'playable' : ''}`}
            title={snippetAt != null && onPlayAt ? 'Play from this line' : undefined}
            onClick={snippetAt != null && onPlayAt ? (e) => { e.stopPropagation(); onPlayAt(track, snippetAt); } : undefined}
          >
            <span className="lyric-tag">Lyrics</span>
            <span>
              {snippet.split(/(\u0001[^\u0002]*\u0002)/g).map((part, i) => (
                part.startsWith('\u0001') ? <mark key={i}>{part.slice(1, -1)}</mark> : <React.Fragment key={i}>{part}</React.Fragment>
              ))}
            </span>
          </small>
        )}
      </span>

      {hideAlbum ? (
        <span className="trackrow-album" />
      ) : track.AlbumId && onOpenAlbum ? (
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

      <span className="trackrow-menu">
        <button
          className="trackrow-more"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 4, fromButton: true }); }}
          title="More options"
        >
          <Dots />
        </button>
        {menu && <ContextMenu x={menu.x} y={menu.y} anchorRight={Boolean(menu.fromButton)} items={menuItems} onClose={() => setMenu(null)} />}
      </span>
    </div>
  );
}
