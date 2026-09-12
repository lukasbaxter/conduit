import React, { useMemo, useRef, useState } from 'react';
import ContextMenu from './ContextMenu.jsx';
import { Heart, LikedCover } from './TrackRow.jsx';

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
export default function Sidebar({ view, onView, playlists, likedCount, onOpen, onOpenLiked, onCreate, jf, loading,
  savedAlbums = [], onOpenAlbum, player, prefs, onUpdatePrefs, onEditPlaylist, onDeletePlaylist, onFollowAlbum, onOpenArtist }) {
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [dragId, setDragId] = useState(null);
  const dragRef = useRef(null); // the drop handler must not depend on a re-render having happened
  const [overId, setOverId] = useState(null);

  // Your Library = playlists + saved albums, in the order you dragged them
  // into (kept in account prefs, so every device shows the same order and
  // follows a change live). New things go to the top, like Spotify.
  const entries = useMemo(() => {
    const all = [
      ...playlists.map((p) => ({ id: p.Id, kind: 'playlist', item: p })),
      ...savedAlbums.map((a) => ({ id: a.Id, kind: 'album', item: a })),
    ];
    const order = Array.isArray(prefs?.libraryOrder) ? prefs.libraryOrder : [];
    const pos = new Map(order.map((id, i) => [id, i]));
    const known = all.filter((e) => pos.has(e.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const fresh = all.filter((e) => !pos.has(e.id));
    return [...fresh, ...known];
  }, [playlists, savedAlbums, prefs?.libraryOrder]);

  const reorder = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const ids = entries.map((e) => e.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    onUpdatePrefs?.({ libraryOrder: ids });
  };

  const playEntry = async (e, enqueue = false) => {
    const { items } = e.kind === 'album' ? await jf.tracks({ albumId: e.id }) : await jf.playlistTracks(e.id);
    if (!items.length) return;
    if (enqueue) player.addToQueue(items); else player.playQueue(items, 0, e.id);
  };
  const menuItems = (e) => e.kind === 'liked' ? [
    { label: 'Play', onClick: async () => { const { items } = await jf.favoriteTracks(); if (items.length) player.playQueue(items, 0, 'liked'); } },
    { label: 'Add to queue', onClick: async () => { const { items } = await jf.favoriteTracks(); player.addToQueue(items); } },
  ] : e.kind === 'album' ? [
    { label: 'Play', onClick: () => playEntry(e) },
    { label: 'Add to queue', onClick: () => playEntry(e, true) },
    { sep: true },
    e.item.AlbumArtists?.[0]?.Id ? { label: 'Go to artist', onClick: () => onOpenArtist?.(e.item.AlbumArtists[0].Id) } : null,
    { label: 'Remove from Your Library', onClick: () => onFollowAlbum?.(e.item, false) },
  ] : [
    { label: 'Play', onClick: () => playEntry(e) },
    { label: 'Add to queue', onClick: () => playEntry(e, true) },
    { sep: true },
    { label: 'Edit details', onClick: () => onEditPlaylist?.(e.item) },
    { label: 'Delete', danger: true, onClick: () => { if (window.confirm(`Delete "${e.item.Name}"?`)) onDeletePlaylist?.(e.item); } },
  ];
  const openMenu = (ev, entry) => { ev.preventDefault(); ev.stopPropagation(); setMenu({ x: ev.clientX, y: ev.clientY, entry }); };

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

          <button className="libitem" onClick={onOpenLiked} onContextMenu={(ev) => openMenu(ev, { id: 'liked', kind: 'liked' })} title="Liked Songs">
            <LikedCover />
            <span className="libitem-text">
              <span className="libitem-name">Liked Songs</span>
              <span className="libitem-sub">Playlist{likedCount != null ? ` · ${likedCount} songs` : ''}</span>
            </span>
          </button>

          {entries.map((e) => {
            const it = e.item;
            const art = jf.imageUrl(it.Id, { maxHeight: 84 });
            const sub = e.kind === 'album'
              ? `Album · ${it.AlbumArtist || it.AlbumArtists?.[0]?.Name || ''}`
              : `Playlist${it.ChildCount ? ` · ${it.ChildCount} songs` : ''}`;
            return (
              <button
                key={e.id}
                className={`libitem ${overId === e.id && dragId && dragId !== e.id ? 'dropbefore' : ''} ${dragId === e.id ? 'dragging' : ''}`}
                onClick={() => (e.kind === 'album' ? onOpenAlbum?.(it.Id) : onOpen(it))}
                onContextMenu={(ev) => openMenu(ev, e)}
                title={it.Name}
                draggable
                onDragStart={() => { dragRef.current = e.id; setDragId(e.id); }}
                onDragOver={(ev) => { ev.preventDefault(); setOverId(e.id); }}
                onDragLeave={() => setOverId((o) => (o === e.id ? null : o))}
                onDrop={(ev) => { ev.preventDefault(); reorder(dragRef.current, e.id); dragRef.current = null; setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
              >
                {art ? <img src={art} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
                <span className="libitem-text">
                  <span className="libitem-name">{it.Name}</span>
                  <span className="libitem-sub">{sub}</span>
                </span>
              </button>
            );
          })}
          {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}

          {!entries.length && !loading && (
            <p className="devicemenu-empty">
              Create your first playlist with the + button.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
