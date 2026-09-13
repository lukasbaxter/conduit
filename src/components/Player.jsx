import React, { useState } from 'react';
import DevicePicker from './DevicePicker.jsx';
import { Heart, ShuffleGlyph, ArtistLinks } from './TrackRow.jsx';

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PlayingElsewhereBar({ player }) {
  const { roster, relay, device } = player;
  // Where the sound is coming out, if not this client's own output:
  //  - the session is on another of my clients -> that client's name, unless
  //    that client is itself driving a speaker -> the speaker's name;
  //  - this client is the player but the sound is on a speaker (Node, TV) ->
  //    the speaker's name. Every client then shows the same "Playing on Node".
  const myId = relay?.id;
  const activeId = roster?.activeClientId;
  const active = activeId && activeId !== myId
    ? (roster.players || []).find((p) => p.id === activeId)
    : null;
  const isSpeaker = (d) => d && d.kind !== 'local' && d.kind !== 'relay';
  let label = null;
  if (active) label = isSpeaker(active.nowPlaying?.device) ? active.nowPlaying.device.name : active.name;
  else if (isSpeaker(device)) label = device.name;
  if (!label) return null;
  return (
    <div className="playing-elsewhere">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
        <path d="M2 12a9 9 0 0 1 8 8" />
        <path d="M2 16a5 5 0 0 1 4 4" />
        <path d="M2 20h.01" />
      </svg>
      <span>Playing on {label}</span>
    </div>
  );
}

