import React, { useEffect, useMemo, useState } from 'react';
import { PlayGlyph, Heart } from './TrackRow.jsx';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Spotify's Daily Mix tiles: artist photo up top, a solid colour band with the
// label at the bottom. One palette entry per mix, rotating.
const MIX_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#e13300', '#148a08', '#0d73ec', '#7d4b32', '#ba5d07'];

function MixTile({ label, sub, image, color, onOpen, onPlay, placeholder }) {
  return (
    <div className="card mixcard" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      <div className="card-art mixart" style={{ '--mix': color }}>
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="ph" />}
        <div className="mixband">{label}</div>
        {!placeholder && (
          <button className="card-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
            <PlayGlyph />
          </button>
        )}
      </div>
      <div className="card-title">{label}</div>
      <div className="card-sub">{sub}</div>
    </div>
  );
}

function Shortcut({ title, image, onOpen, onPlay, liked }) {
  return (
    <div className="shortcut" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.()}>
      {liked ? (
        <div className="liked-art shortcut-art"><Heart on={false} size={22} /></div>
      ) : image ? (
        <img className="shortcut-art" src={image} alt="" loading="lazy" />
      ) : (
        <div className="shortcut-art ph" />
      )}
      <span className="shortcut-title">{title}</span>
      <button className="card-play shortcut-play" onClick={(e) => { e.stopPropagation(); onPlay?.(); }} title="Play">
        <PlayGlyph />
      </button>
    </div>
  );
}

function Shelf({ title, children, onSeeAll }) {
  return (
    <section className="homeshelf">
      <div className="shelf-head">
        <h2 onClick={onSeeAll}>{title}</h2>
        {onSeeAll && <button onClick={onSeeAll}>Show all</button>}
      </div>
      <div className="shelf">{children}</div>
    </section>
  );
}

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

/**
 * Home. Structure follows Spotify's: greeting + 8 shortcuts, then Made For You,
 * Recently played, Jump back in, New releases, Your top artists.
 *
 * Daily Mixes are real: each is Jellyfin's Instant Mix seeded from one of your
 * most-played artists, which is functionally what Spotify's artist-clustered
 * mixes are. Discover Weekly and Release Radar need listening data we do not
 * have and are labelled placeholders.
 */
export default function Home({ jf, player, albums, artists, playlists, onOpen, onOpenLiked, onOpenPlaylist, onSeeAll, likedCount, bar }) {
  const [recent, setRecent] = useState([]);
  const [added, setAdded] = useState([]);

  useEffect(() => {
    if (!jf) return;
    jf.recentlyPlayedAlbums({ limit: 8 }).then((r) => setRecent(r.items)).catch(() => {});
    jf.recentlyAddedAlbums({ limit: 8 }).then((r) => setAdded(r.items)).catch(() => {});
  }, [jf]);

  const playAlbum = async (a) => {
    const { items } = await jf.tracks({ albumId: a.Id });
    if (items.length) player.playQueue(items, 0);
  };
  const playMix = async (seed) => {
    const items = await jf.instantMix(seed.Id);
    if (items.length) player.playQueue(items, 0);
  };
  const playLiked = async () => {
    const { items } = await jf.favoriteTracks();
    if (items.length) player.playQueue(items, 0);
  };
  const playPlaylist = async (p) => {
    const { items } = await jf.playlistTracks(p.Id);
    if (items.length) player.playQueue(items, 0);
  };

  // Shortcuts: Liked Songs first, then recent albums and playlists, to 8.
  const shortcuts = useMemo(() => {
    const out = [{ kind: 'liked' }];
    for (const a of recent) { if (out.length >= 8) break; out.push({ kind: 'album', item: a }); }
    for (const p of playlists) { if (out.length >= 8) break; out.push({ kind: 'playlist', item: p }); }
    for (const a of albums) { if (out.length >= 8) break; if (!out.some((o) => o.item?.Id === a.Id)) out.push({ kind: 'album', item: a }); }
    return out;
  }, [recent, playlists, albums]);

  const mixSeeds = artists.slice(0, 6);
  const jump = useMemo(() => [...albums].sort(() => Math.random() - 0.5).slice(0, 8), [albums.length]); // eslint-disable-line

  return (
    <div className="content">
      <div className="contentbar">{bar}</div>

      <div className="pad home">
        <h1 className="greeting">{greeting()}</h1>

        <div className="shortcuts">
          {shortcuts.map((s, i) => s.kind === 'liked' ? (
            <Shortcut key="liked" title="Liked Songs" liked onOpen={onOpenLiked} onPlay={playLiked} />
          ) : s.kind === 'playlist' ? (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpenPlaylist(s.item)} onPlay={() => playPlaylist(s.item)} />
          ) : (
            <Shortcut key={s.item.Id} title={s.item.Name} image={jf.imageUrl(s.item.Id, { maxHeight: 128 })}
              onOpen={() => onOpen(s.item)} onPlay={() => playAlbum(s.item)} />
          ))}
        </div>

        <Shelf title="Made For You">
          {mixSeeds.map((a, i) => (
            <MixTile key={a.Id} label={`Daily Mix ${i + 1}`} sub={`${a.Name} and more`}
              image={jf.imageUrl(a.Id, { maxHeight: 320 })} color={MIX_COLORS[i % MIX_COLORS.length]}
              onOpen={() => playMix(a)} onPlay={() => playMix(a)} />
          ))}
          <MixTile label="Discover Weekly" sub="Your weekly mixtape of fresh music. Needs listening history." color="#1e3264" placeholder />
          <MixTile label="Release Radar" sub="New releases from artists you follow. Needs a release feed." color="#8d67ab" placeholder />
        </Shelf>

        {recent.length > 0 && (
          <Shelf title="Recently played" onSeeAll={() => onSeeAll('albums')}>
            {recent.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || 'Album'} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        <Shelf title="Jump back in" onSeeAll={() => onSeeAll('albums')}>
          {jump.map((a) => (
            <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || 'Album'} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
              onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
          ))}
        </Shelf>

        {added.length > 0 && (
          <Shelf title="New releases for you" onSeeAll={() => onSeeAll('albums')}>
            {added.map((a) => (
              <Card key={a.Id} title={a.Name} subtitle={a.AlbumArtist || 'Album'} image={jf.imageUrl(a.Id, { maxHeight: 320 })}
                onOpen={() => onOpen(a)} onPlay={() => playAlbum(a)} />
            ))}
          </Shelf>
        )}

        <Shelf title="Your top artists" onSeeAll={() => onSeeAll('artists')}>
          {artists.slice(0, 8).map((a) => (
            <Card key={a.Id} title={a.Name} subtitle="Artist" round image={jf.imageUrl(a.Id, { maxHeight: 320 })}
              onOpen={() => onOpen(a)} onPlay={() => playMix(a)} />
          ))}
        </Shelf>
      </div>
    </div>
  );
}
