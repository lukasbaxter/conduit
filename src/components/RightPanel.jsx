import React, { useEffect, useRef, useState } from 'react';
import { ArtistLinks, PlayGlyph } from './TrackRow.jsx';
import ContextMenu from './ContextMenu.jsx';

const Close = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z" />
  </svg>
);

function secs(ticks) {
  return ticks ? ticks / 10_000_000 : 0;
}

function QueueRow({ track, jf, active, onPlay, onOpenArtist, onOpenAlbum, menuItems, draggable, onDragStart, onDragOver, onDrop, onDragEnd, over, dragging }) {
  const [menu, setMenu] = useState(null);
  const art = jf.imageUrl(track.AlbumId || track.Id, { maxHeight: 80 });
  const artists = track.ArtistItems?.length ? track.ArtistItems : (track.Artists || []).map((n) => ({ Name: n }));
  return (
    <div
      className={`qrow ${active ? 'active' : ''} ${over ? 'dropbefore' : ''} ${dragging ? 'dragging' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      onContextMenu={menuItems ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}
      onDoubleClick={onPlay}
    >
      <button className="qrow-art" onClick={onPlay} title="Play">
        {art ? <img src={art} alt="" loading="lazy" draggable={false} /> : <div className="ph" />}
        <span className="qrow-play"><PlayGlyph size={14} /></span>
      </button>
      <span className="qrow-text">
        <span className="qrow-title" role="button" onClick={() => track.AlbumId && onOpenAlbum?.(track.AlbumId)}>{track.Name}</span>
        <span className="qrow-sub"><ArtistLinks artists={artists} fallback={track.AlbumArtist || ''} onOpen={onOpenArtist} className="rowlink" /></span>
      </span>
      {menuItems && (
        <button className="qrow-more" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 4, fromButton: true }); }} title="More options">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm6.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM16 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" /></svg>
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} anchorRight={Boolean(menu.fromButton)} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Now Playing view: cover, track, then stacked section cards. */
function NowPlaying({ player, jf, onOpenArtist, onOpenAlbum, onShowQueue }) {
  const { current, nowPlaying, queue, index } = player;
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 640 }) : null;
  const upNext = index >= 0 ? queue[index + 1] : null;

  return (
    <>
      {art ? <img className="npv-art" src={art} alt="" /> : <div className="npv-art" />}

      <div className="npv-track">
        <div style={{ minWidth: 0 }}>
          <div
            className="npv-title"
            role={nowPlaying?.albumId ? 'button' : undefined}
            onClick={() => nowPlaying?.albumId && onOpenAlbum(nowPlaying.albumId)}
            style={{ cursor: nowPlaying?.albumId ? 'pointer' : 'default' }}
          >
            {nowPlaying?.title || 'Nothing playing'}
          </div>
          <div className="npv-artist" style={{ cursor: 'default' }}>
            {nowPlaying?.artists?.length
              ? <ArtistLinks artists={nowPlaying.artists} onOpen={onOpenArtist} className="npv-artist-link" />
              : nowPlaying?.artistId
                ? <button className="npv-artist-link" onClick={() => onOpenArtist(nowPlaying.artistId)}>{nowPlaying.artist}</button>
                : nowPlaying?.artist}
          </div>
        </div>
      </div>

      <section className="section">
        <div className="section-head"><h2>About the artist</h2></div>
        <p className="placeholder-note">
          Artist images, monthly listeners and bios need a metadata provider.
          Not wired up yet.
        </p>
      </section>

      <section className="section">
        <div className="section-head"><h2>Credits</h2></div>
        <p className="placeholder-note">
          Performer and writer credits come from MusicBrainz. They will fill in
          as the retag completes.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Next in queue</h2>
          <button onClick={onShowQueue}>Open queue</button>
        </div>
        {upNext ? (
          <QueueRow track={upNext} jf={jf} onPlay={() => player.skipTo(index + 1)} />
        ) : (
          <p className="placeholder-note" style={{ margin: 0 }}>
            {current ? 'Nothing queued after this track.' : 'Your queue is empty.'}
          </p>
        )}
      </section>
    </>
  );
}

/** Queue: Now playing / Next in queue, matching Spotify's sectioning. */
function Queue({ player, jf, onOpenArtist, onOpenAlbum, onLike, onAddTo, playlists = [] }) {
  // `queue`/`index` are the SESSION's (the active player's, mirrored) so the
  // panel is the same on every client; every edit routes to whoever is playing.
  const { queue, index, contextId } = player;
  const current = index >= 0 ? queue[index] || null : null;
  const upcoming = index >= 0 ? queue.slice(index + 1) : queue;
  const base = index >= 0 ? index + 1 : 0;
  // Spotify splits what you queued by hand from the rest of the context.
  let split = 0;
  while (split < upcoming.length && upcoming[split]?._queued) split += 1;
  const queued = upcoming.slice(0, split), fromCtx = upcoming.slice(split);
  const [ctxName, setCtxName] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!contextId || contextId === 'liked') { setCtxName(contextId === 'liked' ? 'Liked Songs' : null); return undefined; }
    if (String(contextId).startsWith('browse:')) { setCtxName(null); return undefined; }
    jf.itemById(contextId).then((it) => { if (alive) setCtxName(it?.Name || null); }).catch(() => { if (alive) setCtxName(null); });
    return () => { alive = false; };
  }, [contextId, jf]);
  const [drag, setDrag] = useState(null); // absolute queue index being dragged
  const [over, setOver] = useState(null);

  if (!queue.length) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>Add to your queue</h2>
        <p className="qrow-sub" style={{ margin: 0 }}>Play an album or playlist, or use “Add to queue” on any song.</p>
      </div>
    );
  }
  const items = (t, pos) => [
    { label: 'Remove from queue', onClick: () => player.removeFromQueue(pos) },
    { label: t.UserData?.IsFavorite ? 'Remove from your Liked Songs' : 'Save to your Liked Songs', onClick: () => onLike?.(t, !t.UserData?.IsFavorite) },
    playlists.length ? { label: 'Add to playlist', sub: playlists.map((p) => ({ key: p.Id, label: p.Name, onClick: () => onAddTo?.(p, t) })) } : null,
    { sep: true },
    t.ArtistItems?.[0]?.Id ? { label: 'Go to artist', onClick: () => onOpenArtist?.(t.ArtistItems[0].Id) } : null,
    t.AlbumId ? { label: 'Go to album', onClick: () => onOpenAlbum?.(t.AlbumId) } : null,
  ];
  const row = (t, pos, key) => (
    <QueueRow key={key} track={t} jf={jf} onPlay={() => player.skipTo(pos)} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
      menuItems={items(t, pos)} draggable
      onDragStart={() => setDrag(pos)} onDragOver={(e) => { e.preventDefault(); setOver(pos); }}
      onDrop={(e) => { e.preventDefault(); if (drag != null && drag !== pos) player.moveInQueue(drag, pos); setDrag(null); setOver(null); }}
      onDragEnd={() => { setDrag(null); setOver(null); }} over={over === pos && drag != null && drag !== pos} dragging={drag === pos} />
  );
  return (
    <>
      {current && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}><h2>Now playing</h2></div>
          <QueueRow track={current} jf={jf} active onPlay={() => player.skipTo(index)} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
            menuItems={items(current, index).filter((x) => x && x.label !== 'Remove from queue')} />
        </section>
      )}
      {queued.length > 0 && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h2>Next in queue</h2>
            <button className="linkish" onClick={() => player.clearQueued()}>Clear queue</button>
          </div>
          {queued.map((t, i) => row(t, base + i, `q-${t.Id}-${i}`))}
        </section>
      )}
      {fromCtx.length > 0 && (
        <section>
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h2>{ctxName ? `Next from: ${ctxName}` : 'Next up'}</h2>
            <span className="qrow-sub">{fromCtx.length}</span>
          </div>
          {fromCtx.slice(0, 80).map((t, i) => row(t, base + split + i, `c-${t.Id}-${i}`))}
        </section>
      )}
      {!queued.length && !fromCtx.length && <p className="qrow-sub" style={{ padding: '12px 0' }}>End of the queue.</p>}
    </>
  );
}

/**
 * Lyrics. Sung lines dim to 50%, the active line takes full colour, upcoming
 * lines stay full opacity -- Spotify's actual treatment, which is the opposite
 * of what most clones do.
 */
export function Lyrics({ player, jf }) {
  const { position } = player;
  // Follow the session-wide track, not just this client's own queue item, so
  // lyrics load and stay in sync even when we are mirroring another device
  // (where `current` is null but nowPlayingId still points at the song).
  const trackId = player.nowPlayingId;
  const [lines, setLines] = useState(null);
  const [state, setState] = useState('idle');
  const activeRef = useRef(null);

  useEffect(() => {
    if (!trackId) { setLines(null); setState('idle'); return; }
    let cancelled = false;
    setState('loading');
    jf.lyrics(trackId)
      .then((l) => {
        if (cancelled) return;
        setLines(l);
        setState(l && l.length ? 'ok' : 'none');
      })
      .catch(() => { if (!cancelled) setState('none'); });
    return () => { cancelled = true; };
  }, [trackId, jf]);

  // Nudge the playhead forward slightly when choosing the active line. Human
  // perception is asymmetric here: a lyric arriving a hair early reads as in
  // time, while the same error late reads as lagging.
  const LEAD_SECONDS = 0.25;
  const at = position + LEAD_SECONDS;
  const activeIndex = lines
    ? lines.reduce((acc, l, i) => (l.start != null && at >= l.start ? i : acc), -1)
    : -1;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeIndex]);

  // Breadcrumb every ~2s: what the lyrics view believes.
  useEffect(() => {
    const t = setInterval(() => {
      window.conduit?.debug?.(
        `lyrics track=${trackId?.slice(0, 8) || '-'} state=${state} lines=${lines?.length ?? 0} ` +
        `pos=${position.toFixed(1)} active=${activeIndex} ` +
        `activeStart=${activeIndex >= 0 ? lines[activeIndex]?.start : '-'}`
      );
    }, 2000);
    return () => clearInterval(t);
  }, [trackId, state, lines, position, activeIndex]);

  if (state === 'loading') return <p className="placeholder-note">Loading lyrics...</p>;
  if (state === 'idle') return <p className="placeholder-note">Play something to see lyrics.</p>;
  if (state === 'none') {
    return (
      <p className="placeholder-note">
        Looks like we don&rsquo;t have the lyrics for this song.
      </p>
    );
  }

  const synced = lines.some((l) => l.start != null);

  return (
    <div className="lyrics">
      {!synced && (
        <p className="qrow-sub" style={{ margin: '0 0 12px' }}>
          These lyrics aren&rsquo;t synced to the song yet.
        </p>
      )}
      {lines.map((l, i) => (
        <button
          key={i}
          ref={i === activeIndex ? activeRef : null}
          className={`lyric-line ${synced && i < activeIndex ? 'sung' : ''} ${i === activeIndex ? 'now' : ''}`}
          onClick={() => l.start != null && player.seek(l.start)}
          style={{ cursor: l.start != null ? 'pointer' : 'default' }}
        >
          {l.text || ' '}
        </button>
      ))}
    </div>
  );
}

export default function RightPanel({ mode, onClose, onMode, player, jf, onOpenArtist, onOpenAlbum, onLike, onAddTo, playlists }) {
  const titles = { npv: 'Now playing', queue: 'Queue', lyrics: 'Lyrics' };
  return (
    <aside className="rightpanel">
      <div className="panel-header">
        <button className="icon-btn" onClick={onClose} title="Close panel"><Close /></button>
        <span className="title">{titles[mode]}</span>
      </div>
      {mode !== 'npv' && (
        <div className="tabs" style={{ gridRow: 'auto' }}>
          <button className={mode === 'queue' ? 'on' : ''} onClick={() => onMode('queue')}>Queue</button>
          <button className={mode === 'lyrics' ? 'on' : ''} onClick={() => onMode('lyrics')}>Lyrics</button>
        </div>
      )}
      <div className="panel-body">
        {mode === 'npv' && (
          <NowPlaying
            player={player} jf={jf}
            onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum}
            onShowQueue={() => onMode('queue')}
          />
        )}
        {mode === 'queue' && <Queue player={player} jf={jf} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onLike={onLike} onAddTo={onAddTo} playlists={playlists} />}
        {mode === 'lyrics' && <Lyrics player={player} jf={jf} />}
      </div>
    </aside>
  );
}
