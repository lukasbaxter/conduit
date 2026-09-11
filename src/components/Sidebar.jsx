import React from 'react';

const ICONS = {
  home: 'M12 3 3 10v11h6v-6h6v6h6V10z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2',
  library: 'M4 4v16M9 4v16M14 5l5 15',
};

function Icon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * Left rail. "Your Library" is deliberately playlists only -- the things the
 * user actually made. Albums and artists live under Home and Search so the
 * library does not become a dump of all 3,291 albums.
 */
export default function Sidebar({ view, onView, playlists, onOpen, jf, loading }) {
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
        </div>

        <div className="liblist">
          {playlists.map((pl) => {
            const art = jf.imageUrl(pl.Id, { maxHeight: 84 });
            return (
              <button key={pl.Id} className="libitem" onClick={() => onOpen(pl)} title={pl.Name}>
                {art ? <img src={art} alt="" loading="lazy" /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{pl.Name}</span>
                  <span className="libitem-sub">
                    Playlist{pl.ChildCount ? ` · ${pl.ChildCount} songs` : ''}
                  </span>
                </span>
              </button>
            );
          })}

          {!playlists.length && !loading && (
            <p className="devicemenu-empty">
              No playlists yet. Ones you create in Jellyfin show up here.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
