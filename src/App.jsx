import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Jellyfin, loadSession, persistSession, clearSession } from './api/jellyfin.js';
import { usePlayer } from './player/usePlayer.js';
import Sidebar from './components/Sidebar.jsx';
import Library, { LIKED_ID } from './components/Library.jsx';
import Player from './components/Player.jsx';
import RightPanel from './components/RightPanel.jsx';

// In Electron (desktop) we talk to Jellyfin on the LAN directly. In a browser
// (the PWA at music.baxtergroup.io) we go same-origin through the nginx proxy,
// so it works over HTTPS and off-network without CORS or mixed content.
const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
const DEFAULT_SERVER = IS_DESKTOP
  ? 'http://192.168.1.85:2101'
  : `${window.location.origin}/jf`;

function Login({ onConnected }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SERVER);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const jf = await Jellyfin.login(baseUrl.trim(), username, password);
      persistSession({ baseUrl: jf.baseUrl, token: jf.token, userId: jf.userId });
      onConnected(jf);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Conduit</h1>
        <p className="login-sub">Your library, on any speaker in the house.</p>
        {IS_DESKTOP && (
          <label>
            Server
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck="false" />
          </label>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus spellCheck="false" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="banner error" style={{ margin: 0 }}>{err}</div>}
        <button className="primary" disabled={busy || !username}>
          {busy ? 'Connecting...' : 'Connect'}
        </button>
        {IS_DESKTOP && (
          <p className="login-hint">
            Use a LAN address, not localhost. Speakers fetch audio themselves, so the
            address has to be reachable from them too.
          </p>
        )}
      </form>
    </div>
  );
}

