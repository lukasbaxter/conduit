import React, { useEffect, useState } from 'react';

function Card({ title, subtitle, image, onClick }) {
  return (
    <button className="card" onClick={onClick}>
      <div className="card-art">
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="card-art-empty" />}
        <span className="card-play">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </button>
  );
}

function TrackRow({ track, n, onPlay, active }) {
  const mins = track.RunTimeTicks ? track.RunTimeTicks / 10_000_000 : 0;
  const dur = `${Math.floor(mins / 60)}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;
  return (
    <button className={`trackrow ${active ? 'active' : ''}`} onClick={onPlay}>
      <span className="trackrow-n">{n}</span>
      <span className="trackrow-name">
        {track.Name}
        <small>{track.Artists?.join(', ')}</small>
      </span>
      <span className="trackrow-dur">{dur}</span>
    </button>
  );
}

export default function Library({ jf, player }) {
  const [tab, setTab] = useState('albums');
  const [albums, setAlbums] = useState([]);
  const [artists, setArtists] = useState([]);
  const [detail, setDetail] = useState(null); // {album, tracks}
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [a, r] = await Promise.all([jf.albums({ limit: 400 }), jf.artists({ limit: 400 })]);
        if (cancelled) return;
        setAlbums(a.items);
        setArtists(r.items);
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jf]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    if (!query.trim()) { setResults(null); return undefined; }
    const t = setTimeout(async () => {
      try {
        setResults(await jf.search(query.trim()));
      } catch (e) {
        setErr(e.message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, jf]);

  const openAlbum = async (album) => {
    try {
      const { items } = await jf.tracks({ albumId: album.Id });
      setDetail({ album, tracks: items });
    } catch (e) {
      setErr(e.message);
    }
  };

  const playAlbum = async (album, startIndex = 0) => {
    const { items } = await jf.tracks({ albumId: album.Id });
    if (items.length) player.playQueue(items, startIndex);
  };

  const startMix = async (item) => {
    try {
      const items = await jf.instantMix(item.Id);
      if (items.length) player.playQueue(items, 0);
    } catch (e) {
      setErr(e.message);
    }
  };

  if (detail) {
    const { album, tracks } = detail;
    return (
      <main className="library">
        <button className="back" onClick={() => setDetail(null)}>&larr; Back</button>
        <header className="detail-head">
          <img className="detail-art" src={jf.imageUrl(album.Id, { maxHeight: 320 })} alt="" />
          <div>
            <h1>{album.Name}</h1>
            <p>{album.AlbumArtist} {album.ProductionYear ? `· ${album.ProductionYear}` : ''} · {tracks.length} tracks</p>
            <div className="detail-actions">
              <button className="primary" onClick={() => playAlbum(album, 0)}>Play</button>
              <button onClick={() => startMix(album)}>Instant mix</button>
            </div>
          </div>
        </header>
        <div className="tracklist">
          {tracks.map((t, i) => (
            <TrackRow
              key={t.Id} track={t} n={i + 1}
              active={player.current?.Id === t.Id}
              onPlay={() => player.playQueue(tracks, i)}
            />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="library">
      <div className="toolbar">
        <input
          className="search"
          placeholder="Search your library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!results && (
          <div className="tabs">
            {['albums', 'artists'].map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <div className="banner error">{err}</div>}
      {loading && <div className="banner">Loading library...</div>}

      {results ? (
        <>
          {results.tracks.length > 0 && (
            <section>
              <h2>Tracks</h2>
              <div className="tracklist">
                {results.tracks.slice(0, 25).map((t, i) => (
                  <TrackRow key={t.Id} track={t} n={i + 1}
                    active={player.current?.Id === t.Id}
                    onPlay={() => player.playQueue(results.tracks, i)} />
                ))}
              </div>
            </section>
          )}
          {results.albums.length > 0 && (
            <section>
              <h2>Albums</h2>
              <div className="grid">
                {results.albums.map((a) => (
                  <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist}
                    image={jf.imageUrl(a.Id, { maxHeight: 320 })} onClick={() => openAlbum(a)} />
                ))}
              </div>
            </section>
          )}
          {!results.tracks.length && !results.albums.length && (
            <div className="banner">No matches for &ldquo;{query}&rdquo;.</div>
          )}
        </>
      ) : tab === 'albums' ? (
        <div className="grid">
          {albums.map((a) => (
            <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist}
              image={jf.imageUrl(a.Id, { maxHeight: 320 })} onClick={() => openAlbum(a)} />
          ))}
        </div>
      ) : (
        <div className="grid">
          {artists.map((a) => (
            <Card key={a.Id} title={a.Name} subtitle="Artist" image={jf.imageUrl(a.Id, { maxHeight: 320 })}
              onClick={() => startMix(a)} />
          ))}
        </div>
      )}
    </main>
  );
}
