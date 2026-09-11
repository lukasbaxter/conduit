import React, { useEffect, useMemo, useState } from 'react';

const PlayGlyph = ({ size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);

function Card({ title, subtitle, image, round, onOpen, onPlay }) {
  return (
    <div className={`card ${round ? 'round' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art">
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="ph" />}
        <button
          className="card-play"
          onClick={(e) => { e.stopPropagation(); onPlay?.(); }}
          title="Play"
        >
          <PlayGlyph />
        </button>
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </div>
  );
}

function TrackRow({ track, n, onPlay, active }) {
  const secs = track.RunTimeTicks ? track.RunTimeTicks / 10_000_000 : 0;
  const dur = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
  return (
    <button className={`trackrow ${active ? 'active' : ''}`} onClick={onPlay}>
      <span className="trackrow-n">{active ? <PlayGlyph size={13} /> : n}</span>
      <span className="trackrow-name">
        <span>{track.Name}</span>
        <small>{track.Artists?.join(', ')}</small>
      </span>
      <span className="trackrow-dur">{dur}</span>
    </button>
  );
}

function Shelf({ title, items, jf, round, onOpen, onPlay, onSeeAll }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="shelf-head">
        <h2>{title}</h2>
        {onSeeAll && <button onClick={onSeeAll}>Show all</button>}
      </div>
      <div className="shelf">
        {items.map((it) => (
          <Card
            key={it.Id}
            title={it.Name}
            subtitle={round ? 'Artist' : it.AlbumArtist}
            image={jf.imageUrl(it.Id, { maxHeight: 320 })}
            round={round}
            onOpen={() => onOpen(it)}
            onPlay={() => onPlay(it)}
          />
        ))}
      </div>
    </section>
  );
}

export default function Library({
  jf, player, view, onView, albums, artists, detail, setDetail, query, setQuery,
}) {
  const [results, setResults] = useState(null);
  const [err, setErr] = useState(null);
  const [seeAll, setSeeAll] = useState(null);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    if (view !== 'search' || !query.trim()) { setResults(null); return undefined; }
    const t = setTimeout(() => {
      jf.search(query.trim()).then(setResults).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query, jf, view]);

  const openAlbum = async (album) => {
    try {
      const { items } = await jf.tracks({ albumId: album.Id });
      setDetail({ item: album, tracks: items, kind: 'Album' });
    } catch (e) { setErr(e.message); }
  };

  const openArtist = async (artist) => {
    try {
      const [t, a] = await Promise.all([
        jf.tracks({ artistId: artist.Id, limit: 200 }),
        jf.artistAlbums(artist.Id).catch(() => ({ items: [] })),
      ]);
      setDetail({ item: artist, tracks: t.items, albums: a.items, kind: 'Artist' });
    } catch (e) { setErr(e.message); }
  };

  const open = (it) => (it.Type === 'MusicArtist' ? openArtist(it) : openAlbum(it));

  const playItem = async (it) => {
    try {
      const { items } = it.Type === 'MusicArtist'
        ? await jf.tracks({ artistId: it.Id, limit: 200 })
        : await jf.tracks({ albumId: it.Id });
      if (items.length) player.playQueue(items, 0);
    } catch (e) { setErr(e.message); }
  };

  const startMix = async (it) => {
    try {
      const items = await jf.instantMix(it.Id);
      if (items.length) player.playQueue(items, 0);
    } catch (e) { setErr(e.message); }
  };

  // Stable pseudo-random picks so the home page is not identical every render.
  const shelves = useMemo(() => {
    const pick = (arr, n) => arr.slice(0, n);
    const shuffled = [...albums].sort(() => Math.random() - 0.5);
    return {
      recent: pick(albums, 8),
      jump: pick(shuffled, 8),
      artists: pick(artists, 8),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums.length, artists.length]);

  // --- detail view --------------------------------------------------------
  if (detail) {
    const { item, tracks, kind } = detail;
    const isArtist = kind === 'Artist';
    const totalMin = Math.round(
      tracks.reduce((s2, t) => s2 + (t.RunTimeTicks || 0) / 10_000_000, 0) / 60
    );

    return (
      <div className="content">
        <button className="back" onClick={() => setDetail(null)}>&larr; Back</button>

        <header className={`hero ${isArtist ? 'artist' : ''}`}>
          <img src={jf.imageUrl(item.Id, { maxHeight: 464 })} alt="" />
          <div style={{ minWidth: 0 }}>
            {isArtist ? (
              <span className="verified">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M12 2 9.6 4.6 6.1 4l-.6 3.5L2 9.6 4.6 12 2 14.4l3.5 2.1.6 3.5 3.5-.6L12 22l2.4-2.6 3.5.6.6-3.5 3.5-2.1L19.4 12 22 9.6l-3.5-2.1-.6-3.5-3.5.6L12 2zm-1.2 13.6L7 11.8l1.4-1.4 2.4 2.4 4.8-4.8L17 9.4l-6.2 6.2z" />
                </svg>
                Verified Artist
              </span>
            ) : (
              <div className="kind">{kind}</div>
            )}
            <h1>{item.Name}</h1>
            <p>
              {!isArtist && item.AlbumArtist && <b>{item.AlbumArtist}</b>}
              {!isArtist && item.ProductionYear ? ` · ${item.ProductionYear}` : ''}
              {`${isArtist ? '' : ' · '}${tracks.length} tracks`}
              {totalMin ? `, about ${totalMin} min` : ''}
            </p>
          </div>
        </header>

        <div className="actions">
          <button className="bigplay" onClick={() => player.playQueue(tracks, 0)} title="Play">
            <PlayGlyph size={24} />
          </button>
          <button className="btn-secondary" onClick={() => startMix(item)}>Instant mix</button>
          {isArtist && <button className="btn-secondary" disabled title="Not wired up yet">Follow</button>}
        </div>

        {isArtist ? (
          <div className="pad">
            <section>
              <div className="shelf-head"><h2>Popular</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {tracks.slice(0, 10).map((t, i) => (
                  <TrackRow key={t.Id} track={t} n={i + 1}
                    active={player.current?.Id === t.Id}
                    onPlay={() => player.playQueue(tracks, i)} />
                ))}
              </div>
            </section>

            {detail.albums?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Discography</h2></div>
                <div className="grid">
                  {detail.albums.map((a) => (
                    <Card key={a.Id} title={a.Name}
                      subtitle={a.ProductionYear ? `${a.ProductionYear} · Album` : 'Album'}
                      image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                      onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="shelf-head"><h2>Fans also like</h2></div>
              <p className="placeholder-note">
                Similar artists need a metadata provider. Not wired up yet.
              </p>
            </section>

            <section>
              <div className="shelf-head"><h2>About</h2></div>
              <p className="placeholder-note">
                {item.Overview || 'No biography yet. These arrive with artist metadata.'}
              </p>
            </section>
          </div>
        ) : (
          <div className="tracklist">
            {tracks.map((t, i) => (
              <TrackRow key={t.Id} track={t} n={i + 1}
                active={player.current?.Id === t.Id}
                onPlay={() => player.playQueue(tracks, i)} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // --- see-all grid -------------------------------------------------------
  if (seeAll) {
    const items = seeAll === 'artists' ? artists : albums;
    return (
      <div className="content">
        <div className="contentbar">
          <button className="back" style={{ padding: 0 }} onClick={() => setSeeAll(null)}>&larr; Back</button>
          <h2 style={{ margin: 0, fontSize: 20 }}>{seeAll === 'artists' ? 'Artists' : 'Albums'}</h2>
        </div>
        <div className="pad">
          <div className="grid">
            {items.map((it) => (
              <Card key={it.Id} title={it.Name}
                subtitle={seeAll === 'artists' ? 'Artist' : it.AlbumArtist}
                image={jf.imageUrl(it.Id, { maxHeight: 320 })}
                round={seeAll === 'artists'}
                onOpen={() => open(it)} onPlay={() => playItem(it)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // --- search -------------------------------------------------------------
  if (view === 'search') {
    return (
      <div className="content">
        <div className="contentbar">
          <input className="search" autoFocus placeholder="What do you want to listen to?"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="pad">
          {err && <div className="banner error">{err}</div>}
          {!query.trim() && <p className="card-sub">Search your library by track, album or artist.</p>}
          {results && (
            <>
              {results.tracks.length > 0 && (
                <section>
                  <div className="shelf-head"><h2>Songs</h2></div>
                  <div className="tracklist" style={{ padding: 0 }}>
                    {results.tracks.slice(0, 20).map((t, i) => (
                      <TrackRow key={t.Id} track={t} n={i + 1}
                        active={player.current?.Id === t.Id}
                        onPlay={() => player.playQueue(results.tracks, i)} />
                    ))}
                  </div>
                </section>
              )}
              {results.albums.length > 0 && (
                <section>
                  <div className="shelf-head"><h2>Albums</h2></div>
                  <div className="grid">
                    {results.albums.map((a) => (
                      <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist}
                        image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                        onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                    ))}
                  </div>
                </section>
              )}
              {results.artists.length > 0 && (
                <section>
                  <div className="shelf-head"><h2>Artists</h2></div>
                  <div className="grid">
                    {results.artists.map((a) => (
                      <Card key={a.Id} title={a.Name} subtitle="Artist" round
                        image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                        onOpen={() => openArtist(a)} onPlay={() => startMix(a)} />
                    ))}
                  </div>
                </section>
              )}
              {!results.tracks.length && !results.albums.length && !results.artists.length && (
                <div className="banner">No matches for &ldquo;{query}&rdquo;.</div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // --- home ---------------------------------------------------------------
  return (
    <div className="content">
      <div className="contentbar">
        <div className="pills">
          <button className="pill on">All</button>
          <button className="pill" onClick={() => setSeeAll('albums')}>Albums</button>
          <button className="pill" onClick={() => setSeeAll('artists')}>Artists</button>
        </div>
      </div>
      <div className="pad">
        {err && <div className="banner error">{err}</div>}
        <Shelf title="Recently added" items={shelves.recent} jf={jf}
          onOpen={open} onPlay={playItem} onSeeAll={() => setSeeAll('albums')} />
        <Shelf title="Jump back in" items={shelves.jump} jf={jf}
          onOpen={open} onPlay={playItem} onSeeAll={() => setSeeAll('albums')} />
        <Shelf title="Artists you have" items={shelves.artists} jf={jf} round
          onOpen={open} onPlay={startMix} onSeeAll={() => setSeeAll('artists')} />
      </div>
    </div>
  );
}
