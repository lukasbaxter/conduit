import React, { useEffect, useState } from 'react';
import { history as relayHistory } from '../api/search.js';
import { PlayGlyph } from './TrackRow.jsx';

// The profile menu's History page: stats.fm for this account. Every number
// comes from ListenBrainz through the relay (Conduit plays, the Jellyfin
// backfill and LB's Spotify import all land there), matched to the library
// for art and playback where the song exists here.
const RANGES = [['4w', 'Last 4 weeks'], ['6m', 'Last 6 months'], ['1y', 'Last year'], ['all', 'Lifetime']];
const fmtN = (n) => (n ?? 0).toLocaleString();
const ago = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 300 * 86400 ? 'numeric' : undefined });
};
const hourLabel = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One-series bar strip: a div per bar, height = share of the max, hover title.
function Bars({ values, labels, titles, every = 1 }) {
  const max = Math.max(1, ...values);
  return (
    <div className="hbars" style={{ '--n': values.length }}>
      {values.map((v, i) => (
        <div key={i} className="hbar" title={titles ? titles[i] : `${labels?.[i] ?? i}: ${fmtN(v)}`}>
          <i style={{ height: `${Math.max(v ? 3 : 1, (v / max) * 100)}%` }} />
          {labels && i % every === 0 && <span>{labels[i]}</span>}
        </div>
      ))}
    </div>
  );
}

