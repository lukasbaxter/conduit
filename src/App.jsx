import React, { useEffect, useState } from 'react';
import { Jellyfin, loadSession, persistSession, clearSession } from './api/jellyfin.js';
import { usePlayer } from './player/usePlayer.js';
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
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://192.168.1.85:2101" spellCheck="false" />
        </label>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            autoFocus spellCheck="false" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {err && <div className="banner error">{err}</div>}

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
  const player = usePlayer(jf);

  // Restore a saved session, but only if the token still works.
  useEffect(() => {
    const saved = loadSession();
    if (!saved) { setBooting(false); return; }
    const client = new Jellyfin(saved);
    client
      .albums({ limit: 1 })
      .then(() => setJf(client))
      .catch(() => clearSession())
      .finally(() => setBooting(false));
  }, []);

  // Device list is pushed from the main process as mDNS finds things.
  useEffect(() => {
    const api = window.conduit?.devices;
    if (!api) return undefined;
    api.list().then(setDevices).catch(() => {});
    return api.onChanged(setDevices);
  }, []);

  const signOut = () => {
    clearSession();
    setJf(null);
  };

  if (booting) return <div className="boot">Starting Conduit...</div>;
  if (!jf) return <Login onConnected={setJf} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Conduit</div>
        <button className="linkbtn" onClick={signOut}>Sign out</button>
      </header>
      <Library jf={jf} player={player} />
      <Player player={player} jf={jf} devices={devices} />
    </div>
  );
}
