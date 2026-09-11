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
 * Left rail: primary navigation plus a live list of what is in the library.
 * The list doubles as a jump-to, so albums are reachable without going through
 * the grid first.
 */
export default function Sidebar({ view, onView, items, filter, onFilter, onOpen, jf }) {
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
          <button onClick={() => onFilter(filter === 'albums' ? 'artists' : 'albums')}>
            {filter === 'albums' ? 'Albums' : 'Artists'}
          </button>
        </div>

        <div className="liblist">
          {items.slice(0, 300).map((it) => {
            const art = jf.imageUrl(it.Id, { maxHeight: 84 });
            return (
              <button
                key={it.Id}
                className={`libitem ${filter === 'artists' ? 'round' : ''}`}
                onClick={() => onOpen(it)}
                title={it.Name}
              >
                {art ? <img src={art} alt="" loading="lazy" /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{it.Name}</span>
                  <span className="libitem-sub">
                    {filter === 'albums' ? it.AlbumArtist || 'Album' : 'Artist'}
                  </span>
                </span>
              </button>
            );
          })}
          {!items.length && <p className="devicemenu-empty">Nothing here yet.</p>}
        </div>
      </div>
    </aside>
  );
}
