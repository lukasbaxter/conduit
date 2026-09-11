import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The local device is always present and is not discovered over mDNS.
export const LOCAL_DEVICE = {
  id: 'local',
  kind: 'local',
  name: 'This Computer',
  model: 'Local playback',
};

const MIME_BY_CONTAINER = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

function containerOf(track) {
  const c = (track?._container || track?.MediaSources?.[0]?.Container || track?.Container || '').toLowerCase();
  return c.split(',')[0] || '';
}

function mimeOf(track) {
  return MIME_BY_CONTAINER[containerOf(track) || 'mp3'] || 'audio/mpeg';
}

function ticksToSeconds(ticks) {
  return ticks ? ticks / 10_000_000 : 0;
}

/**
 * One playback controller covering local audio, Google Cast and BluOS.
 *
 * Switching `device` mid-track is a handoff: position is captured from the
 * outgoing device, playback is stopped there, and the incoming device resumes
 * from the same offset. That is the "playing on this device" behaviour.
 */
export function usePlayer(jf) {
  const [device, setDeviceState] = useState(LOCAL_DEVICE);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(80);
  const [error, setError] = useState(null);
  // What a speaker reports playing when we did not start it ourselves (another
  // client, or this app on another machine). Lets a freshly opened window show
  // the house's current playback instead of claiming nothing is on.
  const [external, setExternal] = useState(null);
  const [contextId, setContextId] = useState(null);
  const [roster, setRoster] = useState({ players: [], lanDevices: [] });
  const relayRef = useRef(null);
  const pinnedRef = useRef(false); // user explicitly chose a device
  const adoptedRef = useRef(false);

  const audioRef = useRef(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
  }

  // Mirrors of state that async callbacks and intervals need to read without
  // being re-created on every tick.
  const deviceRef = useRef(device);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const queueRef = useRef([]);
  const indexRef = useRef(-1);
  // Last known remote position plus when we learned it, so the ticker can
  // interpolate instead of stepping once per poll.
  const anchorRef = useRef({ pos: 0, at: Date.now(), playing: false });
  // True while a handoff is in flight. The status poll re-subscribes to the new
  // device the instant `device` changes, which is BEFORE that device has been
  // told to play -- it then reports "not playing, position 0" and clobbers the
  // position we are trying to carry across. Ignore poll results while this is
  // set, and the handoff keeps its timestamp.
  const transitionRef = useRef(false);
  // Counts consecutive polls that disagree with our interpolated clock. One
  // bad reading is a hiccup (a receiver reopening a stream reports secs=0 for a
  // beat); several in a row means the device really did move and we should
  // believe it.
  const disagreeRef = useRef(0);
  // Consecutive polls where the device claims to play but the playhead has not
  // moved at all. BluOS lands in exactly this state if a stream is disturbed
  // mid-setup: playing=true, position frozen, silence.
  const stalledRef = useRef(0);
  // Set while the user is dragging the volume slider, so the device poll does
  // not yank the handle back to the last value it reported.
  const volumeHeldRef = useRef(0);
  const playQueueRef = useRef(() => {});
  const toggleRef = useRef(() => {});
  const seekRef = useRef(() => {});
  const yieldRef = useRef(() => {});
  const setVolumeRef = useRef(() => {});
  const activePlayerRef = useRef(null); // clientId of the active player, if not us

  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { indexRef.current = index; }, [index]);

  // Re-anchor whenever we knowingly move the playhead, so the interpolated
  // clock does not drift back to a stale value before the next poll.
  const anchorAt = useCallback((seconds, isPlaying = true) => {
    anchorRef.current = { pos: seconds, at: Date.now(), playing: isPlaying };
    setPosition(seconds);
  }, []);

  const current = index >= 0 ? queue[index] || null : null;
  const remote = typeof window !== 'undefined' ? window.conduit?.remote : null;

  const [relayInstance, setRelayInstance] = useState(null);
  const attachRelay = useCallback((relay) => { relayRef.current = relay; setRelayInstance(relay); }, []);
  // Display and control-routing follow the shared session (derived at render),
  // so this just stores the roster.
  const applyRoster = useCallback((r) => setRoster(r), []);

  // Remote players from the relay, presented as selectable devices.
  const relayDevices = roster.players
    .filter((p) => p.canPlay)
    .map((p) => ({ id: `relay:${p.id}`, kind: 'relay', name: p.name, model: p.kind === 'desktop' ? 'Desktop' : 'Conduit', relayClientId: p.id }));

  const metaFor = useCallback(
    (track) => {
      // Album art first; the artist portrait is a fallback for tracks whose
      // album has none, which is most of this library until the retag lands.
      const artistId = track.ArtistItems?.[0]?.Id || track.AlbumArtists?.[0]?.Id || null;
      const art = jf?.imageUrl(track.AlbumId || track.Id, { maxHeight: 1000 });
      const artistArt = artistId ? jf?.imageUrl(artistId, { maxHeight: 1000 }) : null;
      return {
        title: track.Name || 'Unknown title',
        artist: track.Artists?.join(', ') || track.AlbumArtist || '',
        album: track.Album || '',
        artwork: art || artistArt || undefined,
        artworkFallback: artistArt || undefined,
        contentType: mimeOf(track),
      };
    },
    [jf]
  );

  // --- low-level per-transport operations ---------------------------------

  const startOn = useCallback(
    async (dev, track, seekSeconds = 0) => {
      if (!jf || !track) return;
      if (dev.kind === 'local') {
        const el = audioRef.current;
        el.src = jf.streamUrl(track.Id);
        el.volume = volume / 100;
        if (seekSeconds > 0) {
          // The seek has to land BEFORE play(), otherwise playback audibly
          // starts at zero and only then jumps, which reads as a reset. Jellyfin
          // serves the static stream with Accept-Ranges, so the element really
          // can seek; it just needs metadata first.
          await new Promise((resolve) => {
            let done = false;
            const settle = () => {
              if (done) return;
              done = true;
              try { el.currentTime = seekSeconds; } catch { /* not seekable yet */ }
              resolve();
            };
            if (el.readyState >= 1) settle();
            else el.addEventListener('loadedmetadata', settle, { once: true });
            // Never hang the handoff on a stream that will not report metadata.
            setTimeout(settle, 3000);
          });
        }
        await el.play();
      } else {
        // The list fetch skipped MediaSources; get the container now so Cast
        // gets the right MIME. One tiny request, cached.
        if (!containerOf(track) && jf.container) {
          try { track._container = await jf.container(track.Id); } catch { /* default */ }
        }
        // Play the static file, then seek. The offset cannot go in the URL:
        // Jellyfin's transcoded offset stream is chunked with no Content-Length
        // and BluOS silently refuses to load it.
        const url = jf.streamUrl(track.Id);
        await remote.play(dev, url, metaFor(track));
        if (seekSeconds > 0) {
          // No fixed delay here: the transport waits for the device to report
          // the stream open and seekable. Seeking too early tears the stream
          // down and leaves the player frozen at 0 with no audio.
          await remote.seek(dev, seekSeconds).catch(() => {});
        }
      }
      jf.reportStart(track.Id);
    },
    [jf, metaFor, remote, volume]
  );

  const stopOn = useCallback(
    async (dev) => {
      if (!dev) return;
      if (dev.kind === 'local') {
        const el = audioRef.current;
        el.pause();
        el.removeAttribute('src');
        el.load();
        return;
      }
      // Acknowledging a stop is not the same as having stopped, so we verify.
      // But that verification must NEVER be awaited by the handoff: a device
      // that is slow or asleep can take seconds per status call, and blocking
      // on it froze the whole window. Issue the stop, then confirm in the
      // background under a hard deadline.
      await remote.stop(dev).catch(() => {});
      (async () => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const s = await remote.status(dev).catch(() => null);
          if (!s || !s.playing) return;
          await remote.stop(dev).catch(() => {});
        }
      })();
    },
    [remote]
  );

  // --- public controls ----------------------------------------------------

  const playQueue = useCallback(
    async (tracks, startIndex = 0, ctx = null) => {
      // If another of my clients is the active player, change the song THERE.
      const act = activePlayerRef.current;
      if (act && relayRef.current) {
        relayRef.current.command(act, {
          action: 'play', trackIds: tracks.map((t) => t.Id), index: startIndex, ctx,
        });
        return; // display mirrors the active player; nothing to set locally
      }
      // No active remote session: play here and become the active player.
      if (relayRef.current) relayRef.current.claim();
      setError(null);
      setExternal(null);
      setContextId(ctx);
      setQueue(tracks);
      setIndex(startIndex);
      queueRef.current = tracks;
      indexRef.current = startIndex;
      const track = tracks[startIndex];
      setDuration(ticksToSeconds(track?.RunTimeTicks));
      anchorAt(0, true);
      try {
        await startOn(deviceRef.current, track, 0);
        setPlaying(true);
      } catch (e) {
        setError(e.message);
        setPlaying(false);
      }
    },
    [anchorAt, startOn]
  );

  const skipTo = useCallback(
    async (nextIndex) => {
      const q = queueRef.current;
      if (nextIndex < 0 || nextIndex >= q.length) {
        await stopOn(deviceRef.current);
        setPlaying(false);
        setIndex(-1);
        return;
      }
      setIndex(nextIndex);
      indexRef.current = nextIndex;
      const track = q[nextIndex];
      setDuration(ticksToSeconds(track?.RunTimeTicks));
      anchorAt(0, true);
      try {
        await startOn(deviceRef.current, track, 0);
        setPlaying(true);
      } catch (e) {
        setError(e.message);
      }
    },
    [anchorAt, startOn, stopOn]
  );

  const next = useCallback(() => skipTo(indexRef.current + 1), [skipTo]);
  const previous = useCallback(() => {
    // Match the usual convention: restart the track unless we are near its start.
    if (positionRef.current > 3) return skipTo(indexRef.current);
    return skipTo(indexRef.current - 1);
  }, [skipTo]);

  const toggle = useCallback(async () => {
    const dev = deviceRef.current;
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'toggle' }); return; }
    if (!current && !external) return;
    try {
      if (dev.kind === 'local') {
        const el = audioRef.current;
        if (playing) el.pause();
        else await el.play();
      } else if (playing) {
        await remote.pause(dev);
      } else {
        await remote.resume(dev);
      }
      anchorAt(positionRef.current, !playing);
      setPlaying(!playing);
    } catch (e) {
      setError(e.message);
    }
  }, [anchorAt, current, external, playing, remote]);

  const seek = useCallback(
    async (seconds) => {
      const dev = deviceRef.current;
      const act = activePlayerRef.current;
      if (act && relayRef.current) { relayRef.current.command(act, { action: 'seek', pos: seconds }); return; }
      const track = queueRef.current[indexRef.current];
      // Scrubbing with nothing loaded used to fire /Play?seek= at a speaker that
      // had no stream, which is how a device ended up in a stalled state before
      // anything was even playing.
      if (!track) return;

      disagreeRef.current = 0;
      stalledRef.current = 0;
      anchorAt(seconds, true);

      if (dev.kind === 'local') {
        audioRef.current.currentTime = seconds;
        return;
      }

      try {
        await remote.seek(dev, seconds);
      } catch (e) {
        // Only rebuild the stream when the device genuinely cannot seek the one
        // it has. Re-playing on every hiccup restarted the track under the user
        // and could kill the stream outright.
        if (e.message?.includes('not seekable') || e.message?.includes('ENOSEEK')) {
          try {
            await startOn(dev, track, seconds);
            anchorAt(seconds, true);
            setPlaying(true);
          } catch (e2) {
            setError(e2.message);
          }
          return;
        }
        setError(e.message);
      }
    },
    [anchorAt, remote, startOn]
  );

  const setVolume = useCallback(
    async (level) => {
      const act = activePlayerRef.current;
      if (act && relayRef.current) { relayRef.current.command(act, { action: 'setVolume', level }); setVolumeState(level); return; }
      // Hold off the poll briefly so it cannot fight the drag.
      volumeHeldRef.current = Date.now() + 2000;
      setVolumeState(level);
      const dev = deviceRef.current;
      try {
        if (dev.kind === 'local') audioRef.current.volume = level / 100;
        else await remote.setVolume(dev, level);
      } catch {
        // Some receivers reject volume while idle; not worth surfacing.
      }
    },
    [remote]
  );

  /**
   * On first load, find any speaker that is already playing and adopt it as the
   * active device, so opening the app anywhere shows where music is running.
   * Runs once, and never overrides a device the user has already chosen.
   */
  const adoptActive = useCallback(
    async (deviceList) => {
      // Do not latch before we can actually resolve a track. Devices are
      // discovered ~0.4s after launch, while restoring the Jellyfin session is
      // an async round trip, so `jf` is usually still null at that point.
      // Latching here meant adoption ran once, found a playing speaker, and
      // gave up on the lookup -- position and device were right, title and art
      // were empty.
      if (adoptedRef.current || !remote || !deviceList.length || !jf) return null;
      // Do NOT latch here. mDNS discovers speakers progressively, so the first
      // list is usually one device; latching on it meant we gave up before the
      // playing speaker had even been found. Only latch once we actually adopt,
      // or once this window starts its own playback.
      if (queueRef.current.length) {
        adoptedRef.current = true;
        return null;
      }
      const checks = deviceList.map(async (d) => {
        const s = await remote.status(d).catch(() => null);
        return s && s.playing ? { d, s } : null;
      });
      const hit = (await Promise.all(checks)).find(Boolean);
      // No one is playing yet; stay unlatched so a later scan can still adopt.
      if (!hit) return null;
      // Re-check: the user may have hit play while we were polling the network.
      if (queueRef.current.length) return null;
      adoptedRef.current = true;
      setDeviceState(hit.d);
      deviceRef.current = hit.d;
      setExternal({ title: hit.s.title, artist: hit.s.artist, album: hit.s.album });
      setDuration(hit.s.duration || 0);
      anchorAt(hit.s.position || 0, true);
      setPlaying(true);
      return hit.d;
    },
    [anchorAt, jf, remote]
  );

  /** Move playback to another device, preserving track and position. */
  const setDevice = useCallback( // eslint-disable-next-line react-hooks/exhaustive-deps
    async (nextDevice) => {
      const prev = deviceRef.current;

      // Picking another of my clients: hand the active session to it.
      if (nextDevice.kind === 'relay' && relayRef.current) {
        const cur = queueRef.current[indexRef.current];
        if (cur) relayRef.current.command(nextDevice.relayClientId, { action: 'play', trackIds: [cur.Id], index: 0 });
        return;
      }

      // Transferring away from a remote active session onto THIS device (local
      // or a speaker): take over playback of that session's current track here.
      const act = activePlayerRef.current;
      if (act) {
        const np = (roster.players || []).find((p) => p.id === act)?.nowPlaying;
        setDeviceState(nextDevice); deviceRef.current = nextDevice;
        if (np?.itemId && jf) {
          try {
            const q = new URLSearchParams({ Ids: np.itemId, userId: jf.userId, Fields: 'MediaSources,ArtistItems,AlbumArtists,UserData' });
            const data = await jf._fetch(`/Items?${q}`);
            const t = (data.Items || [])[0];
            if (t) {
              relayRef.current?.claim();
              setQueue([t]); setIndex(0); queueRef.current = [t]; indexRef.current = 0;
              setDuration(ticksToSeconds(t.RunTimeTicks));
              anchorAt(np.position || 0, true);
              await startOn(nextDevice, t, np.position || 0);
              setPlaying(true);
            }
          } catch (e) { setError(e.message); }
        }
        return;
      }

      if (prev.id === nextDevice.id) return;
      const track = queueRef.current[indexRef.current] || null;
      const wasPlaying = playing;

      // Read the position off the interpolated clock rather than React state,
      // which can be a render behind at the instant of the click.
      const a = anchorRef.current;
      const at = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;

      transitionRef.current = true;
      setDeviceState(nextDevice);
      deviceRef.current = nextDevice;
      setError(null);
      // Hold the carried timestamp on screen rather than snapping to zero while
      // the incoming device spins up.
      anchorAt(at, wasPlaying);

      try {
        await stopOn(prev);
        if (track && wasPlaying) {
          await startOn(nextDevice, track, at);
          anchorAt(at, true);
          setPlaying(true);
        }
      } catch (e) {
        setError(`Could not move playback to ${nextDevice.name}: ${e.message}`);
        setPlaying(false);
      } finally {
        // Show the incoming device's real volume rather than carrying the old
        // one across; they are independent hardware levels.
        if (nextDevice.kind !== 'local') {
          remote.status(nextDevice)
            .then((s) => { if (typeof s?.volume === 'number') setVolumeState(s.volume); })
            .catch(() => {});
        } else {
          setVolumeState(Math.round((audioRef.current?.volume ?? 0.8) * 100));
        }
        // Let the receiver actually begin before trusting its status again.
        setTimeout(() => { transitionRef.current = false; }, 2500);
      }
    },
    [anchorAt, playing, startOn, stopOn]
  );

  // --- progress tracking --------------------------------------------------

  // Local playback drives position from the audio element itself.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;
    const onTime = () => {
      if (deviceRef.current.kind !== 'local') return;
      // During a handoff the element briefly reports 0 before the seek lands.
      // Writing that through would wipe the position we are carrying over.
      if (transitionRef.current) return;
      setPosition(el.currentTime);
      anchorRef.current = { pos: el.currentTime, at: Date.now(), playing: !el.paused };
    };
    const onEnded = () => {
      if (deviceRef.current.kind === 'local') next();
    };
    const onDuration = () => {
      if (deviceRef.current.kind === 'local' && Number.isFinite(el.duration)) {
        setDuration(el.duration);
      }
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('loadedmetadata', onDuration);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadedmetadata', onDuration);
    };
  }, [next]);

  // Remote devices have to be polled; they do not push state to us. Polling
  // alone makes the clock jump in 2s steps, so the poll only moves an anchor
  // and a local ticker interpolates between anchors for a smooth readout.
  useEffect(() => {
    if (device.kind === 'local' || !remote) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        if (transitionRef.current) return;
        const s = await remote.status(device);
        if (cancelled || !s || transitionRef.current) return;

        const a = anchorRef.current;
        const expected = a.playing ? a.pos + (Date.now() - a.at) / 1000 : a.pos;
        const reported = s.position || 0;

        // Track finished: advance the queue. Two signatures, because devices
        // disagree about what "finished" looks like:
        //   Cast:  playing=false with position sitting at the end.
        //   BluOS: playing=false with position reset to 0 -- indistinguishable
        //          from a stop unless we remember we were near the end.
        // Only look for end-of-track while we actually believe we're playing.
        // Crucially, clear the anchor's playing flag BEFORE advancing: skipping
        // that let a.playing stay true after the queue ended, so every later
        // poll re-fired "past the end" and stopped the device in a 2s loop.
        const dur = s.duration || durationRef.current;
        const atEnd = a.playing && dur > 0
          && (reported >= dur - 1.5 || (reported === 0 && expected >= dur - 3));
        if (!s.playing && atEnd) {
          disagreeRef.current = 0;
          anchorRef.current = { pos: reported, at: Date.now(), playing: false };
          next();
          return;
        }

        // A receiver reopening a stream briefly reports 0 (or a big rewind)
        // while still claiming to play. Accepting that is what made the clock
        // flicker 0,1,0. Hold our own estimate until the device says the same
        // thing several polls running.
        const rewound = a.playing && reported < expected - 5;
        if (rewound && disagreeRef.current < 2) {
          disagreeRef.current += 1;
          if (s.duration) setDuration(s.duration);
          return;
        }
        disagreeRef.current = 0;

        // A playing device whose position never advances is a dead stream, not
        // playback. Re-establish it once rather than showing a frozen 0.
        if (s.playing && reported === a.pos && reported === 0) {
          stalledRef.current += 1;
          if (stalledRef.current === 3) {
            const track = queueRef.current[indexRef.current];
            if (track) {
              setError('Stream stalled on the speaker, restarting it');
              startOn(device, track, 0).catch(() => {});
            }
          }
          if (stalledRef.current < 6) return;
        } else {
          stalledRef.current = 0;
        }

        // De-bias a whole-second clock: the reported value is the floor of the
        // true position, so the expected true value is half a second later.
        const debiased = s.coarsePosition && s.playing ? reported + 0.5 : reported;
        anchorRef.current = { pos: debiased, at: Date.now(), playing: !!s.playing };
        if (s.duration) setDuration(s.duration);
        setPlaying(Boolean(s.playing));
        // The ticker only runs while playing; once it stops nothing else would
        // move the displayed position, so pin it to what the device reports.
        if (!s.playing) setPosition(debiased);
        // Mirror the speaker's own volume, including changes made from the
        // BluOS app or a physical dial -- but never while the user is dragging.
        if (typeof s.volume === 'number' && Date.now() > volumeHeldRef.current) {
          setVolumeState((v) => (Math.abs(v - s.volume) > 1 ? s.volume : v));
        }
      } catch {
        // Transient network blips are expected; keep polling.
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [device, next, remote, startOn]);

  // Interpolate the remote clock between polls so the seek bar moves smoothly.
  useEffect(() => {
    if (device.kind === 'local' || !playing) return undefined;
    const tick = setInterval(() => {
      const a = anchorRef.current;
      if (!a.playing) return;
      const next = a.pos + (Date.now() - a.at) / 1000;
      setPosition(durationRef.current ? Math.min(next, durationRef.current) : next);
    }, 200);
    return () => clearInterval(tick);
  }, [device, playing]);

  // Report progress back to Jellyfin so play counts and resume work.
  useEffect(() => {
    if (!jf || !current) return undefined;
    const timer = setInterval(() => {
      jf.reportProgress(current.Id, positionRef.current, !playing);
    }, 10000);
    return () => clearInterval(timer);
  }, [jf, current, playing]);

  // The active session lives on another of my clients: mirror it. This is
  // independent of my local `device` -- whichever client is playing account-
  // wide, every other client shows and controls THAT. Song and playhead always
  // describe the same real playback.
  const myClientId = relayInstance?.id;
  const activePlayer = roster.activeClientId && roster.activeClientId !== myClientId
    ? (roster.players || []).find((p) => p.id === roster.activeClientId)
    : null;
  const relayTarget = activePlayer?.nowPlaying || null;
  const relayTargetId = activePlayer?.id || null;

  // Either the mirrored active session, our own queue item, or an adopted speaker.
  const nowPlaying = relayTarget
    ? { title: relayTarget.title, artist: relayTarget.artist, artUrl: relayTarget.artUrl, artId: null }
    : current
    ? {
        title: current.Name,
        artist: current.Artists?.join(', ') || current.AlbumArtist || '',
        artId: current.AlbumId || current.Id,
        albumId: current.AlbumId || null,
        // ArtistItems carries the real artist entity; AlbumArtists is the
        // fallback for tracks credited only at album level.
        artistId: current.ArtistItems?.[0]?.Id || current.AlbumArtists?.[0]?.Id || null,
      }
    : external
    ? { title: external.title, artist: external.artist || '', artId: null }
    : null;

  // Run a command another client routed to us.
  const executeCommand = useCallback(async (cmd) => {
    if (!cmd) return;
    if (cmd.action === 'play' && jf && Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
      try {
        const q = new URLSearchParams({ Ids: cmd.trackIds.join(','), userId: jf.userId, Fields: 'ArtistItems,AlbumArtists,UserData' });
        const data = await jf._fetch(`/Items?${q}`);
        const byId = new Map((data.Items || []).map((t) => [t.Id, t]));
        const tracks = cmd.trackIds.map((id) => byId.get(id)).filter(Boolean);
        if (tracks.length) playQueueRef.current(tracks, cmd.index || 0, cmd.ctx || null);
      } catch { /* ignore */ }
    } else if (cmd.action === 'toggle') { toggleRef.current(); }
    else if (cmd.action === 'seek') { seekRef.current(cmd.pos || 0); }
    else if (cmd.action === 'setVolume') { setVolumeRef.current(cmd.level ?? 100); }
    else if (cmd.action === 'yield') { yieldRef.current(); }
  }, [jf]);

  const patchQueue = useCallback((fn) => {
    setQueue((q) => { const n = q.map(fn); queueRef.current = n; return n; });
  }, []);

  // Stop local audio and remote-device playback because another client took over.
  yieldRef.current = () => {
    const dev = deviceRef.current;
    if (dev.kind === 'local') { const el = audioRef.current; if (el) el.pause(); }
    else if (dev.kind !== 'relay' && remote) remote.pause(dev).catch(() => {});
    setPlaying(false);
    anchorRef.current = { pos: positionRef.current, at: Date.now(), playing: false };
  };
  useEffect(() => { playQueueRef.current = playQueue; }, [playQueue]);
  useEffect(() => { toggleRef.current = toggle; }, [toggle]);
  useEffect(() => { seekRef.current = seek; }, [seek]);
  useEffect(() => { setVolumeRef.current = setVolume; }, [setVolume]);
  useEffect(() => { activePlayerRef.current = relayTargetId; }, [relayTargetId]);

  // Broadcast what we're playing so the roster shows it on other clients. The
  // song AND the playhead go together, so a controller never shows a different
  // track from the position it displays.
  const npBaseUrl = jf?.baseUrl || '';
  useEffect(() => {
    const r = relayRef.current;
    if (!r) return;
    // Do not report while mirroring someone else's session -- only the active
    // player reports its state (title, playhead, volume) for everyone to sync to.
    if (relayTarget) return;
    r.reportNowPlaying(current ? {
      itemId: current.Id,
      title: current.Name,
      artist: current.Artists?.join(', ') || current.AlbumArtist || '',
      artUrl: `${npBaseUrl}/Items/${current.AlbumId || current.Id}/Images/Primary?maxHeight=128`,
      playing, position, duration, volume, at: Date.now(),
    } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, playing, Math.floor(position), duration, volume, relayTarget]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!relayTarget?.playing) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [relayTarget?.playing]);

  // Interpolate the active player's playhead so the mirrored bar moves smoothly.
  const shownPosition = relayTarget
    ? (relayTarget.playing ? (relayTarget.position || 0) + (Date.now() - (relayTarget.at || Date.now())) / 1000 : (relayTarget.position || 0))
    : position;
  const shownDuration = relayTarget ? (relayTarget.duration || 0) : duration;
  const shownPlaying = relayTarget ? Boolean(relayTarget.playing) : playing;
  const shownVolume = relayTarget && typeof relayTarget.volume === 'number' ? relayTarget.volume : volume;

  return useMemo(
    () => ({
      device, setDevice, adoptActive, nowPlaying, external, patchQueue, contextId,
      relayDevices, attachRelay, applyRoster, executeCommand, roster, relay: relayInstance,
      queue, index, current,
      playing: shownPlaying, position: shownPosition, duration: shownDuration, volume: shownVolume, error,
      playQueue, toggle, next, previous, seek, setVolume, skipTo,
      clearError: () => setError(null),
    }),
    // eslint-disable-next-line
    [device, setDevice, adoptActive, nowPlaying, external, patchQueue, contextId,
     relayDevices, attachRelay, applyRoster, executeCommand, roster, relayInstance, queue, index, current,
     shownPlaying, shownPosition, shownDuration, shownVolume, error, playQueue, toggle, next,
     previous, seek, setVolume, skipTo]
  );
}
