import React, { useState } from 'react';
import { Heart } from './TrackRow.jsx';

const ICONS = {
  home: 'M12 3 3 10v11h6v-6h6v6h6V10z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  library: 'M4 4v16M9 4v16M14 5l5 15',
  plus: 'M12 5v14M5 12h14',
};

function Icon({ name, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * Left rail. "Your Library" is Liked Songs pinned first, then the user's own
 * playlists -- Spotify's layout. Albums and artists live under Home and Search.
 */
export default function Sidebar({ view, onView, playlists, likedCount, onOpen, onOpenLiked, onCreate, jf, loading }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onCreate(n);
    setName('');
    setCreating(false);
  };

  return (
    <aside className="sidebar">
      <nav className="nav">
        <button className={`navitem ${view === 'home' ? 'on' : ''}`} onClick={() => onView('home')}>
          <Icon name="home" /><span>Home</span>
        </button>
        <button className={`navitem ${view === 'search' ? 'on' : ''}`} onClick={() => onView('search')}>
          <Icon name="search" /><span>Search</span>
        </button>
      </nav>

      <div className="libpanel">
        <div className="libhead">
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon name="library" /> Your Library
          </span>
          <button className="icon-btn" onClick={() => setCreating((v) => !v)} title="Create playlist">
            <Icon name="plus" size={18} />
          </button>
        </div>

        <div className="liblist">
          {creating && (
            <form onSubmit={submit} style={{ padding: '4px 8px 10px' }}>
              <input
                className="newplaylist-input"
                autoFocus
                placeholder="Playlist name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
              />
            </form>
          )}

          <button className="libitem" onClick={onOpenLiked} title="Liked Songs">
            <div className="liked-art" style={{ width: 48, height: 48, borderRadius: 4, flex: 'none' }}>
              <Heart on={false} size={20} />
            </div>
            <span className="libitem-text">
              <span className="libitem-name">Liked Songs</span>
              <span className="libitem-sub">Playlist{likedCount != null ? ` · ${likedCount} songs` : ''}</span>
            </span>
          </button>

          {playlists.map((pl) => {
            const art = jf.imageUrl(pl.Id, { maxHeight: 84 });
            return (
              <button key={pl.Id} className="libitem" onClick={() => onOpen(pl)} title={pl.Name}>
                {art ? <img src={art} alt="" loading="lazy" /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{pl.Name}</span>
                  <span className="libitem-sub">Playlist{pl.ChildCount ? ` · ${pl.ChildCount} songs` : ''}</span>
                </span>
              </button>
            );
          })}

          {!playlists.length && !loading && (
            <p className="devicemenu-empty">
              Create your first playlist with the + button.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
