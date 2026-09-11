import React, { useEffect, useMemo, useState } from 'react';
import TrackRow, { PlayGlyph, PauseGlyph, Heart } from './TrackRow.jsx';
import Home from './Home.jsx';
import FittedTitle from './FittedTitle.jsx';
import VirtualList from './VirtualList.jsx';

export const LIKED_ID = '__liked__';

function Card({ title, subtitle, image, round, onOpen, onPlay }) {
  return (
    <div className={`card ${round ? 'round' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art">
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="ph" />}
        <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
          <PlayGlyph />
        </button>
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </div>
  );
}

function Shelf({ title, items, jf, round, onOpen, onPlay, onSeeAll, subtitle }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="shelf-head">
        <h2 onClick={onSeeAll}>{title}</h2>
        {onSeeAll && <button onClick={onSeeAll}>Show all</button>}
      </div>
      <div className="shelf">
        {items.map((it) => (
          <Card key={it.Id} title={it.Name}
            subtitle={subtitle ? subtitle(it) : (round ? 'Artist' : it.AlbumArtist)}
            image={jf.imageUrl(it.Id, { maxHeight: 320 })} round={round}
            onOpen={() => onOpen(it)} onPlay={() => onPlay(it)} />
        ))}
      </div>
    </section>
  );
}

const SEARCH_TYPES = ['All', 'Songs', 'Artists', 'Albums', 'Playlists'];

export default function Library({
  jf, player, view, albums, artists, playlists, detail, setDetail, query, setQuery,
  onLike, onAddTo, onNewPlaylist, onRemoveFromPlaylist, onReorder, onOpenPlaylist, onOpenLiked, likedCount,
  onOpenArtistById, onOpenAlbumById,
}) {
  const [results, setResults] = useState(null);
  const [searchType, setSearchType] = useState('All');
  const [err, setErr] = useState(null);
  const [seeAll, setSeeAll] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  // Artist page "Popular": 5 rows, "See more" expands to 10, like Spotify.
  const [popularExpanded, setPopularExpanded] = useState(false);
  const [overIdx, setOverIdx] = useState(null);

  useEffect(() => {
    if (view !== 'search' || !query.trim()) { setResults(null); return undefined; }
    const t = setTimeout(() => {
      jf.search(query.trim()).then(setResults).catch((e) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query, jf, view]);

  const openAlbum = async (album) => {
    setDetail({ item: album, tracks: [], kind: 'Album', loading: true });
    try {
      const { items } = await jf.tracks({ albumId: album.Id });
      setDetail((d) => (d && d.item?.Id === album.Id ? { ...d, tracks: items, loading: false } : d));
    } catch (e) { setErr(e.message); }
  };

  const openArtist = async (artist) => {
    setPopularExpanded(false);
    setDetail({ item: artist, tracks: [], albums: [], kind: 'Artist', loading: true });
    try {
      const [t, a] = await Promise.all([
        jf.tracks({ artistId: artist.Id, limit: 200 }),
        jf.artistAlbums(artist.Id).catch(() => ({ items: [] })),
      ]);
      setDetail((d) => (d && d.item?.Id === artist.Id ? { ...d, tracks: t.items, albums: a.items, loading: false } : d));
    } catch (e) { setErr(e.message); }
  };

  const open = (it) => {
    if (it.Type === 'MusicArtist') return openArtist(it);
    if (it.Type === 'Playlist') return onOpenPlaylist(it);
    return openAlbum(it);
  };

  const playItem = async (it) => {
    try {
      let items;
      if (it.Type === 'MusicArtist') ({ items } = await jf.tracks({ artistId: it.Id, limit: 200 }));
      else if (it.Type === 'Playlist') ({ items } = await jf.playlistTracks(it.Id));
      else ({ items } = await jf.tracks({ albumId: it.Id }));
      if (items.length) player.playQueue(items, 0);
    } catch (e) { setErr(e.message); }
  };

  const startMix = async (it) => {
    try {
      const items = await jf.instantMix(it.Id);
      if (items.length) player.playQueue(items, 0);
    } catch (e) { setErr(e.message); }
  };

  const shelves = useMemo(() => {
    const shuffled = [...albums].sort(() => Math.random() - 0.5);
    return { jump: shuffled.slice(0, 8), artists: artists.slice(0, 8) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums.length, artists.length]);

  const rowProps = (tracks, i, extra = {}, ctx = null) => ({
    track: tracks[i], n: i + 1, jf,
    active: player.current?.Id === tracks[i].Id,
    isPlaying: player.playing,
    onPlay: () => player.playQueue(tracks, i, ctx),
    onToggle: () => player.toggle(),
    onLike, playlists, onAddTo, onNewPlaylist,
    onOpenArtist: onOpenArtistById, onOpenAlbum: onOpenAlbumById,
    ...extra,
  });

  // --- detail view --------------------------------------------------------
  if (detail) {
    const { item, tracks, kind } = detail;
    const isArtist = kind === 'Artist';
    const isPlaylist = kind === 'Playlist';
    const isLiked = item.Id === LIKED_ID;
    const totalMin = Math.round(tracks.reduce((s2, t) => s2 + (t.RunTimeTicks || 0) / 10_000_000, 0) / 60);

    // Drag-to-reorder for user playlists (Liked Songs is date-ordered, not reorderable).
    const dnd = (i) => (isPlaylist && !isLiked ? {
      draggable: true,
      onDragStart: () => setDragIdx(i),
      onDragOver: (e) => { e.preventDefault(); setOverIdx(i); },
      onDrop: (e) => {
        e.preventDefault();
        if (dragIdx != null && dragIdx !== i) onReorder(item, tracks[dragIdx], dragIdx, i);
        setDragIdx(null); setOverIdx(null);
      },
    } : {});

    return (
      <div className="content">
        <div className="detailbar">
          <button className="back" onClick={() => setDetail(null)} title="Back">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M11.03.47a.75.75 0 0 1 0 1.06L4.56 8l6.47 6.47a.75.75 0 1 1-1.06 1.06L2.44 8 9.97.47a.75.75 0 0 1 1.06 0z" />
            </svg>
          </button>
        </div>

        <header className={`hero ${isArtist ? 'artist' : ''}`}>
          {isLiked ? (
            <div className="liked-art">
              <Heart on={false} size={100} />
            </div>
          ) : (
            <img src={jf.imageUrl(item.Id, { maxHeight: 464 })} alt="" />
          )}
          <div style={{ minWidth: 0 }}>
            {isArtist ? (
              <span className="verified">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M12 2 9.6 4.6 6.1 4l-.6 3.5L2 9.6 4.6 12 2 14.4l3.5 2.1.6 3.5 3.5-.6L12 22l2.4-2.6 3.5.6.6-3.5 3.5-2.1L19.4 12 22 9.6l-3.5-2.1-.6-3.5-3.5.6L12 2zm-1.2 13.6L7 11.8l1.4-1.4 2.4 2.4 4.8-4.8L17 9.4l-6.2 6.2z" />
                </svg>
                Verified Artist
              </span>
            ) : (
              <div className="kind">{isLiked ? 'Playlist' : kind}</div>
            )}
            <FittedTitle text={item.Name} maxLines={2} />
            <p>
              {!isArtist && !isPlaylist && item.AlbumArtist && <b>{item.AlbumArtist}</b>}
              {!isArtist && !isPlaylist && item.ProductionYear ? ` · ${item.ProductionYear}` : ''}
              {`${isArtist || isPlaylist ? '' : ' · '}${tracks.length} songs`}
              {totalMin ? `, about ${totalMin} min` : ''}
            </p>
          </div>
        </header>

        <div className="actions">
          {(() => {
            const here = player.contextId === item.Id;
            const showPause = here && player.playing;
            return (
              <button
                className="bigplay"
                onClick={() => (here ? player.toggle() : tracks.length && player.playQueue(tracks, 0, item.Id))}
                title={showPause ? 'Pause' : 'Play'}
              >
                {showPause ? <PauseGlyph size={24} /> : <PlayGlyph size={24} />}
              </button>
            );
          })()}
          {!isLiked && <button className="btn-secondary" onClick={() => startMix(item)}>Instant mix</button>}
          {isArtist && <button className="btn-secondary" disabled title="Not wired up yet">Follow</button>}
        </div>

        {isArtist ? (
          <div className="pad">
            <section>
              <div className="shelf-head"><h2>Popular</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {tracks.slice(0, popularExpanded ? 10 : 5).map((t, i) => <TrackRow key={t.Id} {...rowProps(tracks, i, {}, item.Id)} />)}
              </div>
              {tracks.length > 5 && (
                <button className="seemore" onClick={() => setPopularExpanded((v) => !v)}>
                  {popularExpanded ? 'Show less' : 'See more'}
                </button>
              )}
            </section>
            {detail.albums?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Discography</h2></div>
                <div className="grid">
                  {detail.albums.map((a) => (
                    <Card key={a.Id} title={a.Name} subtitle={a.ProductionYear ? `${a.ProductionYear} · Album` : 'Album'}
                      image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                  ))}
                </div>
              </section>
            )}
            <section>
              <div className="shelf-head"><h2>Fans also like</h2></div>
              <p className="placeholder-note">Similar artists need a metadata provider. Not wired up yet.</p>
            </section>
            <section>
              <div className="shelf-head"><h2>About</h2></div>
              <p className="placeholder-note">{item.Overview || 'No biography yet. These arrive with artist metadata.'}</p>
            </section>
          </div>
        ) : (
          <div className="tracklist">
            {tracks.length === 0 && !detail.loading && (
              <p className="placeholder-note">
                {isLiked ? 'Songs you like will appear here. Save songs by tapping the heart icon.' : 'This playlist is empty.'}
              </p>
            )}
            {tracks.length > 0 && (
              <VirtualList
                items={tracks}
                rowHeight={56}
                getKey={(t, i) => t.PlaylistItemId || `${t.Id}-${i}`}
                renderRow={(t, i) => (
                  <div className={overIdx === i && dragIdx != null ? 'dropbefore' : ''}>
                    <TrackRow
                      {...rowProps(tracks, i, {
                        showArt: isPlaylist,
                        onRemove: isPlaylist && !isLiked ? () => onRemoveFromPlaylist(item, t) : undefined,
                        ...dnd(i),
                      }, item.Id)}
                    />
                  </div>
                )}
              />
            )}
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
        <div className="detailbar">
          <button className="back" onClick={() => setSeeAll(null)} title="Back">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M11.03.47a.75.75 0 0 1 0 1.06L4.56 8l6.47 6.47a.75.75 0 1 1-1.06 1.06L2.44 8 9.97.47a.75.75 0 0 1 1.06 0z" />
            </svg>
          </button>
          <h2 style={{ margin: 0, fontSize: 24 }}>{seeAll === 'artists' ? 'Artists' : 'Albums'}</h2>
        </div>
        <div className="pad">
          <div className="grid">
            {items.map((it) => (
              <Card key={it.Id} title={it.Name} subtitle={seeAll === 'artists' ? 'Artist' : it.AlbumArtist}
                image={jf.imageUrl(it.Id, { maxHeight: 320 })} round={seeAll === 'artists'}
                onOpen={() => open(it)} onPlay={() => playItem(it)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // --- search -------------------------------------------------------------
  if (view === 'search') {
    const r = results;
    // Spotify's Top result: the single best hit, artist preferred if the name
    // matches closely, else the first song's album/artist.
    const top = r
      ? (r.artists[0] && r.artists[0].Name.toLowerCase().startsWith(query.trim().toLowerCase()) ? { kind: 'Artist', item: r.artists[0] }
        : r.albums[0] ? { kind: 'Album', item: r.albums[0] }
        : r.artists[0] ? { kind: 'Artist', item: r.artists[0] }
        : r.tracks[0] ? { kind: 'Song', item: r.tracks[0] } : null)
      : null;
    const show = (t) => searchType === 'All' || searchType === t;

    return (
      <div className="content">
        <div className="contentbar">
          <input className="search" autoFocus placeholder="What do you want to play?"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {r && (
          <div className="searchtypes">
            {SEARCH_TYPES.map((t) => (
              <button key={t} className={`pill ${searchType === t ? 'on' : ''}`} onClick={() => setSearchType(t)}>{t}</button>
            ))}
          </div>
        )}
        <div className="pad">
          {err && <div className="banner error">{err}</div>}
          {!query.trim() && (
            <>
              <div className="shelf-head"><h2>Browse all</h2></div>
              <p className="placeholder-note">Genre and mood browsing needs genre tags, which the retag is adding. Search by song, album or artist above.</p>
            </>
          )}

          {r && searchType === 'All' && top && (
            <div className="searchgrid">
              <section>
                <div className="shelf-head"><h2>Top result</h2></div>
                <div className={`topresult ${top.kind === 'Artist' ? 'round' : ''}`}
                  onClick={() => top.kind === 'Song' ? openAlbum({ Id: top.item.AlbumId, Name: top.item.Album }) : open(top.item)}>
                  <img src={jf.imageUrl(top.kind === 'Song' ? (top.item.AlbumId || top.item.Id) : top.item.Id, { maxHeight: 200 })} alt="" />
                  <div>
                    <h3>{top.item.Name}</h3>
                    <div className="kind">
                      {top.kind === 'Song' ? (top.item.Artists?.join(', ') || '') : (top.item.AlbumArtist || '')}
                      <b>{top.kind}</b>
                    </div>
                  </div>
                  <button className="card-play" onClick={(e) => { e.stopPropagation(); top.kind === 'Song' ? player.playQueue(r.tracks, 0) : playItem(top.item); }}>
                    <PlayGlyph />
                  </button>
                </div>
              </section>
              <section>
                <div className="shelf-head"><h2>Songs</h2></div>
                <div className="tracklist" style={{ padding: 0 }}>
                  {r.tracks.slice(0, 4).map((t, i) => <TrackRow key={t.Id} {...rowProps(r.tracks, i, { showArt: true })} />)}
                </div>
              </section>
            </div>
          )}

          {r && show('Songs') && searchType !== 'All' && r.tracks.length > 0 && (
            <section>
              <div className="shelf-head"><h2>Songs</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {r.tracks.map((t, i) => <TrackRow key={t.Id} {...rowProps(r.tracks, i, { showArt: true })} />)}
              </div>
            </section>
          )}
          {r && show('Artists') && r.artists.length > 0 && (
            <section>
              <div className="shelf-head"><h2>Artists</h2></div>
              <div className="grid">
                {r.artists.map((a) => (
                  <Card key={a.Id} title={a.Name} subtitle="Artist" round
                    image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => openArtist(a)} onPlay={() => startMix(a)} />
                ))}
              </div>
            </section>
          )}
          {r && show('Albums') && r.albums.length > 0 && (
            <section>
              <div className="shelf-head"><h2>Albums</h2></div>
              <div className="grid">
                {r.albums.map((a) => (
                  <Card key={a.Id} title={a.Name} subtitle={`${a.ProductionYear ? a.ProductionYear + ' · ' : ''}${a.AlbumArtist || 'Album'}`}
                    image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                ))}
              </div>
            </section>
          )}
          {r && show('Playlists') && r.playlists.length > 0 && (
            <section>
              <div className="shelf-head"><h2>Playlists</h2></div>
              <div className="grid">
                {r.playlists.map((p) => (
                  <Card key={p.Id} title={p.Name} subtitle="Playlist"
                    image={jf.imageUrl(p.Id, { maxHeight: 320 })} onOpen={() => onOpenPlaylist(p)} onPlay={() => playItem(p)} />
                ))}
              </div>
            </section>
          )}
          {r && !r.tracks.length && !r.albums.length && !r.artists.length && !r.playlists.length && (
            <div className="banner">No results found for &ldquo;{query}&rdquo;. Check the spelling, or try a different search.</div>
          )}
        </div>
      </div>
    );
  }

  // --- home ---------------------------------------------------------------
  return (
    <Home
      jf={jf} player={player} albums={albums} artists={artists} playlists={playlists}
      likedCount={likedCount}
      onOpen={open} onOpenLiked={onOpenLiked} onOpenPlaylist={onOpenPlaylist}
      onSeeAll={setSeeAll}
    />
  );
}