export default function App() {
  const [jf, setJf] = useState(null);
  const [devices, setDevices] = useState([]);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('home');
  const [playlists, setPlaylists] = useState([]);
  const [likedCount, setLikedCount] = useState(null);
  const likedCacheRef = useRef(null);
  const [toast, setToast] = useState(null);
  const [me, setMe] = useState(null);
  const [avatarOk, setAvatarOk] = useState(true);
  const [userMenu, setUserMenu] = useState(false);

  // Left rail width. Spotify: drag the gap; below a threshold it snaps to an
  // icon-only rail; the chosen width survives restarts.
  const RAIL_MIN = 280, RAIL_MAX = 420, RAIL_COLLAPSED = 72, RAIL_SNAP = 200;
  const [railW, setRailW] = useState(() => {
    try { const v = Number(localStorage.getItem('conduit.railW')); return v >= RAIL_COLLAPSED ? v : 280; }
    catch { return 280; }
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef(null);

  const clampRail = (w) => (w < RAIL_SNAP ? RAIL_COLLAPSED : Math.min(RAIL_MAX, Math.max(RAIL_MIN, w)));

  const onRailDown = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: railW };
    setResizing(true);
    const move = (ev) => {
      const d = dragRef.current; if (!d) return;
      setRailW(clampRail(d.startW + (ev.clientX - d.startX)));
    };
    const up = () => {
      dragRef.current = null; setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRailW((w) => { try { localStorage.setItem('conduit.railW', String(w)); } catch {} return w; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [railW]);

  // Double-click toggles between collapsed and the default width.
  const onRailDouble = () => {
    setRailW((w) => { const n = w <= RAIL_COLLAPSED ? 280 : RAIL_COLLAPSED; try { localStorage.setItem('conduit.railW', String(n)); } catch {} return n; });
  };
  const [libLoading, setLibLoading] = useState(true);
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  // null | 'npv' | 'queue' | 'lyrics'
  const [panel, setPanel] = useState(null);
  const player = usePlayer(jf);

  // Restore a saved session, but only if the token still works.
  useEffect(() => {
    const saved = loadSession();
    if (saved) {
      const client = new Jellyfin(saved);
      setJf(client);
      // Paint instantly from the last run's data; the fetch below refreshes it.
      const alb = client.persisted('albums'); if (alb) setAlbums(alb);
      const art = client.persisted('artists'); if (art) setArtists(art);
      const pls = client.persisted('playlists'); if (pls) setPlaylists(pls);
      const lc = client.persisted('likedCount'); if (lc != null) setLikedCount(lc);
      const lk = client.persisted('liked'); if (lk) likedCacheRef.current = lk;
      if (alb) setLibLoading(false);
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!jf) return;
    jf.me().then(setMe).catch(() => {});
    setAvatarOk(true);
  }, [jf]);

  // Load the library once connected. Albums/artists feed Home and Search;
  // playlists are what "Your Library" shows.
  useEffect(() => {
    if (!jf) return;
    jf.albums({ limit: 500 }).then((a) => { setAlbums(a.items); jf._persist('albums', a.items); })
      .catch((e) => { if (String(e).includes('401')) { clearSession(); setJf(null); } })
      .finally(() => setLibLoading(false));
    jf.artists({ limit: 500 }).then((r) => { setArtists(r.items); jf._persist('artists', r.items); }).catch(() => {});
    jf.playlists().then((p) => { setPlaylists(p.items); jf._persist('playlists', p.items); }).catch(() => {});
    jf.favoriteCount().then((n) => { setLikedCount(n); jf._persist('likedCount', n); }).catch(() => {});
  }, [jf]);

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const refreshPlaylists = async () => {
    try {
      const [p, n] = await Promise.all([jf.playlists(), jf.favoriteCount()]);
      setPlaylists(p.items); setLikedCount(n);
    } catch { /* ignore */ }
  };

  // Update a track's liked state everywhere it is currently shown.
  const patchLiked = (trackId, liked) => {
    const patch = (t) => t.Id === trackId ? { ...t, UserData: { ...(t.UserData || {}), IsFavorite: liked } } : t;
    setDetail((d) => d ? { ...d, tracks: d.tracks.map(patch) } : d);
    player.patchQueue?.(patch);
  };

  // Device list is pushed from the main process as mDNS finds things.
  useEffect(() => {
    const api = window.conduit?.devices;
    if (!api) return undefined;
    api.list().then(setDevices).catch(() => {});
    return api.onChanged(setDevices);
  }, []);

  // Once speakers are known, show whatever the house is already playing rather
  // than reporting nothing. Runs once and never steals a session started here.
  //
  // Depend on the stable callback, NOT on `player`: usePlayer returns a memo
  // keyed partly on `position`, so `player` gets a fresh identity on every
  // 200ms tick. Depending on it re-ran this five times a second and buried
  // every speaker in status requests.
  const { adoptActive } = player;
  useEffect(() => {
    // Needs BOTH the speakers and a live Jellyfin session: the speaker says
    // what is playing, Jellyfin turns its stream URL into a real track.
    if (!devices.length || !jf) return;
    adoptActive(devices).catch(() => {});
  }, [devices, jf, adoptActive]);

  const signOut = () => { clearSession(); setJf(null); };

  const goView = (v) => { setDetail(null); setView(v); };

  // Footer links: art -> album, artist name -> artist page.
  const openAlbumById = async (albumId) => {
    try {
      const [meta, trackList] = await Promise.all([jf.itemById(albumId), jf.tracks({ albumId })]);
      if (meta) { setView('home'); setDetail({ item: meta, tracks: trackList.items, kind: 'Album' }); }
    } catch { /* ignore */ }
  };

  const openArtistById = async (artistId) => {
    try {
      const [meta, trackList] = await Promise.all([
        jf.itemById(artistId),
        jf.tracks({ artistId, limit: 200 }),
      ]);
      if (meta) { setView('home'); setDetail({ item: meta, tracks: trackList.items, kind: 'Artist' }); }
    } catch { /* ignore */ }
  };

  const openPlaylist = async (pl) => {
    setView('home');
    // Paint instantly from the last session's copy if we have one.
    const cached = jf.persisted(`pl.${pl.Id}`);
    setDetail({ item: pl, tracks: cached || [], kind: 'Playlist', loading: !cached });
    try {
      // First page renders fast; the rest streams in behind. Virtualized, so the
      // visible rows are ready at once. Every result is persisted for next time.
      const first = await jf.playlistTracks(pl.Id, { startIndex: 0, limit: 100 });
      setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: first.items, loading: false } : d));
      jf._persist(`pl.${pl.Id}`, first.items);
      if (first.total > first.items.length) {
        const rest = await jf.playlistTracks(pl.Id);
        setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: rest.items } : d));
        jf._persist(`pl.${pl.Id}`, rest.items);
      }
    } catch { /* keep the cached copy on screen */ }
  };

  const openLiked = async () => {
    const item = { Id: LIKED_ID, Name: 'Liked Songs', Type: 'Playlist' };
    // Navigate NOW with whatever we have; a 500-track fetch is not something to
    // make the click wait on.
    setView('home');
    setDetail({ item, tracks: likedCacheRef.current || [], kind: 'Playlist', loading: !likedCacheRef.current });
    try {
      const { items } = await jf.favoriteTracks();
      likedCacheRef.current = items;
      jf._persist('liked', items);
      setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: items, loading: false } : d));
    } catch { /* keep what we showed */ }
  };

  const onLike = async (track, liked) => {
    patchLiked(track.Id, liked);
    try {
      await jf.setFavorite(track.Id, liked);
      notify(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
      setLikedCount((c) => (c == null ? c : Math.max(0, c + (liked ? 1 : -1))));
      // Liked Songs view stays live: unliking drops the row, liking (e.g. the
      // now-playing track from the footer) prepends it, newest first like
      // Spotify. No re-opening the page.
      const row = { ...track, UserData: { ...(track.UserData || {}), IsFavorite: true } };
      const cache = likedCacheRef.current || [];
      likedCacheRef.current = liked ? [row, ...cache.filter((t) => t.Id !== track.Id)] : cache.filter((t) => t.Id !== track.Id);
      setDetail((d) => {
        if (!d || d.item?.Id !== LIKED_ID) return d;
        const without = d.tracks.filter((t) => t.Id !== track.Id);
        return { ...d, tracks: liked ? [row, ...without] : without };
      });
    } catch (e) {
      patchLiked(track.Id, !liked);
      notify(`Could not update: ${e.message}`);
    }
  };

  const onCreatePlaylist = async (name, firstTrack = null) => {
    try {
      await jf.createPlaylist(name, firstTrack ? [firstTrack.Id] : []);
      await refreshPlaylists();
      notify(firstTrack ? `Added to ${name}` : `Created ${name}`);
    } catch (e) { notify(`Could not create playlist: ${e.message}`); }
  };

  const onNewPlaylistWithTrack = (track) => {
    const name = window.prompt('New playlist name', track.Album || 'My Playlist');
    if (name && name.trim()) onCreatePlaylist(name.trim(), track);
  };

  const onAddTo = async (pl, track) => {
    try {
      await jf.addToPlaylist(pl.Id, [track.Id]);
      notify(`Added to ${pl.Name}`);
      refreshPlaylists();
      // If that playlist is open, show the new row.
      if (detail?.item?.Id === pl.Id) {
        const { items } = await jf.playlistTracks(pl.Id);
        setDetail((d) => d ? { ...d, tracks: items } : d);
      }
    } catch (e) { notify(`Could not add: ${e.message}`); }
  };

  const onRemoveFromPlaylist = async (pl, track) => {
    if (!track.PlaylistItemId) return;
    try {
      await jf.removeFromPlaylist(pl.Id, [track.PlaylistItemId]);
      setDetail((d) => d ? { ...d, tracks: d.tracks.filter((t) => t.PlaylistItemId !== track.PlaylistItemId) } : d);
      notify('Removed from playlist');
      refreshPlaylists();
    } catch (e) { notify(`Could not remove: ${e.message}`); }
  };

  const onReorder = async (pl, track, from, to) => {
    // Optimistic: move in the UI first, then tell Jellyfin.
    setDetail((d) => {
      if (!d) return d;
      const next = [...d.tracks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...d, tracks: next };
    });
    try {
      await jf.movePlaylistItem(pl.Id, track.PlaylistItemId, to);
    } catch (e) {
      notify(`Could not reorder: ${e.message}`);
      const { items } = await jf.playlistTracks(pl.Id).catch(() => ({ items: null }));
      if (items) setDetail((d) => d ? { ...d, tracks: items } : d);
    }
  };

  if (booting) return <div className="boot">Starting Conduit...</div>;
  if (!jf) return <Login onConnected={setJf} />;

  return (
    <div className="app">
      <header className="navbar">
        <div className="brand">Conduit</div>
        <div className="navbar-right">
          <div className="avatarwrap">
            <button className="avatar" onClick={() => setUserMenu((v) => !v)} title={me?.Name || 'Account'}>
              {avatarOk ? (
                <img src={jf.userImageUrl()} alt="" onError={() => setAvatarOk(false)} />
              ) : (
                (me?.Name || '?').slice(0, 1).toUpperCase()
              )}
            </button>
            {userMenu && (
              <div className="avatarmenu" onMouseLeave={() => setUserMenu(false)}>
                <div className="who">{me?.Name || 'Signed in'}</div>
                <div className="sub">{jf.baseUrl.replace(/^https?:\/\//, '')}</div>
                <button onClick={signOut}>Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        className={`shell ${panel ? 'with-panel' : ''} ${railW <= RAIL_COLLAPSED ? 'rail-collapsed' : ''} ${resizing ? 'resizing' : ''}`}
        style={{ '--rail-w': `${railW}px` }}
      >
        <Sidebar
          view={view}
          onView={goView}
          playlists={playlists}
          likedCount={likedCount}
          loading={libLoading}
          onOpen={openPlaylist}
          onOpenLiked={openLiked}
          onCreate={(name) => onCreatePlaylist(name)}
          jf={jf}
        />
        <div
          className="rail-resizer"
          onPointerDown={onRailDown}
          onDoubleClick={onRailDouble}
          title="Drag to resize. Double-click to collapse."
          role="separator"
          aria-orientation="vertical"
        />
        <Library
          jf={jf}
          player={player}
          view={view}
          onView={goView}
          albums={albums}
          artists={artists}
          playlists={playlists}
          detail={detail}
          setDetail={setDetail}
          query={query}
          setQuery={setQuery}
          onLike={onLike}
          onAddTo={onAddTo}
          onNewPlaylist={onNewPlaylistWithTrack}
          onRemoveFromPlaylist={onRemoveFromPlaylist}
          onReorder={onReorder}
          onOpenPlaylist={openPlaylist}
          onOpenLiked={openLiked}
          likedCount={likedCount}
          onOpenArtistById={openArtistById}
          onOpenAlbumById={openAlbumById}
        />
        {panel && <div className="panel-spacer" />}
        {panel && (
          <RightPanel
            mode={panel}
            onMode={setPanel}
            onClose={() => setPanel(null)}
            player={player}
            jf={jf}
            onOpenArtist={openArtistById}
            onOpenAlbum={openAlbumById}
          />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}

      <Player
        player={player}
        jf={jf}
        devices={devices}
        onOpenAlbum={openAlbumById}
        onOpenArtist={openArtistById}
        panel={panel}
        onPanel={setPanel}
        onLike={onLike}
      />
    </div>
  );
}
