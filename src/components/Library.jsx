import React, { useEffect, useMemo, useRef, useState } from 'react';
import TrackRow, { PlayGlyph, PauseGlyph, Heart, ShuffleGlyph } from './TrackRow.jsx';
import ContextMenu from './ContextMenu.jsx';
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

// Spotify's rule of thumb for a release with no declared type: up to three
// tracks (under 30 min) is a single, up to six an EP, otherwise an album.
// Average colour straight out of Jellyfin's blurhash (its DC term is the
// mean sRGB of the image), so the hero tints itself without fetching or
// decoding the cover -- and without a canvas taint on the desktop, where the
// image is cross-origin.
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
export function blurhashAverage(hash) {
  if (!hash || hash.length < 6) return null;
  let v = 0;
  for (const c of hash.slice(2, 6)) { const i = B83.indexOf(c); if (i < 0) return null; v = v * 83 + i; }
  return [v >> 16 & 255, v >> 8 & 255, v & 255];
}
// Spotify darkens/saturates the extracted colour so white text stays legible.
export function heroTint(rgb) {
  if (!rgb) return null;
  let [r, g, b] = rgb.map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min; sat = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  sat = sat > .04 ? Math.min(1, Math.max(sat * 1.6, .35)) : sat; const L = Math.min(.42, Math.max(.24, l * .8));
  return `hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(L * 100)}%)`;
}
function fmtTotal(ticks) {
  const s = Math.round((ticks || 0) / 10_000_000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} hr ${m} min` : `${m} min ${sec} sec`;
}
const Clock = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" /><path d="M8 3.25a.75.75 0 0 1 .75.75v3.25H11a.75.75 0 0 1 0 1.5H7.25V4A.75.75 0 0 1 8 3.25z" /></svg>
);
const Shuffle = () => <ShuffleGlyph size={24} />;
const Dots = () => (
  <svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" /></svg>
);

// "All / Music / Artists" stays put on every main-pane page, like Spotify's
// home filter chips; the highlighted one says where you are.
function FilterPills({ where, setSeeAll, goHome }) {
  return (
    <div className="pills">
      <button className={`pill ${where === 'all' ? 'on' : ''}`} onClick={goHome}>All</button>
      <button className={`pill ${where === 'albums' ? 'on' : ''}`} onClick={() => setSeeAll('albums')}>Music</button>
      <button className={`pill ${where === 'artists' ? 'on' : ''}`} onClick={() => setSeeAll('artists')}>Artists</button>
    </div>
  );
}

export function releaseType(album) {
  const n = album.ChildCount ?? album.SongCount ?? 0;
  const mins = (album.RunTimeTicks || 0) / 600_000_000;
  const name = album.Name || '';
  if (/various artists/i.test(album.AlbumArtist || '')) return 'Compilation';
  if (/\b(EP)\b\s*$|\s[-–]\s*EP\s*$/i.test(name)) return 'EP';
  if (/\s[-–]\s*Single\s*$|\(single\)$/i.test(name)) return 'Single';
  if (n && n <= 3 && (!mins || mins < 30)) return 'Single';
  if (n && n <= 6 && (!mins || mins < 30)) return 'EP';
  return 'Album';
}

export default function Library({
  jf, player, view, albums, artists, playlists, detail, setDetail, query, setQuery,
  onLike, onAddTo, onNewPlaylist, onRemoveFromPlaylist, onReorder, onOpenPlaylist, onOpenLiked, likedCount,
  onOpenArtistById, onOpenAlbumById, onExclude, onDownload,
  seeAll, setSeeAll, onEditPlaylist, onDeletePlaylist, me, onView, onOpenProfile,
}) {
  const [results, setResults] = useState(null);
  const [searchType, setSearchType] = useState('All');
  const [err, setErr] = useState(null);
  const [heroMenu, setHeroMenu] = useState(null);
  // The column header is see-through over the hero's colour band and turns
  // solid once it sticks under the top bar (Spotify does the same).
  const headSentinelRef = useRef(null);
  const [headStuck, setHeadStuck] = useState(false);
  useEffect(() => {
    const el = headSentinelRef.current;
    if (!el) { setHeadStuck(false); return undefined; }
    const io = new IntersectionObserver(([e]) => setHeadStuck(!e.isIntersecting), { root: el.closest('.content'), rootMargin: '-70px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [detail?.item?.Id, detail?.tracks?.length]);
  const [editPl, setEditPl] = useState(null); // { name, file, preview }
  const [dragIdx, setDragIdx] = useState(null);
  // Artist page "Popular": 5 rows, "See more" expands to 10, like Spotify.
  const [popularExpanded, setPopularExpanded] = useState(false);
  // Discography filter on the artist page: 'all' | 'album' | 'single' | 'compilation'.
  const [discoFilter, setDiscoFilter] = useState('all');
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
    active: player.nowPlayingId === tracks[i].Id,
    isPlaying: player.playing,
    onPlay: () => player.playQueue(tracks, i, ctx),
    onToggle: () => player.toggle(),
    onLike, playlists, onAddTo, onNewPlaylist,
    onOpenArtist: onOpenArtistById, onOpenAlbum: onOpenAlbumById,
    onAddToQueue: (t) => player.addToQueue([t]),
    onRadio: (t) => startMix(t),
    onExclude, onDownload,
    ...extra,
  });

  // --- detail view --------------------------------------------------------
  if (detail) {
    const { item, tracks, kind } = detail;
    const isArtist = kind === 'Artist';
    const isPlaylist = kind === 'Playlist';
    const isLiked = item.Id === LIKED_ID;
    const totalTicks = tracks.reduce((s2, t) => s2 + (t.RunTimeTicks || 0), 0);
    const tint = heroTint(blurhashAverage(item.ImageBlurHashes?.Primary?.[item.ImageTags?.Primary]));
    const lead = !isArtist && !isPlaylist ? (item.AlbumArtists?.[0] || null) : null;
    // The colour lives on the page wrapper so the band behind the action bar
    // (.actions::before) sees it too, not just the header.
    const heroStyle = tint && !isArtist ? { '--hero': tint } : isLiked ? { '--hero': '#5038a0' } : undefined;

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

    if (kind === 'Profile') {
      const avatar = jf.userImageUrl();
      return (
        <div className="content" style={{ '--hero': '#4a4a4a' }}>
          <div className="contentbar" />
          <header className="hero profile">
            <div className="hero-cover profile-avatar">
              <img src={avatar} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'grid'; }} />
              <span className="profile-initial" style={{ display: 'none' }}>{(item.Name || '?').slice(0, 1).toUpperCase()}</span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="kind">Profile</div>
              <FittedTitle text={item.Name} maxLines={2} />
              <p className="hero-meta"><b>{playlists.length} Public Playlist{playlists.length === 1 ? '' : 's'}</b></p>
            </div>
          </header>
          <div className="actions slim" />
          <div className="pad">
            {detail.topArtists?.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Top artists this month</h2></div>
                <p className="shelf-sub">Only visible to you</p>
                <div className="shelf">
                  {detail.topArtists.map((a) => (
                    <Card key={a.Id} title={a.Name} subtitle="Artist" round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                      onOpen={() => onOpenArtistById(a.Id)} onPlay={() => startMix({ Id: a.Id })} />
                  ))}
                </div>
              </section>
            )}
            {tracks.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Top tracks this month</h2></div>
                <p className="shelf-sub">Only visible to you</p>
                <div className="tracklist" style={{ padding: 0 }}>
                  {tracks.map((t, i) => <TrackRow key={t.Id} {...rowProps(tracks, i, { showArt: true }, 'profile')} />)}
                </div>
              </section>
            )}
            {playlists.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Public Playlists</h2></div>
                <div className="shelf">
                  {playlists.map((p) => (
                    <Card key={p.Id} title={p.Name} subtitle={`By ${item.Name}`} image={jf.imageUrl(p.Id, { maxHeight: 320 })}
                      onOpen={() => onOpenPlaylist(p)} onPlay={() => playItem(p)} />
                  ))}
                </div>
              </section>
            )}
            {detail.loading && <p className="placeholder-note">Loading...</p>}
          </div>
        </div>
      );
    }

    return (
      <div className="content" style={heroStyle}>
        <div className="contentbar" />

        {(() => {
          const canEdit = isPlaylist && !isLiked;
          return (
            <header className={`hero ${isArtist ? 'artist' : ''} ${tint || isLiked ? 'tinted' : ''}`}>
              {isLiked ? (
                <div className="liked-art">
                  <Heart on={false} size={100} />
                </div>
              ) : (
                <button
                  className={`hero-cover ${canEdit ? 'editable' : ''}`}
                  onClick={canEdit ? () => setEditPl({ name: item.Name, file: null, preview: null }) : undefined}
                  title={canEdit ? 'Choose photo' : undefined}
                  disabled={!canEdit}
                >
                  <img src={jf.imageUrl(item.Id, { maxHeight: 464 })} alt="" />
                  {canEdit && <span className="hero-cover-edit">Choose photo</span>}
                </button>
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
                  <div className="kind">{isLiked ? 'Playlist' : kind === 'Album' ? releaseType({ ...item, ChildCount: item.ChildCount ?? tracks.length, RunTimeTicks: item.RunTimeTicks || totalTicks }) : kind}</div>
                )}
                {canEdit ? (
                  <button className="hero-title-edit" onClick={() => setEditPl({ name: item.Name, file: null, preview: null })} title="Edit details">
                    <FittedTitle text={item.Name} maxLines={2} />
                  </button>
                ) : (
                  <FittedTitle text={item.Name} maxLines={2} />
                )}
                <p className="hero-meta">
                  {lead && (
                    <>
                      <img className="hero-avatar" src={jf.imageUrl(lead.Id, { maxHeight: 48 })} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      <button className="rowlink strong" onClick={() => onOpenArtistById(lead.Id)}>{lead.Name}</button>
                      {(item.AlbumArtists || []).slice(1).map((a) => (
                        <React.Fragment key={a.Id}>, <button className="rowlink strong" onClick={() => onOpenArtistById(a.Id)}>{a.Name}</button></React.Fragment>
                      ))}
                      {item.ProductionYear ? <> · {item.ProductionYear}</> : null}
                      {' · '}
                    </>
                  )}
                  {isPlaylist && <><button className="rowlink strong" onClick={onOpenProfile}>{me?.Name || 'You'}</button>{' · '}</>}
                  {`${tracks.length} songs`}
                  {totalTicks ? `, ${fmtTotal(totalTicks)}` : ''}
                </p>
              </div>
            </header>
          );
        })()}

        <div className="actions">
          {(() => {
            const here = player.contextId === item.Id;
            const showPause = here && player.playing;
            const shuffled = player.shuffle !== 'off';
            const all = (fn) => tracks.length && fn(tracks);
            const heroItems = [
              { label: 'Add to queue', onClick: () => all((t) => player.addToQueue(t)) },
              !isLiked ? { label: 'Go to radio', onClick: () => startMix(item) } : null,
              tracks.length ? { label: 'Add to playlist', sub: [
                { label: 'New playlist', onClick: () => onNewPlaylist?.(tracks[0]) },
                ...playlists.filter((p) => p.Id !== item.Id).map((p) => ({ key: p.Id, label: p.Name, onClick: () => tracks.forEach((t) => onAddTo?.(p, t)) })),
              ] } : null,
              lead ? { label: 'Go to artist', onClick: () => onOpenArtistById(lead.Id) } : null,
              isPlaylist && !isLiked ? { sep: true } : null,
              isPlaylist && !isLiked ? { label: 'Edit details', onClick: () => setEditPl({ name: item.Name, file: null, preview: null }) } : null,
              isPlaylist && !isLiked ? { label: 'Delete', danger: true, onClick: () => { if (window.confirm(`Delete "${item.Name}"?`)) onDeletePlaylist(item); } } : null,
            ];
            return (
              <>
                <button
                  className="bigplay"
                  onClick={() => (here ? player.toggle() : tracks.length && player.playQueue(tracks, 0, item.Id))}
                  title={showPause ? 'Pause' : 'Play'}
                >
                  {showPause ? <PauseGlyph size={24} /> : <PlayGlyph size={24} />}
                </button>
                {!isArtist && (
                  <button className={`iconbtn ${shuffled ? 'on' : ''}`} onClick={() => player.setShuffle(shuffled ? 'off' : 'on')} title={shuffled ? 'Disable shuffle' : 'Enable shuffle'}>
                    <Shuffle />
                  </button>
                )}
                {isArtist && <button className="btn-secondary" disabled title="Not wired up yet">Follow</button>}
                <button className="iconbtn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHeroMenu({ x: r.left, y: r.bottom + 4 }); }} title={`More options for ${item.Name}`}>
                  <Dots />
                </button>
                {heroMenu && <ContextMenu x={heroMenu.x} y={heroMenu.y} items={heroItems} onClose={() => setHeroMenu(null)} />}
              </>
            );
          })()}
        </div>

        {editPl && (
          <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditPl(null); }}>
            <form className="modal editdetails" onSubmit={(e) => { e.preventDefault(); onEditPlaylist(item, { name: editPl.name.trim(), imageFile: editPl.file }); setEditPl(null); }}>
              <h3>Edit details</h3>
              <div className="editdetails-body">
                <label className="editdetails-cover" title="Choose photo">
                  <img src={editPl.preview || jf.imageUrl(item.Id, { maxHeight: 360 })} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  <span>Choose photo</span>
                  <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setEditPl((d) => ({ ...d, file: f, preview: URL.createObjectURL(f) })); }} />
                </label>
                <input value={editPl.name} onChange={(e) => setEditPl((d) => ({ ...d, name: e.target.value }))} placeholder="Add a name" autoFocus spellCheck="false" />
              </div>
              <div className="modal-actions">
                <button type="submit" className="primary" disabled={!editPl.name.trim()}>Save</button>
              </div>
            </form>
          </div>
        )}

        {isArtist ? (
          <div className="pad">
            <section>
              <div className="shelf-head"><h2>Popular</h2></div>
              <div className="tracklist" style={{ padding: 0 }}>
                {/* Spotify's Popular rows: 40px cover next to the number
                    (chunk_xpui-routes-artist: flex:0 0 40px, radius 4px),
                    title only, no artist line. */}
                {tracks.slice(0, popularExpanded ? 10 : 5).map((t, i) => <TrackRow key={t.Id} {...rowProps(tracks, i, { showArt: true, hideArtists: true }, item.Id)} />)}
              </div>
              {tracks.length > 5 && (
                <button className="seemore" onClick={() => setPopularExpanded((v) => !v)}>
                  {popularExpanded ? 'Show less' : 'See more'}
                </button>
              )}
            </section>
            {detail.albums?.length > 0 && (() => {
              const typed = detail.albums.map((a) => ({ a, type: releaseType(a) }));
              const counts = typed.reduce((m, { type }) => ({ ...m, [type]: (m[type] || 0) + 1 }), {});
              const pills = [
                ['all', 'Popular releases'],
                counts.Album ? ['album', 'Albums'] : null,
                (counts.Single || counts.EP) ? ['single', 'Singles and EPs'] : null,
                counts.Compilation ? ['compilation', 'Compilations'] : null,
              ].filter(Boolean);
              const shown = typed.filter(({ type }) =>
                discoFilter === 'all' ? true
                  : discoFilter === 'album' ? type === 'Album'
                  : discoFilter === 'single' ? (type === 'Single' || type === 'EP')
                  : type === 'Compilation');
              return (
                <section>
                  <div className="shelf-head"><h2>Discography</h2></div>
                  {/* Spotify's artist page splits releases by kind. Jellyfin has no
                      release type, so it is read off the track count (<=3 single,
                      <=6 EP) and the title (" - EP", "(Remixes)"). */}
                  {pills.length > 2 && (
                    <div className="pills" style={{ marginBottom: 16 }}>
                      {pills.map(([k, label]) => (
                        <button key={k} className={`pill ${discoFilter === k ? 'on' : ''}`} onClick={() => setDiscoFilter(k)}>{label}</button>
                      ))}
                    </div>
                  )}
                  <div className="grid">
                    {shown.map(({ a, type }) => (
                      <Card key={a.Id} title={a.Name} subtitle={a.ProductionYear ? `${a.ProductionYear} · ${type}` : type}
                        image={jf.imageUrl(a.Id, { maxHeight: 320 })} onOpen={() => openAlbum(a)} onPlay={() => playItem(a)} />
                    ))}
                  </div>
                </section>
              );
            })()}
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
            {tracks.length > 0 && <div ref={headSentinelRef} style={{ height: 1 }} />}
            {tracks.length > 0 && (
              <div className={`trackhead ${isPlaylist ? 'with-art' : ''} ${headStuck ? 'stuck' : ''}`}>
                <span className="th-n">#</span>
                {isPlaylist && <span />}
                <span>Title</span>
                <span>{isPlaylist ? 'Album' : ''}</span>
                <span />
                <span className="th-dur"><Clock /></span>
                <span />
              </div>
            )}
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
                        hideAlbum: kind === 'Album',
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
        <div className="contentbar">
          <FilterPills where={seeAll} setSeeAll={setSeeAll} goHome={() => onView('home')} />
        </div>
        <div className="pad">
          <h2 style={{ margin: '0 0 16px', fontSize: 24 }}>{seeAll === 'artists' ? 'Artists' : 'Albums'}</h2>
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
      bar={<FilterPills where="all" setSeeAll={setSeeAll} goHome={() => onView('home')} />}
    />
  );
}
