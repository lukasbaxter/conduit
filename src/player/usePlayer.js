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
  const c = (track?.MediaSources?.[0]?.Container || track?.Container || '').toLowerCase();
  return c.split(',')[0] || 'mp3';
}

function mimeOf(track) {
  return MIME_BY_CONTAINER[containerOf(track)] || 'audio/mpeg';
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

  const audioRef = useRef(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
  }

  // Mirrors of state that async callbacks and intervals need to read without
  // being re-created on every tick.
  const deviceRef = useRef(device);
  const positionRef = useRef(0);
  const queueRef = useRef([]);
  const indexRef = useRef(-1);

  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { indexRef.current = index; }, [index]);

  const current = index >= 0 ? queue[index] || null : null;
  const remote = typeof window !== 'undefined' ? window.conduit?.remote : null;

  const metaFor = useCallback(
    (track) => ({
      title: track.Name || 'Unknown title',
      artist: track.Artists?.join(', ') || track.AlbumArtist || '',
      album: track.Album || '',
      artwork: jf?.imageUrl(track.AlbumId || track.Id, { maxHeight: 600 }) || undefined,
      contentType: mimeOf(track),
    }),
    [jf]
  );

  // --- low-level per-transport operations ---------------------------------

  const startOn = useCallback(
    async (dev, track, seekSeconds = 0) => {
      if (!jf || !track) return;
      const url = jf.streamUrl(track.Id);
      if (dev.kind === 'local') {
        const el = audioRef.current;
        el.src = url;
        el.volume = volume / 100;
        if (seekSeconds > 0) {
          // currentTime only sticks once the browser knows the duration.
          el.addEventListener('loadedmetadata', () => { el.currentTime = seekSeconds; }, { once: true });
        }
        await el.play();
      } else {
        await remote.play(dev, url, metaFor(track));
        if (seekSeconds > 0) {
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
      } else {
        await remote.stop(dev).catch(() => {});
      }
    },
    [remote]
  );

  // --- public controls ----------------------------------------------------

  const playQueue = useCallback(
    async (tracks, startIndex = 0) => {
      setError(null);
      setQueue(tracks);
      setIndex(startIndex);
      queueRef.current = tracks;
      indexRef.current = startIndex;
      const track = tracks[startIndex];
      setDuration(ticksToSeconds(track?.RunTimeTicks));
      setPosition(0);
      try {
        await startOn(deviceRef.current, track, 0);
        setPlaying(true);
      } catch (e) {
        setError(e.message);
        setPlaying(false);
      }
    },
    [startOn]
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
      setPosition(0);
      try {
        await startOn(deviceRef.current, track, 0);
        setPlaying(true);
      } catch (e) {
        setError(e.message);
      }
    },
    [startOn, stopOn]
  );

  const next = useCallback(() => skipTo(indexRef.current + 1), [skipTo]);
  const previous = useCallback(() => {
    // Match the usual convention: restart the track unless we are near its start.
    if (positionRef.current > 3) return skipTo(indexRef.current);
    return skipTo(indexRef.current - 1);
  }, [skipTo]);

  const toggle = useCallback(async () => {
    const dev = deviceRef.current;
    if (!current) return;
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
      setPlaying(!playing);
    } catch (e) {
      setError(e.message);
    }
  }, [current, playing, remote]);

  const seek = useCallback(
    async (seconds) => {
      const dev = deviceRef.current;
      setPosition(seconds);
      try {
        if (dev.kind === 'local') audioRef.current.currentTime = seconds;
        else await remote.seek(dev, seconds);
      } catch (e) {
        setError(e.message);
      }
    },
    [remote]
  );

  const setVolume = useCallback(
    async (level) => {
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

  /** Move playback to another device, preserving track and position. */
  const setDevice = useCallback(
    async (nextDevice) => {
      const prev = deviceRef.current;
      if (prev.id === nextDevice.id) return;
      const track = queueRef.current[indexRef.current] || null;
      const at = positionRef.current;
      const wasPlaying = playing;

      setDeviceState(nextDevice);
      deviceRef.current = nextDevice;
      setError(null);

      try {
        await stopOn(prev);
        if (track && wasPlaying) {
          await startOn(nextDevice, track, at);
          setPlaying(true);
        }
      } catch (e) {
        setError(`Could not move playback to ${nextDevice.name}: ${e.message}`);
        setPlaying(false);
      }
    },
    [playing, startOn, stopOn]
  );

  // --- progress tracking --------------------------------------------------

  // Local playback drives position from the audio element itself.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;
    const onTime = () => {
      if (deviceRef.current.kind === 'local') setPosition(el.currentTime);
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

  // Remote devices have to be polled; they do not push state to us.
  useEffect(() => {
    if (device.kind === 'local' || !remote) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const s = await remote.status(device);
        if (cancelled || !s) return;
        setPosition(s.position || 0);
        if (s.duration) setDuration(s.duration);
        setPlaying(Boolean(s.playing));
        // A remote track that ran to completion should advance the queue.
        if (!s.playing && s.duration > 0 && s.position >= s.duration - 1.5) next();
      } catch {
        // Transient network blips are expected; keep polling.
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [device, next, remote]);

  // Report progress back to Jellyfin so play counts and resume work.
  useEffect(() => {
    if (!jf || !current) return undefined;
    const timer = setInterval(() => {
      jf.reportProgress(current.Id, positionRef.current, !playing);
    }, 10000);
    return () => clearInterval(timer);
  }, [jf, current, playing]);

  return useMemo(
    () => ({
      device, setDevice,
      queue, index, current,
      playing, position, duration, volume, error,
      playQueue, toggle, next, previous, seek, setVolume, skipTo,
      clearError: () => setError(null),
    }),
    [device, setDevice, queue, index, current, playing, position, duration, volume,
     error, playQueue, toggle, next, previous, seek, setVolume, skipTo]
  );
}
