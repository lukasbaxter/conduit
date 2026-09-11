import React, { useEffect, useState } from 'react';
import { Jellyfin, loadSession, persistSession, clearSession } from './api/jellyfin.js';
import { usePlayer } from './player/usePlayer.js';
import Sidebar from './components/Sidebar.jsx';
import Library from './components/Library.jsx';
import Player from './components/Player.jsx';

const DEFAULT_SERVER = 'http://192.168.1.85:2101';

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
        <label>
          Server
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck="false" />
        </label>
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
        <p className="login-hint">
          Use a LAN address, not localhost. Speakers fetch audio themselves, so the
          address has to be reachable from them too.
        </p>
      </form>
    </div>
  );
}

export default function App() {
  const [jf, setJf] = useState(null);
  const [devices, setDevices] = useState([]);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('home');
  const [filter, setFilter] = useState('albums');
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const player = usePlayer(jf);

  // Restore a saved session, but only if the token still works.
  useEffect(() => {
    const saved = loadSession();
    if (!saved) { setBooting(false); return; }
    const client = new Jellyfin(saved);
    client.albums({ limit: 1 })
      .then(() => setJf(client))
      .catch(() => clearSession())
      .finally(() => setBooting(false));
  }, []);

  // Load the library once connected; the sidebar and home page share it.
  useEffect(() => {
    if (!jf) return;
    Promise.all([jf.albums({ limit: 500 }), jf.artists({ limit: 500 })])
      .then(([a, r]) => { setAlbums(a.items); setArtists(r.items); })
      .catch(() => {});
  }, [jf]);

  // Device list is pushed from the main process as mDNS finds things.
  useEffect(() => {
    const api = window.conduit?.devices;
    if (!api) return undefined;
    api.list().then(setDevices).catch(() => {});
    return api.onChanged(setDevices);
  }, []);

  const signOut = () => { clearSession(); setJf(null); };

  const goView = (v) => { setDetail(null); setView(v); };

  const openFromSidebar = async (item) => {
    try {
      const { items } = filter === 'artists'
        ? await jf.tracks({ artistId: item.Id, limit: 200 })
        : await jf.tracks({ albumId: item.Id });
      setDetail({ item, tracks: items, kind: filter === 'artists' ? 'Artist' : 'Album' });
    } catch { /* surfaced in the library view */ }
  };

  if (booting) return <div className="boot">Starting Conduit...</div>;
  if (!jf) return <Login onConnected={setJf} />;

  return (
    <div className="app">
      <header className="navbar">
        <div className="brand">Conduit</div>
        <div className="navbar-right">
          <button className="linkbtn" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <div className="shell">
        <Sidebar
          view={view}
          onView={goView}
          items={filter === 'artists' ? artists : albums}
          filter={filter}
          onFilter={setFilter}
          onOpen={openFromSidebar}
          jf={jf}
        />
        <Library
          jf={jf}
          player={player}
          view={view}
          onView={goView}
          albums={albums}
          artists={artists}
          detail={detail}
          setDetail={setDetail}
          query={query}
          setQuery={setQuery}
        />
      </div>

      <Player player={player} jf={jf} devices={devices} />
    </div>
  );
}
