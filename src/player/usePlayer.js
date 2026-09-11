import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The local device is always present and is not discovered over mDNS. Named
// for the runtime: the desktop app IS the computer, the PWA is one web player
// among possibly several (the relay numbers those for the OTHER clients).
const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
export const LOCAL_DEVICE = {
  id: 'local',
  kind: 'local',
  name: IS_DESKTOP ? 'This Computer' : 'This Web Player',
  model: IS_DESKTOP ? 'Local playback' : 'Browser playback',
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

// Fisher-Yates, non-mutating.
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  // Spotify-style modes. repeat: 'off' | 'all' | 'one'. shuffle: 'off' | 'on' |
  // 'smart' (smart = keep going past the queue with similar songs).
  const [repeat, setRepeat] = useState('off');
  const [shuffle, setShuffle] = useState('off');
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
  const previousRef = useRef(() => {});
  const setRepeatModeRef = useRef(() => {});
  const setShuffleModeRef = useRef(() => {});
  const activePlayerRef = useRef(null); // clientId of the active player, if not us
  const rosterRef = useRef({ players: [], lanDevices: [] });
  const repeatRef = useRef('off');
  const shuffleRef = useRef('off');
  // The queue in its original (unshuffled) order, so turning shuffle off can
  // restore it instead of leaving the tracks scrambled.
  const originalQueueRef = useRef([]);
  const advanceRef = useRef(() => {});
  // Which track (id) the current device actually has loaded. A queue restored
  // from the last run is shown paused with NOTHING loaded yet; the first play
  // must (re)start the stream at the saved position instead of resuming a
  // stream that does not exist.
  const loadedRef = useRef(null);
  const restoredRef = useRef(false);

  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
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
  const applyRoster = useCallback((r) => { rosterRef.current = r; setRoster(r); }, []);

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
      loadedRef.current = track.Id;
      jf.reportStart(track.Id);
    },
    [jf, metaFor, remote, volume]
  );

  const stopOn = useCallback(
    async (dev) => {
      if (!dev) return;
      loadedRef.current = null;
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
      // With shuffle on, keep the chosen track first and scramble the rest.
      originalQueueRef.current = tracks;
      let order = tracks;
      let start = startIndex;
      if (shuffleRef.current !== 'off' && tracks.length > 1) {
        const chosen = tracks[startIndex];
        order = [chosen, ...shuffled(tracks.filter((_, i) => i !== startIndex))];
        start = 0;
      }
      setQueue(order);
      setIndex(start);
      queueRef.current = order;
      indexRef.current = start;
      const track = order[start];
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
      if (nextIndex < 0) nextIndex = 0; // "previous" on the first track restarts it
      if (nextIndex >= q.length) {
        // Ran out: park on the last track at 0:00, paused. The footer keeps
        // showing it (play restarts it) instead of going blank.
        await stopOn(deviceRef.current);
        setPlaying(false);
        const last = q.length - 1;
        setIndex(last); indexRef.current = last;
        anchorAt(0, false);
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

  // Smart shuffle: the queue ran out, so extend it with songs similar to the
  // current track (a Jellyfin instant mix) and keep playing.
  const smartNext = useCallback(async () => {
    const cur = queueRef.current[indexRef.current];
    if (!cur || !jf) return skipTo(queueRef.current.length);
    try {
      const q = new URLSearchParams({ userId: jf.userId, Limit: '25', Fields: 'ArtistItems,AlbumArtists,UserData' });
      const data = await jf._fetch(`/Items/${cur.Id}/InstantMix?${q}`);
      const have = new Set(queueRef.current.map((t) => t.Id));
      let pick = (data.Items || []).filter((t) => !have.has(t.Id));
      if (!pick.length) pick = (data.Items || []).filter((t) => t.Id !== cur.Id);
      if (!pick.length) return skipTo(queueRef.current.length);
      const merged = [...queueRef.current, ...pick];
      setQueue(merged); queueRef.current = merged;
      await skipTo(indexRef.current + 1);
    } catch {
      await skipTo(queueRef.current.length);
    }
  }, [jf, skipTo]);

  // Advance the queue. `auto` is true for a track that ended on its own (vs. a
  // manual skip). At the end of the queue, honour repeat / smart shuffle instead
  // of just stopping.
  const advance = useCallback(async (auto = false) => {
    const q = queueRef.current;
    const i = indexRef.current;
    if (auto && repeatRef.current === 'one') return skipTo(i); // replay the track
    if (i + 1 < q.length) return skipTo(i + 1);
    // Nothing left.
    if (repeatRef.current === 'all') return skipTo(0);
    if (repeatRef.current === 'one') return skipTo(i);
    if (shuffleRef.current === 'smart') return smartNext();
    return skipTo(q.length); // falls into the stop branch
  }, [skipTo, smartNext]);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  const next = useCallback(() => advanceRef.current(false), []);
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
      // Nothing loaded on this device for the shown track (a queue restored
      // from the last run, or a device that was stopped): start it here at the
      // remembered playhead rather than resuming a stream that is not there.
      if (!playing && current && loadedRef.current !== current.Id) {
        relayRef.current?.claim();
        await startOn(dev, current, positionRef.current);
        anchorAt(positionRef.current, true);
        setPlaying(true);
        return;
      }
      if (!playing) relayRef.current?.claim();
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
  }, [anchorAt, current, external, playing, remote, startOn]);

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

  // Re-order the queue for a shuffle change, keeping the current track playing.
  const applyShuffleOrder = useCallback((mode) => {
    const q = queueRef.current;
    const cur = q[indexRef.current] || null;
    if (mode !== 'off') {
      if (shuffleRef.current === 'off') originalQueueRef.current = q; // remember the real order
      if (cur && q.length > 1) {
        const order = [cur, ...shuffled(q.filter((t) => t.Id !== cur.Id))];
        setQueue(order); queueRef.current = order;
        setIndex(0); indexRef.current = 0;
      }
    } else {
      const orig = originalQueueRef.current.length ? originalQueueRef.current : q;
      const pos = cur ? Math.max(0, orig.findIndex((t) => t.Id === cur.Id)) : indexRef.current;
      setQueue(orig); queueRef.current = orig;
      setIndex(pos); indexRef.current = pos;
    }
  }, []);

  const setShuffleMode = useCallback((mode) => {
    applyShuffleOrder(mode); shuffleRef.current = mode; setShuffle(mode);
  }, [applyShuffleOrder]);
  const setRepeatMode = useCallback((mode) => { repeatRef.current = mode; setRepeat(mode); }, []);

  // Spotify-style cycling toggles. When another client owns the session, route
  // the change to it so the mode lives with the actual playback -- and base the
  // next mode on the mode currently SHOWN (mirrored from the active player), not
  // our stale local ref, or a controller would send the same value forever and
  // could never toggle back off.
  const activeMode = (field) => {
    const act = activePlayerRef.current;
    if (act) return (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying?.[field] || 'off';
    return field === 'shuffle' ? shuffleRef.current : repeatRef.current;
  };
  const cycleShuffle = useCallback(() => {
    const nextMode = { off: 'on', on: 'smart', smart: 'off' }[activeMode('shuffle')] || 'on';
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'setShuffle', mode: nextMode }); return; }
    setShuffleMode(nextMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setShuffleMode]);
  const cycleRepeat = useCallback(() => {
    const nextMode = { off: 'all', all: 'one', one: 'off' }[activeMode('repeat')] || 'all';
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'setRepeat', mode: nextMode }); return; }
    setRepeatMode(nextMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRepeatMode]);

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
      // A queue restored from the last run and still paused is not "our own
      // playback" -- a speaker that kept playing after the app closed wins.
      const ownPlayback = queueRef.current.length && (anchorRef.current.playing || loadedRef.current);
      if (ownPlayback) {
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
      if (queueRef.current.length && (anchorRef.current.playing || loadedRef.current)) return null;
      adoptedRef.current = true;
      // Drop the restored paused queue: the house is playing something else.
      setQueue([]); setIndex(-1); queueRef.current = []; indexRef.current = -1;
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

      // Picking another of my clients: hand the active session to it. The
      // target must BECOME the active player (claim), resume the CURRENT track
      // at the CURRENT position, and this client must stop + mirror. A plain
      // 'play' command would loop: the target still sees THIS client as active
      // and would route the command straight back, restarting the song here at
      // 0:00 (the exact bug this replaces).
      if (nextDevice.kind === 'relay' && relayRef.current) {
        const act = activePlayerRef.current;
        let itemId = null;
        let pos = 0;
        let wasPlaying = true;
        if (act) {
          // We are mirroring another session: hand off THAT session's track.
          const np = (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying;
          if (np) {
            itemId = np.itemId;
            pos = np.playing ? (np.position || 0) + (Date.now() - (np.at || Date.now())) / 1000 : (np.position || 0);
            wasPlaying = np.playing !== false;
          }
        } else {
          // We are the active player: hand off our own current track + playhead.
          const cur = queueRef.current[indexRef.current];
          const a = anchorRef.current;
          if (cur) {
            itemId = cur.Id;
            pos = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;
            wasPlaying = playing;
          }
        }
        relayRef.current.command(nextDevice.relayClientId, {
          action: 'transfer', trackIds: itemId ? [itemId] : [], index: 0, position: pos, playing: wasPlaying,
        });
        // Stop our own local playback right away so the two clients never overlap
        // while the target spins up. The target's claim also yields us as a
        // backstop, and the roster update then flips us into the mirror + green
        // bar.
        if (!act) {
          const dev = deviceRef.current;
          if (dev.kind === 'local') { const el = audioRef.current; if (el) el.pause(); }
          else if (dev.kind !== 'relay' && remote) remote.stop(dev).catch(() => {});
          setPlaying(false);
          anchorRef.current = { pos: positionRef.current, at: Date.now(), playing: false };
        }
        return;
      }

      // Transferring away from a remote active session onto THIS device (local
      // or a speaker): take over playback of that session's current track here.
      const act = activePlayerRef.current;
      if (act) {
        const np = (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying;
        setDeviceState(nextDevice); deviceRef.current = nextDevice;
        // Become the active player immediately -- unconditionally, so taking
        // over never silently fails just because the track can't be resumed.
        relayRef.current?.claim();
        activePlayerRef.current = null;
        if (np?.itemId && jf) {
          try {
            const q = new URLSearchParams({ Ids: np.itemId, userId: jf.userId, Fields: 'MediaSources,ArtistItems,AlbumArtists,UserData' });
            const data = await jf._fetch(`/Items?${q}`);
            const t = (data.Items || [])[0];
            if (t) {
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
      if (deviceRef.current.kind === 'local') advanceRef.current(true);
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
          advanceRef.current(true);
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

  // --- remember what was playing across app restarts ---------------------

  // Restore the last run's queue, track, playhead and modes, shown PAUSED. The
  // player never opens on "Nothing playing": whatever you closed on is right
  // there to resume, like Spotify. Nothing is loaded on a device until play.
  useEffect(() => {
    if (!jf || restoredRef.current) return;
    restoredRef.current = true;
    if (queueRef.current.length) return; // something already started (e.g. a transfer)
    const saved = jf.persisted('playback');
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return;
    const head = jf.persisted('playhead') || {};
    // Prefer the track id over the index: a fallback save may have kept only
    // the current track, in which case the index no longer applies.
    let i = saved.queue.findIndex((t) => t?.Id === head.trackId);
    if (i < 0) i = Math.min(Math.max(0, head.index | 0), saved.queue.length - 1);
    const track = saved.queue[i];
    if (!track?.Id) return;
    setQueue(saved.queue); queueRef.current = saved.queue;
    setIndex(i); indexRef.current = i;
    originalQueueRef.current = Array.isArray(saved.original) && saved.original.length ? saved.original : saved.queue;
    setContextId(saved.contextId || null);
    const rep = ['off', 'all', 'one'].includes(head.repeat) ? head.repeat : 'off';
    const shf = ['off', 'on', 'smart'].includes(head.shuffle) ? head.shuffle : 'off';
    repeatRef.current = rep; setRepeat(rep);
    shuffleRef.current = shf; setShuffle(shf);
    const dur = ticksToSeconds(track.RunTimeTicks);
    setDuration(dur);
    const pos = Number.isFinite(head.position) ? Math.max(0, Math.min(head.position, dur || head.position)) : 0;
    anchorAt(pos, false);
    setPlaying(false);
  }, [jf, anchorAt]);

  // Two keys: the queue (big, written only when it changes) and the playhead
  // (tiny, written on a slow tick, on pause and on close). Stringifying a
  // 2000-track playlist every few seconds is not free, so it is not done.
  const saveQueue = useCallback(() => {
    if (!jf) return;
    const q = queueRef.current;
    const i = indexRef.current;
    if (!q.length || i < 0 || !q[i]) return;
    const key = `${jf._lsPrefix}playback`;
    const write = (queue, original) => {
      localStorage.setItem(key, JSON.stringify({ queue, original, contextId }));
    };
    try {
      write(q, shuffleRef.current !== 'off' ? originalQueueRef.current : []);
    } catch {
      // Too big for localStorage: keep at least the current track.
      try { write([q[i]], []); } catch { /* private mode / no storage */ }
    }
  }, [jf, contextId]);
  const savePlayhead = useCallback(() => {
    if (!jf) return;
    const q = queueRef.current;
    const i = indexRef.current;
    if (!q.length || i < 0 || !q[i]) return;
    const a = anchorRef.current;
    const pos = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;
    try {
      localStorage.setItem(`${jf._lsPrefix}playhead`, JSON.stringify({
        trackId: q[i].Id, index: i, position: Math.max(0, pos),
        repeat: repeatRef.current, shuffle: shuffleRef.current,
      }));
    } catch { /* ignore */ }
  }, [jf]);
  const saveQueueRef = useRef(saveQueue);
  const savePlayheadRef = useRef(savePlayhead);
  useEffect(() => { saveQueueRef.current = saveQueue; }, [saveQueue]);
  useEffect(() => { savePlayheadRef.current = savePlayhead; }, [savePlayhead]);

  useEffect(() => {
    if (!jf || !current) return;
    saveQueueRef.current();
  }, [jf, current, queue, contextId, shuffle]);

  useEffect(() => {
    if (!jf || !current) return;
    savePlayheadRef.current();
  }, [jf, current, index, repeat, shuffle, playing]);

  useEffect(() => {
    if (!jf || !current || !playing) return undefined;
    const t = setInterval(() => savePlayheadRef.current(), 5000);
    return () => clearInterval(t);
  }, [jf, current, playing]);

  useEffect(() => {
    const flush = () => savePlayheadRef.current();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

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
  // A mirrored track's art is resolved by ID through THIS client's own Jellyfin
  // base URL + token. The active player's ready-made artUrl is only a fallback:
  // it is built for ITS origin (the browser's same-origin /jf proxy, or the
  // desktop's LAN address) and does not load from the other runtime -- that
  // was the missing cover on the desktop while a web player was the master.
  const nowPlaying = activePlayer
    ? (relayTarget ? {
        title: relayTarget.title,
        artist: relayTarget.artist,
        artId: relayTarget.albumId || relayTarget.itemId || null,
        artUrl: relayTarget.artUrl || null,
        albumId: relayTarget.albumId || null,
        artistId: relayTarget.artistId || null,
        itemId: relayTarget.itemId || null,
        liked: Boolean(relayTarget.liked),
      } : null)
    : current
    ? {
        title: current.Name,
        artist: current.Artists?.join(', ') || current.AlbumArtist || '',
        artId: current.AlbumId || current.Id,
        itemId: current.Id,
        liked: Boolean(current.UserData?.IsFavorite),
        albumId: current.AlbumId || null,
        // ArtistItems carries the real artist entity; AlbumArtists is the
        // fallback for tracks credited only at album level.
        artistId: current.ArtistItems?.[0]?.Id || current.AlbumArtists?.[0]?.Id || null,
      }
    : external
    ? { title: external.title, artist: external.artist || '', artId: null }
    : null;

  // The Jellyfin item id of whatever is playing session-wide, so views like
  // lyrics work on a mirroring client (where `current` is null) too.
  const nowPlayingId = relayTarget?.itemId || current?.Id || null;

  // Take over as the active player and resume a handed-off track locally at the
  // given position. Bypasses playQueue's active-player routing on purpose: when
  // a transfer arrives, THIS client is not yet the active player (the sender
  // still is), so playQueue would route the command straight back. We claim
  // first, then play here directly.
  const startHere = useCallback(async (tracks, startIndex, position, shouldPlay) => {
    relayRef.current?.claim();
    activePlayerRef.current = null;
    setError(null);
    setExternal(null);
    setContextId(null);
    setQueue(tracks);
    setIndex(startIndex);
    queueRef.current = tracks;
    indexRef.current = startIndex;
    const track = tracks[startIndex];
    setDuration(ticksToSeconds(track?.RunTimeTicks));
    anchorAt(position, shouldPlay);
    try {
      if (shouldPlay) {
        await startOn(deviceRef.current, track, position);
        setPlaying(true);
      }
    } catch (e) {
      setError(e.message);
      setPlaying(false);
    }
  }, [anchorAt, startOn]);
  const startHereRef = useRef(startHere);
  useEffect(() => { startHereRef.current = startHere; }, [startHere]);

  // Run a command another client routed to us.
  const executeCommand = useCallback(async (cmd) => {
    if (!cmd) return;
    if (cmd.action === 'transfer' && jf) {
      // Another client handed the active session to us. Claim immediately so we
      // stop routing controls away, then resume the track at its playhead.
      relayRef.current?.claim();
      activePlayerRef.current = null;
      if (Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
        try {
          const q = new URLSearchParams({ Ids: cmd.trackIds.join(','), userId: jf.userId, Fields: 'MediaSources,ArtistItems,AlbumArtists,UserData' });
          const data = await jf._fetch(`/Items?${q}`);
          const byId = new Map((data.Items || []).map((t) => [t.Id, t]));
          const tracks = cmd.trackIds.map((id) => byId.get(id)).filter(Boolean);
          if (tracks.length) startHereRef.current(tracks, cmd.index || 0, cmd.position || 0, cmd.playing !== false);
        } catch { /* ignore */ }
      }
    } else if (cmd.action === 'play' && jf && Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
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
    else if (cmd.action === 'next') { advanceRef.current(false); }
    else if (cmd.action === 'previous') { previousRef.current(); }
    else if (cmd.action === 'setRepeat') { setRepeatModeRef.current(cmd.mode || 'off'); }
    else if (cmd.action === 'setShuffle') { setShuffleModeRef.current(cmd.mode || 'off'); }
    else if (cmd.action === 'yield') { yieldRef.current(); }
    else if (cmd.action === 'patchLiked' && cmd.itemId) {
      // A controller liked/unliked the session track: update our queue so the
      // next now-playing broadcast carries the new heart to every mirror.
      const liked = Boolean(cmd.liked);
      setQueue((q) => {
        const n = q.map((t) => (t.Id === cmd.itemId ? { ...t, UserData: { ...(t.UserData || {}), IsFavorite: liked } } : t));
        queueRef.current = n; return n;
      });
    }
  }, [jf]);

  const patchQueue = useCallback((fn) => {
    setQueue((q) => { const n = q.map(fn); queueRef.current = n; return n; });
  }, []);

  // Liked state changed here: if another client owns the session, tell it, so
  // its queue (the source of the mirrored heart) agrees with what we just did.
  const syncLiked = useCallback((itemId, liked) => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) relayRef.current.command(act, { action: 'patchLiked', itemId, liked });
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
  useEffect(() => { previousRef.current = previous; }, [previous]);
  useEffect(() => { setRepeatModeRef.current = setRepeatMode; }, [setRepeatMode]);
  useEffect(() => { setShuffleModeRef.current = setShuffleMode; }, [setShuffleMode]);
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
      albumId: current.AlbumId || null,
      artistId: current.ArtistItems?.[0]?.Id || current.AlbumArtists?.[0]?.Id || null,
      liked: Boolean(current.UserData?.IsFavorite),
      playing, position, duration, volume, repeat, shuffle, at: Date.now(),
    } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, playing, Math.floor(position), duration, volume, repeat, shuffle, relayTarget]);

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
  const shownRepeat = relayTarget ? (relayTarget.repeat || 'off') : repeat;
  const shownShuffle = relayTarget ? (relayTarget.shuffle || 'off') : shuffle;

  return useMemo(
    () => ({
      device, setDevice, adoptActive, nowPlaying, nowPlayingId, external, patchQueue, syncLiked, contextId,
      relayDevices, attachRelay, applyRoster, executeCommand, roster, relay: relayInstance,
      queue, index, current,
      playing: shownPlaying, position: shownPosition, duration: shownDuration, volume: shownVolume, error,
      repeat: shownRepeat, shuffle: shownShuffle, cycleRepeat, cycleShuffle,
      playQueue, toggle, next, previous, seek, setVolume, skipTo,
      clearError: () => setError(null),
    }),
    // eslint-disable-next-line
    [device, setDevice, adoptActive, nowPlaying, nowPlayingId, external, patchQueue, syncLiked, contextId,
     relayDevices, attachRelay, applyRoster, executeCommand, roster, relayInstance, queue, index, current,
     shownPlaying, shownPosition, shownDuration, shownVolume, error, shownRepeat, shownShuffle,
     cycleRepeat, cycleShuffle, playQueue, toggle, next,
     previous, seek, setVolume, skipTo]
  );
}
