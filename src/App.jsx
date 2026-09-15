import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Jellyfin, loadSession, persistSession, clearSession } from './api/jellyfin.js';
import { usePlayer } from './player/usePlayer.js';
import { Relay } from './relay.js';
import Sidebar from './components/Sidebar.jsx';
import Library, { LIKED_ID } from './components/Library.jsx';
import Player, { PlayingElsewhereBar, sessionDeviceOf } from './components/Player.jsx';
import RightPanel from './components/RightPanel.jsx';
import FullScreen from './components/FullScreen.jsx';
import { downloadTrack } from './api/download.js';
import { applyTheme, DEFAULT_THEME } from './api/prefs.js';
import { search as relaySearch, popular as relayPopular, likes as relayLikes, playlistTracks as relayPlaylist } from './api/search.js';
import { likesLoad, likesSet, likesSnapshot, likedIds, likesReady, isLiked, useLikesVersion } from './api/likes.js';
import { offsetsMerge } from './api/offsets.js';

// Everything goes through music.baxtergroup.io (Let's Encrypt on the origin,
// Cloudflare proxy deliberately off -- it throttles the audio). The browser
// build is same-origin; the desktop uses the same host, so it works off the
// LAN, and speakers stream from a URL with a real certificate.
const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
const DEFAULT_SERVER = IS_DESKTOP
  ? 'https://music.baxtergroup.io/jf'
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
        <div className="login-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.78-.96a.62.62 0 1 1-.28-1.22c3.8-.87 7.07-.5 9.7 1.12.3.18.4.57.22.86zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.5c3.64-1.1 8.16-.57 11.24 1.33.37.23.48.71.25 1.08zm.1-2.85C14.7 9.16 9.4 8.98 6.32 9.92a.94.94 0 1 1-.55-1.8c3.54-1.07 9.41-.87 13.13 1.34a.94.94 0 0 1-.96 1.62z" /></svg>
        </div>
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
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        {IS_DESKTOP && (
          <p className="login-hint">
            Default is the public address, which works at home and away. Speakers fetch
            audio themselves, so whatever you enter must be reachable from them too.
          </p>
        )}
      </form>
    </div>
  );
}

// Bottom tab glyphs (Spotify's home / search / library outlines; filled when on).
const TabHome = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z" /></svg>;
const TabSearch = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M15.356 10.558c0 2.623-2.16 4.75-4.823 4.75-2.664 0-4.824-2.127-4.824-4.75s2.16-4.75 4.824-4.75c2.664 0 4.823 2.127 4.823 4.75z" /><path d="M1.126 10.558c0-5.14 4.226-9.28 9.407-9.28 5.18 0 9.407 4.14 9.407 9.28a9.157 9.157 0 0 1-2.077 5.816l4.344 4.344a1 1 0 0 1-1.414 1.414l-4.353-4.353a9.454 9.454 0 0 1-5.907 2.058c-5.18 0-9.407-4.14-9.407-9.28zm9.407-7.28c-4.105 0-7.407 3.274-7.407 7.28s3.302 7.279 7.407 7.279 7.407-3.273 7.407-7.28c0-4.005-3.302-7.278-7.407-7.278z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" /></svg>;
const TabLib = ({ on }) => on
  ? <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zM15.5 2.134A1 1 0 0 0 14 3v18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.464a1 1 0 0 0-.5-.866l-6-3.464zM9 2a1 1 0 0 0-1 1v18a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1z" /></svg>
  : <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" /></svg>;