export default function Player({ player, jf, devices, onOpenAlbum, onOpenArtist, panel, onPanel, onLike, onFullScreen }) {
  const { current, nowPlaying, playing, position, duration, volume, device, error, roster, relay, repeat, shuffle } = player;
  // The device the SESSION is on, not just this client's local selection. When
  // another of my clients is the active player, the picker must point at that
  // client (matching the green bar) instead of falsely marking "This Computer"
  // as active -- the contradictory state where the app claimed both at once.
  const activeId = roster?.activeClientId;
  const activeSpeaker = nowPlaying?.device && nowPlaying.device.kind !== 'local' && nowPlaying.device.kind !== 'relay'
    ? nowPlaying.device : null;
  const sessionDevice = activeId && activeId !== relay?.id
    ? (activeSpeaker
        // The other client is driving a speaker: the session is ON the speaker.
        ? (devices.find((d) => d.id === activeSpeaker.id) || { ...activeSpeaker, model: '' })
        : devices.find((d) => d.kind === 'relay' && d.relayClientId === activeId)
          || { id: `relay:${activeId}`, kind: 'relay', name: (roster.players || []).find((p) => p.id === activeId)?.name || 'Conduit' })
    : device;
  // nowPlaying covers both our own queue and a session adopted from a speaker
  // that was already playing when the app opened.
  // artId is our own library item; artUrl is a ready URL from a mirrored relay
  // target. Either yields the cover.
  const art = nowPlaying?.artId ? jf.imageUrl(nowPlaying.artId, { maxHeight: 128 }) : (nowPlaying?.artUrl || null);
  // While dragging, the bar follows the thumb locally and commits ONE seek on
  // release. Committing on every change event fired a seek per pixel of drag,
  // which thrashed the speaker and made scrubbing unusable.
  const [scrub, setScrub] = useState(null);
  const shown = scrub != null ? scrub : position;
  const pct = duration > 0 ? (shown / duration) * 100 : 0;

  const commitScrub = () => {
    if (scrub == null) return;
    player.seek(scrub);
    setScrub(null);
  };

  return (
    <footer className="player">
      {error && (
        <div className="player-error" onClick={player.clearError} title="Dismiss">
          {error}
        </div>
      )}

      <div
        className="player-row"
        // Phone: the bar is one big button into the now-playing view; its own
        // controls (play, heart, links) still win.
        onClick={(e) => { if (e.target.closest('button, input, a, [role=button]')) return; if (window.matchMedia('(max-width: 760px)').matches) onFullScreen?.(); }}
      >
        <div className="player-now">
          {art ? (
            <img
              className={`player-art ${nowPlaying?.albumId ? 'clickable' : ''}`}
              src={art}
              alt=""
              title="Go to album"
              onClick={() => nowPlaying?.albumId && onOpenAlbum?.(nowPlaying.albumId)}
            />
          ) : (
            <div className="player-art placeholder" />
          )}
          <div className="player-meta">
            <div className="player-title">{nowPlaying?.title || 'Nothing playing'}</div>
            <div className="player-artist">
              {nowPlaying?.artists?.length ? (
                <ArtistLinks artists={nowPlaying.artists} onOpen={onOpenArtist} className="linkish" />
              ) : nowPlaying?.artistId ? (
                <button className="linkish" onClick={() => onOpenArtist(nowPlaying.artistId)}>{nowPlaying.artist}</button>
              ) : (
                nowPlaying?.artist || ''
              )}
            </div>
          </div>
          {nowPlaying?.itemId && (
            // Follows the SESSION track (mirrored liked state included), so the
            // heart works on a client that is only controlling another one.
            <button
              className={`trackrow-like ${nowPlaying.liked ? 'on' : ''}`}
              style={{ opacity: 1 }}
              onClick={() => onLike?.(current || { Id: nowPlaying.itemId, Name: nowPlaying.title, _partial: true }, !nowPlaying.liked)}
              title={nowPlaying.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
            >
              <Heart on={Boolean(nowPlaying.liked)} />
            </button>
          )}
        </div>

        <div className="player-controls">
          <div className="player-buttons">
            <button
              className={`ctl-mode ${shuffle && shuffle !== 'off' ? 'on' : ''}`}
              onClick={player.cycleShuffle}
              title={shuffle === 'smart' ? 'Smart shuffle' : shuffle === 'on' ? 'Shuffle' : 'Enable shuffle'}
            >
              <ShuffleGlyph size={16} />
              {shuffle === 'smart' && (
                <svg className="ctl-spark" viewBox="0 0 24 24" width="9" height="9" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
                </svg>
              )}
            </button>
            <button onClick={player.previous} disabled={!nowPlaying} title="Previous">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
              </svg>
            </button>
            <button className="play" onClick={player.toggle} disabled={!nowPlaying}
              title={playing ? 'Pause' : 'Play'}>
              {playing ? (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                  <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z" />
                </svg>
              )}
            </button>
            <button onClick={player.next} disabled={!nowPlaying} title="Next">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6z" />
              </svg>
            </button>
            <button
              className={`ctl-mode ${repeat && repeat !== 'off' ? 'on' : ''}`}
              onClick={player.cycleRepeat}
              title={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat' : 'Enable repeat'}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m17 2 4 4-4 4" />
                <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
                <path d="m7 22-4-4 4-4" />
                <path d="M21 13v1a4 4 0 0 1-4 4H3" />
                {repeat === 'one' && <path d="M11 10h1v4" />}
              </svg>
            </button>
          </div>

          <div className="player-seek">
            <span className="t">{fmt(shown)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(1, Math.floor(duration))}
              value={Math.floor(shown)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              onBlur={commitScrub}
              disabled={!nowPlaying || !duration}
              style={{ '--pct': `${pct}%` }}
            />
            <span className="t">{fmt(duration)}</span>
          </div>
        </div>

        <div className="player-right">
          <button
            className={`icon-btn ${panel === 'lyrics' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'lyrics' ? null : 'lyrics')}
            title="Lyrics"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797zM10.5 8.118l-2.619-2.62A63303.13 63303.13 0 0 0 4.74 9.075L1 15l5.925-3.74 3.575-3.142z" />
            </svg>
          </button>
          <button
            className={`icon-btn ${panel === 'queue' ? 'on' : ''}`}
            onClick={() => onPanel(panel === 'queue' ? null : 'queue')}
            title="Queue"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
              <path d="M15 15H1v-1.5h14V15zm0-4.5H1V9h14v1.5zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5zm2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2h-9z" />
            </svg>
          </button>
          <DevicePicker devices={devices} active={sessionDevice} onSelect={player.setDevice} />
          <div className="player-volume" title={`Volume ${volume}%`}>
            {/* Spotify's speaker glyph, one arc per volume band; click = mute toggle. */}
            <button className="vol-ico" onClick={() => player.setVolume(volume > 0 ? 0 : 60)} title={volume > 0 ? 'Mute' : 'Unmute'}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                {volume === 0 ? (
                  <>
                    <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z" />
                    <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z" />
                  </>
                ) : (
                  <>
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z" />
                    {volume > 40 && <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z" />}
                  </>
                )}
              </svg>
            </button>
            <input
              type="range" min="0" max="100" value={volume}
              onChange={(e) => player.setVolume(Number(e.target.value))}
              style={{ '--pct': `${volume}%` }}
            />
          </div>
          <button className="icon-btn" onClick={onFullScreen} title="Now playing view">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.53 9.47a.75.75 0 0 1 0 1.06l-2.72 2.72h1.018a.75.75 0 0 1 0 1.5H1.25v-3.579a.75.75 0 0 1 1.5 0v1.018l2.72-2.72a.75.75 0 0 1 1.06 0zm2.94-2.94a.75.75 0 0 1 0-1.06l2.72-2.72h-1.018a.75.75 0 1 1 0-1.5h3.578v3.579a.75.75 0 0 1-1.5 0V3.81l-2.72 2.72a.75.75 0 0 1-1.06 0z" /></svg>
          </button>
        </div>
      </div>
    </footer>
  );
}