export default function History({ jf, player, onOpenArtist, onOpenAlbum, onOpenSettings }) {
  const [range, setRange] = useState(() => localStorage.getItem('conduit.histRange') || '4w');
  const [data, setData] = useState({}); // range -> stats | { error }
  const [recent, setRecent] = useState(null);
  const [more, setMore] = useState(false);
  useEffect(() => { try { localStorage.setItem('conduit.histRange', range); } catch {} }, [range]);
  useEffect(() => {
    if (data[range]) return undefined;
    let alive = true;
    relayHistory(jf, { range }).then((r) => { if (alive) setData((d) => ({ ...d, [range]: r })); })
      .catch((e) => { if (alive) setData((d) => ({ ...d, [range]: { error: e.message } })); });
    return () => { alive = false; };
  }, [range, jf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (recent) return undefined;
    let alive = true;
    relayHistory(jf, { recent: 1 }).then((r) => { if (alive) setRecent(r.listens || []); }).catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => {
    if (!recent?.length) return;
    setMore(true);
    try { const r = await relayHistory(jf, { recent: 1, before: recent[recent.length - 1].ts }); setRecent((cur) => [...(cur || []), ...(r.listens || [])]); }
    catch { /* keep what we have */ }
    setMore(false);
  };

  const st = data[range];
  // Play a history row: the matched library track, then the rest of the list
  // that exists here, so next/previous walk the chart.
  const playRow = async (rows, idx) => {
    const ids = rows.filter((r) => r.id).map((r) => r.id);
    const start = ids.indexOf(rows[idx].id);
    if (start < 0) return;
    const items = await jf.itemsByIds(ids.slice(0, 100));
    const at = items.findIndex((t) => t.Id === rows[idx].id);
    if (at >= 0) player.playQueue(items, at, null);
  };

  const art = (r, size = 80) => (r.albumId || r.id) ? jf.imageUrl(r.albumId || r.id, { maxHeight: size }) : null;
  const Row = ({ r, i, rows, sub, count }) => (
    <div className={`hrow ${r.id ? 'playable' : ''} ${player.nowPlayingId && r.id === player.nowPlayingId ? 'active' : ''}`} onDoubleClick={() => r.id && playRow(rows, i)}>
      <span className="hrow-n">{i + 1}</span>
      <button className="hrow-art" onClick={() => r.id && playRow(rows, i)} title={r.id ? 'Play' : 'Not in your library'} disabled={!r.id}>
        {art(r) ? <img src={art(r)} alt="" loading="lazy" /> : <span className="ph" />}
        {r.id && <span className="hrow-play"><PlayGlyph size={14} /></span>}
      </button>
      <span className="hrow-text">
        <span className="hrow-title">{r.name}</span>
        <small>{sub}</small>
      </span>
      <span className="hrow-count">{count}</span>
    </div>
  );

  return (
    <div className="content">
      <div className="pad history">
        <header className="history-head">
          <div>
            <div className="kind">Profile</div>
            <h1>Listening history</h1>
            {st?.connected && <p className="hero-meta">{fmtN(st.total)} streams on ListenBrainz{st.firstTs ? ` since ${new Date(st.firstTs * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : ''}{st.sources?.spotify ? ` · ${fmtN(st.sources.spotify)} imported from Spotify` : ''}</p>}
          </div>
          <div className="pills">
            {RANGES.map(([k, label]) => <button key={k} className={`pill ${range === k ? 'on' : ''}`} onClick={() => setRange(k)}>{label}</button>)}
          </div>
        </header>

        {!st && <p className="placeholder-note">Loading your history&hellip; the first open pulls everything from ListenBrainz, which can take a minute.</p>}
        {st?.error && <p className="placeholder-note">Could not load history: {st.error}</p>}
        {st && !st.error && !st.connected && (
          <div className="history-connect">
            <p>Your history lives on ListenBrainz. Connect your account under Settings &rsaquo; Scrobbling and every play (here, and Spotify if you link it there) starts counting.</p>
            <button className="btn-secondary" onClick={onOpenSettings}>Open Settings</button>
          </div>
        )}

        {st?.connected && (
          <>
            <div className="stat-tiles">
              {[['Streams', st.streams], ['Minutes', st.minutes], ['Hours', Math.round(st.minutes / 60)], ['Tracks', st.uniqueTracks], ['Artists', st.uniqueArtists], ['Albums', st.uniqueAlbums]].map(([k, v]) => (
                <div key={k} className="stat-tile"><b>{fmtN(v)}</b><span>{k}</span></div>
              ))}
            </div>
            {st.streams === 0 && <p className="placeholder-note">Nothing in this range yet.</p>}

            {st.topTracks.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Top tracks</h2></div>
                <div className="hlist">
                  {st.topTracks.slice(0, 10).map((r, i) => <Row key={`${r.name}|${r.artist}`} r={r} i={i} rows={st.topTracks} sub={r.artistId ? <span className="rowlink" role="button" onClick={() => onOpenArtist(r.artistId)}>{r.artist}</span> : r.artist} count={`${fmtN(r.count)} streams · ${fmtN(Math.round(r.seconds / 60))} min`} />)}
                </div>
              </section>
            )}

            {st.topArtists.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Top artists</h2></div>
                <div className="shelf">
                  {st.topArtists.slice(0, 10).map((a, i) => (
                    <div key={a.name} className="card round" role="button" tabIndex={0} onClick={() => a.artistId && onOpenArtist(a.artistId)} style={{ cursor: a.artistId ? 'pointer' : 'default' }}>
                      <div className="card-art">{a.artistId ? <img src={jf.imageUrl(a.artistId, { maxHeight: 320 })} alt="" loading="lazy" /> : <div className="ph" />}<span className="card-rank">{i + 1}</span></div>
                      <div className="card-title">{a.name}</div>
                      <div className="card-sub">{fmtN(a.count)} streams · {fmtN(Math.round(a.seconds / 60))} min</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {st.topAlbums.length > 0 && (
              <section>
                <div className="shelf-head"><h2>Top albums</h2></div>
                <div className="shelf">
                  {st.topAlbums.slice(0, 10).map((a, i) => (
                    <div key={`${a.name}|${a.artist}`} className="card" role="button" tabIndex={0} onClick={() => a.albumId && onOpenAlbum(a.albumId)} style={{ cursor: a.albumId ? 'pointer' : 'default' }}>
                      <div className="card-art">{a.albumId ? <img src={jf.imageUrl(a.albumId, { maxHeight: 320 })} alt="" loading="lazy" /> : <div className="ph" />}<span className="card-rank">{i + 1}</span></div>
                      <div className="card-title">{a.name}</div>
                      <div className="card-sub">{a.artist} · {fmtN(a.count)} streams</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="history-grid">
              {st.topGenres.length > 0 && (
                <section>
                  <div className="shelf-head"><h2>Top genres</h2></div>
                  <div className="genre-bars">
                    {st.topGenres.map((g) => (
                      <div key={g.id} className="genre-bar" title={`${g.name}: ${fmtN(g.count)} streams`}>
                        <span>{g.name}</span>
                        <i style={{ width: `${(g.count / st.topGenres[0].count) * 100}%` }} />
                        <b>{fmtN(g.count)}</b>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <div className="shelf-head"><h2>Listening clock</h2></div>
                <p className="shelf-sub">Streams by hour of the day</p>
                <Bars values={st.byHour} labels={st.byHour.map((_, h) => hourLabel(h))} every={6} />
              </section>
              <section>
                <div className="shelf-head"><h2>By weekday</h2></div>
                <p className="shelf-sub">Streams by day of the week</p>
                <Bars values={st.byDow} labels={DOW} />
              </section>
            </div>

            {st.perDay.length > 1 && (
              <section>
                <div className="shelf-head"><h2>Streams per day</h2></div>
                <Bars values={st.perDay.map((d) => d.count)} titles={st.perDay.map((d) => `${d.day}: ${fmtN(d.count)}`)} labels={st.perDay.map((d) => d.day.slice(5))} every={Math.max(1, Math.round(st.perDay.length / 8))} />
              </section>
            )}

            <section>
              <div className="shelf-head"><h2>Recent streams</h2></div>
              <div className="hlist">
                {(recent || []).map((r, i) => (
                  <div key={`${r.ts}-${i}`} className={`hrow norank ${r.id ? 'playable' : ''}`} onDoubleClick={() => r.id && playRow(recent.map((x) => ({ ...x, name: x.track })), i)}>
                    <button className="hrow-art" onClick={() => r.id && playRow(recent.map((x) => ({ ...x, name: x.track })), i)} title={r.id ? 'Play' : 'Not in your library'} disabled={!r.id}>
                      {art(r) ? <img src={art(r)} alt="" loading="lazy" /> : <span className="ph" />}
                      {r.id && <span className="hrow-play"><PlayGlyph size={14} /></span>}
                    </button>
                    <span className="hrow-text">
                      <span className="hrow-title">{r.track}</span>
                      <small>{r.artistId ? <span className="rowlink" role="button" onClick={() => onOpenArtist(r.artistId)}>{r.artist}</span> : r.artist}{r.album ? ` · ${r.album}` : ''}</small>
                    </span>
                    <span className="hrow-count">{r.src === 'spotify' ? <span className="hsrc">Spotify</span> : null}{ago(r.ts)}</span>
                  </div>
                ))}
                {recent === null && <p className="placeholder-note">Loading&hellip;</p>}
                {recent?.length > 0 && <button className="seemore" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Load more'}</button>}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