export default function App() {
  const [jf, setJf] = useState(null);
  const [devices, setDevices] = useState([]);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('home');
  const [playlists, setPlaylists] = useState([]);
  const [savedAlbums, setSavedAlbums] = useState([]);
  // Liked Songs count follows the like store; likedCacheRef holds the fetched
  // rows by id so the page paints instantly and in the store's order.
  const likesVersion = useLikesVersion();
  const likedCount = likesReady() ? likedIds().length : null;
  const likedCacheRef = useRef(new Map()); // itemId -> track row
  const setLikedCount = () => {};
  const [toast, setToast] = useState(null);
  const [me, setMe] = useState(null);
  const [avatarOk, setAvatarOk] = useState(true);
  const [userMenu, setUserMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  useEffect(() => {
    if (!appMenu) return undefined;
    const h = (e) => { if (!e.target.closest('.appmenuwrap')) setAppMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [appMenu]);
  // Closes on a click anywhere outside (not on mouse-leave: the pointer
  // crossing the gap between the avatar and the menu used to dismiss it).
  useEffect(() => {
    if (!userMenu) return undefined;
    const down = (e) => { if (!e.target.closest?.('.avatarwrap')) setUserMenu(false); };
    const key = (e) => { if (e.key === 'Escape') setUserMenu(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [userMenu]);
  // "New playlist" dialog: {track} while open. window.prompt() does not exist
  // in Electron, which is why creating a playlist from a row did nothing there.
  const [namePrompt, setNamePrompt] = useState(null);
  // Now-playing view (Spotify's expand button): Album / Visualizer / Lyrics
  // filling the app window. It never asks the OS for full screen itself; if
  // the window is already full screen it fills that.
  const [fullScreen, setFullScreen] = useState(false);
  // Phone layout (<= 760px): no sidebar; bottom tabs Home / Search / Library,
  // where Library shows the sidebar's list as a page until the next navigation.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const h = () => setIsMobile(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  const [mobileLib, setMobileLib] = useState(false);
  const openFullScreen = () => setFullScreen(true);
  const closeFullScreen = () => setFullScreen(false);
  // Account settings: theme + playback quality. Loaded from Jellyfin, applied
  // to the CSS variables, kept in sync across clients over the relay.
  const [prefs, setPrefs] = useState({ theme: DEFAULT_THEME, quality: 'original' });
  const [avatarV, setAvatarV] = useState(0);
  const [nameDraft, setNameDraft] = useState('');

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

  // Right panel (queue / lyrics) width: drag the gap between content and panel.
  const PANEL_MIN = 280, PANEL_MAX = 560;
  const [panelW, setPanelW] = useState(() => { try { const v = Number(localStorage.getItem('conduit.panelW')); return v >= PANEL_MIN ? Math.min(PANEL_MAX, v) : 340; } catch { return 340; } });
  const onPanelDown = useCallback((e) => {
    e.preventDefault();
    const start = { x: e.clientX, w: panelW };
    setResizing(true);
    const move = (ev) => setPanelW(Math.min(PANEL_MAX, Math.max(PANEL_MIN, start.w - (ev.clientX - start.x))));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setPanelW((w) => { try { localStorage.setItem('conduit.panelW', String(w)); } catch {} return w; });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [panelW]);

  // Double-click toggles between collapsed and the default width.
  const onRailDouble = () => {
    setRailW((w) => { const n = w <= RAIL_COLLAPSED ? 280 : RAIL_COLLAPSED; try { localStorage.setItem('conduit.railW', String(n)); } catch {} return n; });
  };
  const [libLoading, setLibLoading] = useState(true);
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  const [detail, setDetailRaw] = useState(null);
  const [seeAll, setSeeAllRaw] = useState(null); // 'albums' | 'artists' | null
  useEffect(() => { setMobileLib(false); }, [view, detail?.item?.Id, seeAll]); // any navigation leaves the phone's Library tab
  // Which tab's stack the phone is in: a detail opened from Your Library keeps
  // the Library tab lit (Spotify's per-tab navigation stacks); Home/Search
  // follow the view.
  const [mobileTab, setMobileTab] = useState('home');
  useEffect(() => { if (view === 'home' || view === 'search') setMobileTab(view); }, [view]);
  useEffect(() => { if (mobileLib) setMobileTab('library'); }, [mobileLib]);
  const [query, setQuery] = useState('');

  // Back / forward like Spotify's header arrows. One entry per place you can
  // be: {view, detail, seeAll}. A detail that merely refreshes (a playlist
  // streaming its tracks in) updates the current entry instead of pushing.
  const histRef = useRef({ stack: [{ view: 'home', detail: null, seeAll: null }], idx: 0 });
  const [histTick, setHistTick] = useState(0);
  const applyEntry = (e) => { setView(e.view); setDetailRaw(e.detail); setSeeAllRaw(e.seeAll); };
  const pushEntry = (e) => {
    const h = histRef.current;
    h.stack = h.stack.slice(0, h.idx + 1); h.stack.push(e); h.idx = h.stack.length - 1;
    setHistTick((t) => t + 1);
  };
  const currentEntry = () => histRef.current.stack[histRef.current.idx];
  const setDetail = (next) => {
    setDetailRaw((prev) => {
      const d = typeof next === 'function' ? next(prev) : next;
      const cur = currentEntry();
      if ((d?.item?.Id || null) === (cur.detail?.item?.Id || null)) {
        histRef.current.stack[histRef.current.idx] = { ...cur, detail: d };
      } else {
        pushEntry({ view: cur.view, detail: d, seeAll: d ? null : cur.seeAll });
        if (d) setSeeAllRaw(null);
      }
      return d;
    });
  };
  const setSeeAll = (v) => { setSeeAllRaw(v); setDetailRaw(null); pushEntry({ view: 'home', detail: null, seeAll: v }); setView('home'); };
  const goBack = () => { const h = histRef.current; if (h.idx > 0) { h.idx -= 1; applyEntry(h.stack[h.idx]); setHistTick((t) => t + 1); } };
  const goForward = () => { const h = histRef.current; if (h.idx < h.stack.length - 1) { h.idx += 1; applyEntry(h.stack[h.idx]); setHistTick((t) => t + 1); } };
  const canBack = histRef.current.idx > 0;
  // Mouse back / forward buttons (buttons 3 and 4) drive the in-app history in
  // the browser and on the desktop; the browser's own navigation is suppressed.
  // Electron on macOS also delivers them as app-command events via the main process.
  const navRef = useRef({ goBack, goForward }); navRef.current = { goBack, goForward };
  useEffect(() => {
    const onMouse = (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) navRef.current.goBack(); else navRef.current.goForward();
    };
    window.addEventListener('mouseup', onMouse);
    // Chromium fires the page navigation on mousedown/auxclick too; swallow both.
    const swallow = (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener('mousedown', swallow);
    window.addEventListener('auxclick', swallow);
    const off = window.conduit?.onNavigate?.((dir) => (dir === 'back' ? navRef.current.goBack() : navRef.current.goForward()));
    return () => { window.removeEventListener('mouseup', onMouse); window.removeEventListener('mousedown', swallow); window.removeEventListener('auxclick', swallow); off?.(); };
  }, []); // registered once; the ref always points at the current history
  const canForward = histRef.current.idx < histRef.current.stack.length - 1;
  // null | 'npv' | 'queue' | 'lyrics'
  const [panel, setPanel] = useState(null);
  const player = usePlayer(jf);

  // Restore a saved session, but only if the token still works.
  useEffect(() => {
    const saved = loadSession();
    if (saved) {
      // Sessions from before the switch to the public host still point at the
      // LAN address; the token is not host-bound, so just move them over.
      if (IS_DESKTOP && /^http:\/\/192\.168\.1\.85:2101/.test(saved.baseUrl || '')) {
        saved.baseUrl = DEFAULT_SERVER; persistSession(saved);
      }
      const client = new Jellyfin(saved);
      setJf(client);
      // Paint instantly from the last run's data; the fetch below refreshes it.
      const alb = client.persisted('albums'); if (alb) setAlbums(alb);
      const art = client.persisted('artists'); if (art) setArtists(art);
      const pls = client.persisted('playlists'); if (pls) setPlaylists(pls);
      const sal = client.persisted('savedAlbums'); if (sal) setSavedAlbums(sal);
      const lk = client.persisted('liked'); if (Array.isArray(lk)) likedCacheRef.current = new Map(lk.map((t) => [t.Id, t]));
      if (alb) setLibLoading(false);
    }
    setBooting(false);
  }, []);

  useEffect(() => {
    if (!jf) return;
    jf.me().then(setMe).catch(() => {});
    setAvatarOk(true);
    // Paint the last known theme instantly, then the account's saved one.
    const cached = jf.persisted('prefs');
    if (cached) { setPrefs((p) => ({ ...p, ...cached })); applyTheme(cached.theme); jf.quality = cached.quality || 'original'; }
    jf.getPrefs().then((p) => {
      const next = { ...p, theme: { ...DEFAULT_THEME, ...(p.theme || {}) }, quality: p.quality || 'original' };
      setPrefs(next); applyTheme(next.theme); jf.quality = next.quality; jf._persist('prefs', next);
    }).catch(() => {});
  }, [jf]);

  // The like store: loaded from the relay (which seeds/reconciles with
  // Jellyfin's favourites). The old prefs-blob timestamps are sent once so
  // they keep their dates, then never touched again.
  useEffect(() => {
    if (!jf) return;
    const seed = prefs.likedAt && Object.keys(prefs.likedAt).length ? prefs.likedAt : null;
    relayLikes(jf, seed).then((m) => { likesLoad(m); jf.likedAt = m; }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jf, prefs.likedAt ? 1 : 0]);
  useEffect(() => { if (jf) jf.likedAt = likesSnapshot(); }, [jf, likesVersion]);

  // Change a setting: apply here, save to the account, nudge the other clients.
  const updatePrefs = async (patch) => {
    // Only the PATCH travels (to Jellyfin and over the relay); every client
    // merges it. Broadcasting whole prefs objects let a stale client overwrite
    // what another had just saved.
    setPrefs((cur) => { const next = { ...cur, ...patch }; applyTheme(next.theme); jf.quality = next.quality; jf._persist('prefs', next); return next; });
    player.relay?.sendPrefs?.(patch);
    try { await jf.setPrefs(patch); } catch (e) { notify(`Could not save settings: ${e.message}`); }
  };
  const onUploadAvatar = async (file) => {
    try { await jf.uploadUserImage(file); setAvatarOk(true); setAvatarV(Date.now()); notify('Profile picture updated'); }
    catch (e) { notify(`Could not upload: ${e.message}`); }
  };
  const openSettings = () => {
    setView('home');
    setDetail({ item: { Id: 'settings', Name: 'Settings', Type: 'Settings' }, tracks: [], kind: 'Settings' });
  };

  // Load the library once connected. Albums/artists feed Home and Search;
  // playlists are what "Your Library" shows.
  useEffect(() => {
    if (!jf) return;
    jf.albums({ limit: 500 }).then((a) => { setAlbums(a.items); jf._persist('albums', a.items); })
      .catch((e) => { if (String(e).includes('401')) { clearSession(); setJf(null); } })
      .finally(() => setLibLoading(false));
    jf.artists({ limit: 500 }).then((r) => { setArtists(r.items); jf._persist('artists', r.items); }).catch(() => {});
    jf.playlists().then((p) => { setPlaylists(p.items); jf._persist('playlists', p.items); }).catch(() => {});
    jf.favoriteAlbums().then((a) => { setSavedAlbums(a.items); jf._persist('savedAlbums', a.items); }).catch(() => {});
  }, [jf]);

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const refreshPlaylists = async () => {
    try {
      const [p, n, a] = await Promise.all([jf.playlists(), jf.favoriteCount(), jf.favoriteAlbums()]);
      setPlaylists(p.items); setLikedCount(n); setSavedAlbums(a.items);
      jf._persist('playlists', p.items); jf._persist('likedCount', n); jf._persist('savedAlbums', a.items);
    } catch { /* ignore */ }
  };

  // Update a track's liked state everywhere it is currently shown.
  const patchLiked = () => {}; // hearts read the like store now
  const reconcile = (tracks) => tracks;

  // Device list is pushed from the main process as mDNS finds things.
  useEffect(() => {
    const api = window.conduit?.devices;
    if (!api) return undefined;
    api.list().then(setDevices).catch(() => {});
    return api.onChanged(setDevices);
  }, []);

  // Relay: register this client, surface the user's other clients as players,
  // and execute commands routed to us. Audio never touches the relay.
  useEffect(() => {
    if (!jf) return undefined;
    const relay = new Relay({
      token: jf.token,
      name: (typeof window !== 'undefined' && window.conduit?.deviceName) || (window.conduit ? 'Conduit Desktop' : 'This Browser'),
      kind: window.conduit ? 'desktop' : 'web',
      canPlay: true,
      onRoster: (r) => player.applyRoster(r),
      onCommand: (cmd) => player.executeCommand(cmd),
      onQueue: (from, q) => player.applyRemoteQueue(from, q),
      onSession: (s) => player.applySession(s),
      onPrefs: (p) => {
        const patch = { ...p }; delete patch._libraryChanged;
        setPrefs((cur) => {
          const next = { ...cur, ...patch };
          if (patch.theme) next.theme = { ...DEFAULT_THEME, ...patch.theme };
          applyTheme(next.theme); jf.quality = next.quality || 'original'; jf._persist('prefs', next);
          return next;
        });
        if (p._libraryChanged && p._libraryChanged !== relayLibraryPing.current) { relayLibraryPing.current = p._libraryChanged; refreshPlaylists(); }
      },
      // Another client liked / unliked: keep the timestamp map and the hearts in step.
      onLike: ({ itemId, liked, at }) => { likesSet(itemId, liked, at); },
      // Speaker timing offsets measured by anyone on this relay.
      onOffsets: offsetsMerge,
    });
    player.attachRelay(relay);
    return () => { relay.close(); player.attachRelay(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jf]);

  // The player needs the raw speaker list to resolve a transfer that names a
  // device id (a browser picking one of this desktop's speakers).
  const { registerDevices } = player;
  useEffect(() => { registerDevices(devices); }, [devices, registerDevices]);

  // The desktop app tells the relay which LAN speakers it can see, so the
  // user's other clients on the same network can target them.
  useEffect(() => {
    const relay = player.relay;
    if (!window.conduit || !relay) return;
    relay.reportDevices(devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind })));
  }, [devices, player.relay]);

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

  const goView = (v) => { setDetailRaw(null); setSeeAllRaw(null); setView(v); pushEntry({ view: v, detail: null, seeAll: null }); };

  // Space anywhere = play/pause, unless you are typing. Only text fields
  // swallow it; a focused slider/button/link (the last thing you clicked)
  // must not eat the key, and a focused button must not fire its own click
  // on keyup as well (that would toggle twice and look like nothing happened).
  useEffect(() => {
    const typing = (t) => {
      if (!t) return false;
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
      if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes((t.type || 'text').toLowerCase());
      return false;
    };
    const onKey = (e) => {
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      player.toggle();
    };
    const onUp = (e) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, [player.toggle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playlist "Edit details": rename and/or a new cover.
  const onEditPlaylist = async (pl, { name, imageFile }) => {
    try {
      if (name && name !== pl.Name) await jf.renameItem(pl.Id, name);
      if (imageFile) { await jf.uploadPrimaryImage(pl.Id, imageFile); jf.bustImage(pl.Id); }
      // New playlists array + new detail item => sidebar, home shortcuts and
      // the hero all re-render with the busted image URL right away.
      await refreshPlaylists();
      setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, item: { ...d.item, Name: name || d.item.Name, _v: Date.now() } } : d));
      notify('Playlist updated');
    } catch (e) { notify(`Could not update playlist: ${e.message}`); }
  };
  const onDeletePlaylist = async (pl) => {
    try {
      await jf.deleteItem(pl.Id);
      await refreshPlaylists();
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
      setDetail(null);
      notify(`Deleted ${pl.Name}`);
    } catch (e) { notify(`Could not delete: ${e.message}`); }
  };

  // Footer links: art -> album, artist name -> artist page.
  // Navigation is instant: the page opens in its loading state on the click
  // and fills in as data lands, instead of the click doing nothing for the
  // seconds Jellyfin takes.
  const openAlbumById = async (albumId, known = null) => {
    setView('home');
    setDetail({ item: known || { Id: albumId, Name: '' }, tracks: [], kind: 'Album', loading: true });
    try {
      const [meta, trackList] = await Promise.all([jf.itemById(albumId), jf.tracks({ albumId })]);
      setDetail((d) => (d && d.item?.Id === albumId ? { ...d, item: meta || d.item, tracks: trackList.items, loading: false } : d));
    } catch { setDetail((d) => (d && d.item?.Id === albumId ? { ...d, loading: false } : d)); }
  };

  const openArtistById = async (artistId, known = null) => {
    setView('home');
    setDetail({ item: known || { Id: artistId, Name: '' }, tracks: [], albums: [], kind: 'Artist', loading: true });
    const alive = () => true;
    // Jellyfin's ArtistIds join takes ~1.7 s here; the search index answers the
    // same question (this artist's tracks, most played first) in ~20 ms.
    const fast = relaySearch(jf, '', { filter: `artistIds = "${artistId}"`, limit: 150 }).then((r) => r.tracks).catch(() => null);
    const metaP = jf.itemById(artistId).then((meta) => { if (alive() && meta) setDetail((d) => (d && d.item?.Id === artistId ? { ...d, item: meta } : d)); return meta; }).catch(() => null);
    jf.artistAlbums(artistId).then((a) => setDetail((d) => (d && d.item?.Id === artistId ? { ...d, albums: a.items } : d))).catch(() => {});
    try {
      let tracks = await fast;
      if (!tracks || !tracks.length) tracks = (await jf.tracks({ artistId, limit: 200 })).items;
      setDetail((d) => (d && d.item?.Id === artistId ? { ...d, tracks, loading: false } : d));
      // Popular = real-world order (Deezer top tracks matched to the library),
      // one row per title; the rest of the artist's tracks follow by plays.
      const name = known?.Name || (await metaP)?.Name;
      if (name) {
        const pop = await relayPopular(jf, artistId, name).catch(() => null);
        if (pop?.ids?.length) {
          const pos = new Map(pop.ids.map((id, i) => [id, i]));
          const known2 = tracks.filter((t) => pos.has(t.Id)).sort((a, b) => pos.get(a.Id) - pos.get(b.Id));
          const seen = new Set(known2.map((t) => t.Id));
          const rest = tracks.filter((t) => !seen.has(t.Id));
          const ordered = [...known2, ...rest];
          setDetail((d) => (d && d.item?.Id === artistId ? { ...d, tracks: ordered, popular: pop.ranked } : d));
        }
      }
    } catch { setDetail((d) => (d && d.item?.Id === artistId ? { ...d, loading: false } : d)); }
  };

  const openPlaylist = async (pl) => {
    setView('home');
    // Paint instantly from the last session's copy if we have one.
    const cached = jf.persisted(`pl.${pl.Id}`);
    setDetail({ item: pl, tracks: reconcile(cached || [], 0), kind: 'Playlist', loading: !cached });
    const since = Date.now();
    // Fast path: the relay reads Jellyfin's playlist.xml and answers from the
    // search index in ~20 ms (Jellyfin itself takes ~0.5 s per 100 tracks).
    // Jellyfin's own copy (the truth for liked / played state) follows behind.
    let fast = null;
    try {
      const r = await relayPlaylist(jf, pl.Id);
      if (r?.items?.length) { fast = r.items; setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(fast, since), loading: false } : d)); }
    } catch { /* relay down or a playlist it cannot read: Jellyfin below */ }
    try {
      // First page renders fast; the rest streams in behind. Virtualized, so the
      // visible rows are ready at once. Every result is persisted for next time.
      const first = await jf.playlistTracks(pl.Id, { startIndex: 0, limit: 100 });
      if (fast && first.total > first.items.length) {
        // Already showing the whole list from the relay: wait for the full copy
        // rather than flashing a 100-row version in between.
        const rest = await jf.playlistTracks(pl.Id);
        setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(rest.items, since), loading: false } : d));
        jf._persist(`pl.${pl.Id}`, rest.items);
        return;
      }
      setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(first.items, since), loading: false } : d));
      jf._persist(`pl.${pl.Id}`, first.items);
      if (first.total > first.items.length) {
        const rest = await jf.playlistTracks(pl.Id);
        setDetail((d) => (d && d.item?.Id === pl.Id ? { ...d, tracks: reconcile(rest.items, since) } : d));
        jf._persist(`pl.${pl.Id}`, rest.items);
      }
    } catch { /* keep the cached copy on screen */ }
  };

  // Spotify's profile page: avatar, top artists / tracks this month, playlists.
  const openProfile = async () => {
    const item = { Id: 'profile', Name: me?.Name || 'You', Type: 'Profile' };
    setView('home');
    setDetail({ item, tracks: [], kind: 'Profile', topArtists: [], loading: true });
    try {
      const top = await jf.topTracks({ limit: 60 });
      const score = new Map();
      for (const t of top) {
        const w = 1 + (t.UserData?.PlayCount || 0);
        for (const a of t.ArtistItems || []) {
          const e = score.get(a.Id) || { Id: a.Id, Name: a.Name, n: 0 };
          e.n += w; score.set(a.Id, e);
        }
      }
      const topArtists = [...score.values()].sort((a, b) => b.n - a.n).slice(0, 16);
      setDetail((d) => (d && d.item?.Id === 'profile' ? { ...d, tracks: top.slice(0, 10), topArtists, loading: false } : d));
    } catch { setDetail((d) => (d && d.item?.Id === 'profile' ? { ...d, loading: false } : d)); }
  };

  const openHistory = () => {
    setView('home');
    setDetail({ item: { Id: 'history', Name: 'Listening history', Type: 'History' }, tracks: [], kind: 'History', loading: false });
  };

  // Liked Songs = the store's ids, newest first; rows fetched by id (chunks of
  // 150) and cached so a reopen paints at once. No Filters=IsFavorite query,
  // so nothing can "vanish" between an optimistic row and a server list.
  const likedRows = (ids) => ids.map((id) => likedCacheRef.current.get(id)).filter(Boolean);
  const openLiked = async () => {
    const item = { Id: LIKED_ID, Name: 'Liked Songs', Type: 'Playlist' };
    setView('home');
    const ids = likedIds();
    setDetail({ item, tracks: likedRows(ids), kind: 'Playlist', loading: ids.some((id) => !likedCacheRef.current.has(id)) });
    const missing = ids.filter((id) => !likedCacheRef.current.has(id));
    try {
      for (let i = 0; i < missing.length; i += 150) {
        const rows = await jf.itemsByIds(missing.slice(i, i + 150));
        for (const r of rows) likedCacheRef.current.set(r.Id, r);
        setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()), loading: i + 150 < missing.length } : d));
      }
      setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()), loading: false } : d));
      jf._persist('liked', likedRows(likedIds()).slice(0, 1500));
    } catch { setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, loading: false } : d)); }
  };
  // Keep the open Liked Songs page in step with the store (likes from any client).
  useEffect(() => {
    setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()) } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likesVersion]);

  const onLike = async (track, liked) => {
    likesSet(track.Id, liked);
    // The relay stores it, writes the Jellyfin favourite through, and echoes it
    // to every client (this one included, with the server's timestamp).
    if (player.relay?.connected) player.relay.sendLike(track.Id, liked);
    else { try { await jf.setFavorite(track.Id, liked); } catch (e) { likesSet(track.Id, !liked); notify(`Not saved: ${e.message.slice(0, 60)}`); return; } }
    notify(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
    // Keep the row so Liked Songs can show it without a fetch.
    if (liked) {
      let row = track;
      if (track._partial) { try { const full = await jf.itemById(track.Id); if (full) row = full; } catch { /* partial is fine */ } }
      likedCacheRef.current.set(track.Id, row);
      setDetail((d) => (d && d.item?.Id === LIKED_ID ? { ...d, tracks: likedRows(likedIds()) } : d));
    }
  };

  // "Save to Your Library" for an album: a Jellyfin favourite on the album.
  const onFollowAlbum = async (album, on) => {
    setDetail((d) => (d && d.item?.Id === album.Id ? { ...d, item: { ...d.item, UserData: { ...(d.item.UserData || {}), IsFavorite: on } } } : d));
    setSavedAlbums((list) => (on ? [album, ...list.filter((a) => a.Id !== album.Id)] : list.filter((a) => a.Id !== album.Id)));
    try {
      await jf.setFavorite(album.Id, on);
      notify(on ? 'Added to Your Library' : 'Removed from Your Library');
      const a = await jf.favoriteAlbums(); setSavedAlbums(a.items); jf._persist('savedAlbums', a.items);
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
    } catch (e) { notify(`Could not update: ${e.message}`); }
  };
  // Another client changed the library (saved an album, made a playlist).
  const relayLibraryPing = useRef(0);

  const onCreatePlaylist = async (name, firstTrack = null) => {
    try {
      await jf.createPlaylist(name, firstTrack ? [firstTrack.Id] : []);
      await refreshPlaylists();
      player.relay?.sendPrefs?.({ _libraryChanged: Date.now() });
      notify(firstTrack ? `Added to ${name}` : `Created ${name}`);
    } catch (e) { notify(`Could not create playlist: ${e.message}`); }
  };

  const onNewPlaylistWithTrack = (track) => {
    setNameDraft(track.Album || 'My Playlist');
    setNamePrompt({ track });
  };
  const submitNamePrompt = (e) => {
    e?.preventDefault?.();
    const name = nameDraft.trim();
    const track = namePrompt?.track;
    setNamePrompt(null);
    if (name) onCreatePlaylist(name, track || null);
  };

  // Thumbs-down in Jellyfin terms: instant mixes and smart shuffle skip it.
  const onExclude = async (track, excluded) => {
    const patch = (t) => t.Id === track.Id ? { ...t, UserData: { ...(t.UserData || {}), Likes: excluded ? false : null } } : t;
    setDetail((d) => d ? { ...d, tracks: d.tracks.map(patch) } : d);
    player.patchQueue?.(patch);
    try {
      await jf.setDislike(track.Id, excluded);
      notify(excluded ? 'Excluded from your taste profile' : 'Included in your taste profile');
    } catch (e) { notify(`Could not update: ${e.message}`); }
  };

  const onDownload = async (track, fmt) => {
    notify(fmt === 'wav' ? 'Converting to WAV...' : 'Downloading...');
    try { await downloadTrack(jf, track, fmt); }
    catch (e) { notify(`Download failed: ${e.message}`); }
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

  // Test hook: drive playback/transfer from the headless test. Gated on ?debug.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('debug')) {
      window.__jf = jf; window.__player = player; window.__onLike = onLike; window.__updatePrefs = updatePrefs;
    }
  }, [jf, player]);

  // Phone detail pages: how far the page has scrolled (0..1 over the hero) drives
  // the top bar's opacity, and its tint comes from the page's --hero colour.
  // Scroll events do not bubble, so the shell listens in the capture phase.
  const shellRef = useRef(null);
  const [topbar, setTopbar] = useState(0);
  const [topbarBg, setTopbarBg] = useState('#121212');
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !isMobile) return undefined;
    const onScroll = (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains('content')) return;
      const hero = el.querySelector('.hero');
      const span = hero ? Math.max(120, hero.offsetHeight - 60) : 160;
      setTopbar(Math.max(0, Math.min(1, (el.scrollTop - 40) / span)));
      setTopbarBg(getComputedStyle(el).getPropertyValue('--hero').trim() || '#121212');
    };
    shell.addEventListener('scroll', onScroll, true);
    return () => shell.removeEventListener('scroll', onScroll, true);
  }, [isMobile, booting, jf]); // the shell only exists once signed in
  useEffect(() => { setTopbar(0); const el = shellRef.current?.querySelector('.content'); if (el) setTopbarBg(getComputedStyle(el).getPropertyValue('--hero').trim() || '#121212'); }, [detail?.item?.Id, seeAll]);
  // iOS-style edge swipe: a drag that starts on the left edge goes back.
  useEffect(() => {
    if (!isMobile) return undefined;
    let start = null;
    const down = (e) => { const t = e.touches?.[0]; start = t && t.clientX < 28 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; };
    const up = (e) => {
      if (!start) return;
      const t = e.changedTouches?.[0]; if (!t) return;
      const dx = t.clientX - start.x, dy = Math.abs(t.clientY - start.y);
      if (dx > 70 && dy < 60 && Date.now() - start.at < 700 && !fullScreen && !panel) goBack();
      start = null;
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchend', up); };
  }, [isMobile, fullScreen, panel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (booting) return <div className="boot">Starting Conduit...</div>;
  if (!jf) return <Login onConnected={setJf} />;

  // Phone chrome: root tabs show avatar + page title (Spotify's Home/Search/
  // Library headers); detail pages hide the bar and float a back chevron.
  const mobileDetail = isMobile && !mobileLib && (detail || seeAll);
  const mobileTitle = mobileLib ? 'Your Library' : view === 'search' ? 'Search' : '';
  const detailTitle = detail?.item?.Name || (seeAll === 'albums' ? 'Albums' : seeAll === 'artists' ? 'Artists' : '');
  return (
    <div className={`app ${isMobile ? 'mobile' : ''} ${mobileDetail ? 'mobile-detail' : ''}`}>
      {mobileDetail && (
        // Spotify's detail header: a round back chevron floating over the hero
        // that becomes a solid bar carrying the title once the hero scrolls away.
        <div className="mobile-topbar" style={{ '--topbar': topbar, '--topbar-bg': topbarBg }}>
          <button className="mobile-back" onClick={goBack} title="Go back" aria-label="Go back">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15.957 2.793a1 1 0 0 1 0 1.414L8.164 12l7.793 7.793a1 1 0 1 1-1.414 1.414L5.336 12l9.207-9.207a1 1 0 0 1 1.414 0z" /></svg>
          </button>
          <div className="mobile-topbar-title">{detailTitle}</div>
        </div>
      )}
      <header className="navbar">
        {/* App menu (the ⋯ Spotify keeps at the top-left), then history arrows. */}
        <div className="appmenuwrap">
          <button className="appmenu-btn" onClick={() => setAppMenu((v) => !v)} title="Menu" aria-label="Menu">
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor"><circle cx="2.25" cy="8" r="2" /><circle cx="8" cy="8" r="2" /><circle cx="13.75" cy="8" r="2" /></svg>
          </button>
          {appMenu && (
            <div className="avatarmenu appmenu">
              <button onClick={() => { setAppMenu(false); goView('home'); }}>Home</button>
              <button onClick={() => { setAppMenu(false); goView('search'); }}>Search</button>
              <div className="ctxmenu-sep" />
              <button onClick={() => { setAppMenu(false); openProfile(); }}>Profile</button>
              <button onClick={() => { setAppMenu(false); openHistory(); }}>History</button>
              <button onClick={() => { setAppMenu(false); openSettings(); }}>Settings</button>
              <div className="ctxmenu-sep" />
              <button onClick={() => { setAppMenu(false); window.location.reload(); }}>Reload</button>
              <button onClick={signOut}>Log out</button>
            </div>
          )}
        </div>
        {isMobile && <div className="mobile-title">{mobileTitle}</div>}
        <div className="navarrows">
          <button className="navarrow" onClick={goBack} disabled={!canBack} title="Go back">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 1.5 4 8l6.5 6.5" /></svg>
          </button>
          <button className="navarrow" onClick={goForward} disabled={!canForward} title="Go forward">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 1.5 6.5 6.5-6.5 6.5" /></svg>
          </button>
        </div>
        <div className="navbar-right">
          <div className="avatarwrap">
            <button className="avatar" onClick={() => setUserMenu((v) => !v)} title={me?.Name || 'Account'}>
              {avatarOk ? (
                <img key={avatarV} src={jf.userImageUrl()} alt="" onError={() => setAvatarOk(false)} />
              ) : (
                (me?.Name || '?').slice(0, 1).toUpperCase()
              )}
            </button>
            {userMenu && (
              <div className="avatarmenu">
                <button className="who" onClick={() => { setUserMenu(false); openProfile(); }}>{me?.Name || 'Signed in'}</button>
                <div className="sub">{jf.baseUrl.replace(/^https?:\/\//, '')}</div>
                <button onClick={() => { setUserMenu(false); openProfile(); }}>Profile</button>
                <button onClick={() => { setUserMenu(false); openHistory(); }}>History</button>
                <button onClick={() => { setUserMenu(false); openSettings(); }}>Settings</button>
                <button onClick={signOut}>Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        ref={shellRef}
        className={`shell ${panel ? 'with-panel' : ''} ${railW <= RAIL_COLLAPSED ? 'rail-collapsed' : ''} ${resizing ? 'resizing' : ''} ${isMobile && mobileLib ? 'show-lib' : ''}`}
        style={{ '--rail-w': `${railW}px`, '--panel-w': `${panelW}px` }}
      >
        <Sidebar
          view={view}
          onView={goView}
          playlists={playlists}
          savedAlbums={savedAlbums}
          onOpenAlbum={openAlbumById}
          player={player}
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          onEditPlaylist={(pl) => { setDetail(null); openPlaylist(pl).then(() => setTimeout(() => window.dispatchEvent(new CustomEvent('conduit:editdetails')), 300)); }}
          onDeletePlaylist={onDeletePlaylist}
          onFollowAlbum={onFollowAlbum}
          onOpenArtist={openArtistById}
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
          onExclude={onExclude}
          onDownload={onDownload}
          seeAll={seeAll}
          setSeeAll={setSeeAll}
          onEditPlaylist={onEditPlaylist}
          onDeletePlaylist={onDeletePlaylist}
          me={me}
          onOpenProfile={openProfile}
          onOpenSettings={openSettings}
          prefs={prefs}
          onUpdatePrefs={updatePrefs}
          onUploadAvatar={onUploadAvatar}
          avatarV={avatarV}
          onFollowAlbum={onFollowAlbum}
        />
        {panel && <div className="panel-spacer rail-resizer" onPointerDown={onPanelDown} title="Drag to resize" role="separator" aria-orientation="vertical" />}
        {panel && (
          <RightPanel
            mode={panel}
            onMode={setPanel}
            onClose={() => setPanel(null)}
            player={player}
            jf={jf}
            onOpenArtist={openArtistById}
            onOpenAlbum={openAlbumById}
            onLike={onLike}
            onAddTo={onAddTo}
            playlists={playlists}
          />
        )}
      </div>

      {typeof window !== 'undefined' && window.location.search.includes('debug') && (
        <div style={{position:'fixed',top:60,right:8,zIndex:200,background:'#000',color:'#0f0',font:'11px monospace',padding:8,borderRadius:6,maxWidth:280,lineHeight:1.4,whiteSpace:'pre-wrap'}}>
          {`myId=${player.relay?.id?.slice(-4) || '?'}
active=${player.roster?.activeClientId?.slice(-4) || 'none'}
players=${(player.roster?.players||[]).map(p=>p.name.slice(0,10)+':'+p.id.slice(-4)).join(', ')}
SHOWING: ${player.nowPlaying?.title?.slice(0,24) || 'nothing'}
pos=${Math.round(player.position)} playing=${player.playing} vol=${player.volume}`}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {namePrompt && (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setNamePrompt(null); }}>
          <form className="modal" onSubmit={submitNamePrompt}>
            <h3>New playlist</h3>
            <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onFocus={(e) => e.target.select()} spellCheck="false" />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setNamePrompt(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={!nameDraft.trim()}>Create</button>
            </div>
          </form>
        </div>
      )}

      {isMobile && (
        <nav className="tabbar">
          {[['home', 'Home', TabHome], ['search', 'Search', TabSearch], ['library', 'Your Library', TabLib]].map(([k, label, Icon]) => {
            const on = mobileTab === k;
            // Tapping the lit tab pops its stack to the root, or scrolls a root page to the top.
            const tap = () => {
              if (on && !mobileDetail) { document.querySelector('.shell .content')?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
              setMobileTab(k);
              if (k === 'library') setMobileLib(true); else { setMobileLib(false); goView(k); }
            };
            return (
              <button key={k} className={on ? 'on' : ''} onClick={tap}>
                <Icon on={on} /><span>{label}</span>
              </button>
            );
          })}
        </nav>
      )}
      <Player
        player={player}
        jf={jf}
        devices={[...devices, ...player.relayDevices, ...player.lanDevices]}
        onOpenAlbum={openAlbumById}
        onOpenArtist={openArtistById}
        panel={panel}
        onPanel={setPanel}
        onLike={onLike}
        onFullScreen={openFullScreen}
      />
      <PlayingElsewhereBar player={player} />
      {fullScreen && <FullScreen player={player} jf={jf} onClose={closeFullScreen} onOpenArtist={openArtistById} onLike={onLike} prefs={prefs} onUpdatePrefs={updatePrefs} onPanel={setPanel} devices={[...devices, ...player.relayDevices, ...player.lanDevices]} sessionDevice={sessionDeviceOf(player, [...devices, ...player.relayDevices, ...player.lanDevices])} />}
    </div>
  );
}
