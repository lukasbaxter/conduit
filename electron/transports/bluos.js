'use strict';
// BluOS transport (Bluesound Node / Pulse / Powernode).
//
// BluOS exposes a plain, undocumented-but-stable HTTP API on :11000 that returns
// XML. There is no auth. The player fetches the stream URL itself, so the URL we
// hand it must be reachable from the device, not just from this app -- that means
// a LAN address for Jellyfin, never localhost.

const http = require('http');

function request(host, port, path, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`BluOS ${path} -> HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`BluOS ${path} timed out`)));
    req.on('error', reject);
  });
}

// BluOS drops the connection while it changes streams, surfacing as
// "socket hang up". Retrying a READ is free. Retrying a control command is not:
// BluOS hangs up *during* a seek, so a retry fires /Play?seek= a second time,
// the duplicate lands mid-transition, and the stream dies with the playhead
// frozen at 0. Verified: raw curl seeks fine, the retry is what broke it.
// So only idempotent reads are ever retried.
const RETRYABLE = /^\/(Status|SyncStatus)\b/;

async function requestRetry(host, port, path, timeoutMs = 6000) {
  try {
    return await request(host, port, path, timeoutMs);
  } catch (err) {
    const transient = /hang up|ECONNRESET|EPIPE|socket/i.test(err.message);
    if (!transient || !RETRYABLE.test(path)) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return request(host, port, path, timeoutMs);
  }
}

// The XML is shallow and predictable, so a tag scrape beats pulling in a parser.
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

class BluOSTransport {
  constructor(device) {
    this.device = device;
  }

  _get(path) {
    return requestRetry(this.device.host, this.device.port, path);
  }

  /**
   * Block until the player has the stream genuinely open and seekable.
   *
   * Seeking too early does not merely fail -- it tears the stream down and
   * leaves BluOS reporting playing=true with the position frozen at 0 and no
   * audio coming out. A fixed delay after /Play cannot work because stream
   * setup time varies with the source; the device has to be asked.
   */
  async waitUntilSeekable(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.status().catch(() => null);
      if (s && s.canSeek && (s.playing || s.position > 0)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /**
   * BluOS players can be joined into a sync group in the BluOS app. The group
   * plays as one: commands sent to any member drive every member, so listing
   * them as separate speakers is a lie -- picking either one starts both.
   *
   * The master carries group="A+B" plus a <slave> per member; each slave
   * carries <master>host</master>.
   */
  async syncInfo() {
    const xml = await this._get('/SyncStatus');
    const master = tag(xml, 'master');
    const group = xml.match(/\bgroup="([^"]*)"/i)?.[1] || null;
    const slaves = [...xml.matchAll(/<slave\s+id="([^"]+)"[^>]*name="([^"]*)"/gi)]
      .map((m) => ({ host: m[1], name: m[2].replace(/&amp;/g, '&') }));
    return {
      isSlave: Boolean(master),
      masterHost: master || null,
      groupName: group ? group.replace(/&amp;/g, '&') : null,
      slaves,
    };
  }

  async identify() {
    const xml = await this._get('/SyncStatus');
    return {
      name: tag(xml, 'name') || this.device.name,
      model: xml.match(/model="([^"]*)"/i)?.[1] || null,
      brand: xml.match(/brand="([^"]*)"/i)?.[1] || null,
    };
  }

  /**
   * Firmware that mishandles metadata on /Play?url=.
   *
   * Measured on a Bluesound N125 running BluOS 4.12.11: passing title1/title2
   * alongside the URL renders the stream UNSEEKABLE, while canSeek still
   * reports 1. Seeking it then destroys the stream, leaving state=stream with
   * the playhead stuck at 0 and no audio. The identical call with a bare URL
   * seeks perfectly, and a Powernode on 4.16.22 is fine either way.
   *
   * Seeking matters more than the device's own display text -- our UI shows the
   * metadata regardless -- so on older firmware we send the URL alone.
   */
  static METADATA_SAFE_FROM = [4, 16];

  async _metadataIsSafe() {
    if (this._metaSafe !== undefined) return this._metaSafe;
    try {
      const xml = await this._get('/SyncStatus');
      // Two version attributes are present; the BluOS one is the dotted triple.
      const versions = [...xml.matchAll(/version="([0-9]+(?:\.[0-9]+)+)"/g)].map((m) => m[1]);
      const bluos = versions.find((v) => v.split('.').length >= 3) || versions[0];
      if (!bluos) { this._metaSafe = false; return false; }
      const [maj, min] = bluos.split('.').map(Number);
      const [reqMaj, reqMin] = BluOSTransport.METADATA_SAFE_FROM;
      this._metaSafe = maj > reqMaj || (maj === reqMaj && min >= reqMin);
    } catch {
      this._metaSafe = false; // when unsure, keep it seekable
    }
    return this._metaSafe;
  }

  // `url` must be absolute and LAN-reachable by the speaker itself.
  async play(url, meta = {}) {
    const q = new URLSearchParams({ url });
    if (await this._metadataIsSafe()) {
      // Shown in the BluOS app and on the device's display.
      if (meta.title) q.set('title1', meta.title);
      if (meta.artist) q.set('title2', meta.artist);
      if (meta.album) q.set('title3', meta.album);
      if (meta.artwork) q.set('image', meta.artwork);
    }
    return this._get(`/Play?${q.toString()}`);
  }

  resume() { return this._get('/Play'); }
  pause() { return this._get('/Pause'); }

  // /Stop alone flips the reported state immediately but the player can keep
  // sounding while it drains what it has already buffered off the network.
  // Pausing first halts output, and clearing the queue drops the stream so it
  // cannot resume, which is what makes a handoff sound clean.
  async stop() {
    await this._get('/Pause').catch(() => {});
    const res = await this._get('/Stop');
    await this._get('/Clear').catch(() => {});
    return res;
  }

  next() { return this._get('/Skip'); }
  previous() { return this._get('/Back'); }

  // BluOS volume is 0-100.
  setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    return this._get(`/Volume?level=${v}`);
  }

  // BluOS seeks fine when the stream advertises Content-Length + Accept-Ranges
  // (Jellyfin's static stream does, and canSeek comes back 1). It reports
  // canSeek=0 for a genuinely unseekable stream, and issuing /Play?seek= against
  // one of those does not merely fail -- it tears the stream down and leaves the
  // player stopped. So check first and let the caller fall back.
  async seek(seconds) {
    // Wait for readiness rather than trusting a timer.
    if (!(await this.waitUntilSeekable())) {
      const err = new Error('BluOS stream is not seekable yet');
      err.code = 'ENOSEEK';
      throw err;
    }
    const target = Math.max(0, Math.round(seconds));

    // BluOS routinely drops the connection WHILE performing the seek, so a
    // "socket hang up" here says nothing about whether the seek worked. Treat
    // the response as advisory and let the device's own position be the judge;
    // reporting failure caused the caller to re-play the track, which restarted
    // playback and sometimes killed the stream outright.
    await this._get(`/Play?seek=${target}`).catch((err) => {
      if (!/hang up|ECONNRESET|EPIPE|socket/i.test(err.message)) throw err;
    });

    // Give it a moment, then confirm against the playhead.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const after = await this.status().catch(() => null);
      if (!after) continue;
      if (Math.abs(after.position - target) <= 12) return after;
      // Still climbing toward it, or reporting the pre-seek spot; keep looking.
      if (after.position > target) return after;
    }

    const final = await this.status().catch(() => null);
    const err = new Error(
      `BluOS ignored seek (asked ${target}s, at ${final ? final.position : '?'}s)`
    );
    err.code = 'ESEEKDRIFT';
    throw err;
  }

  async status() {
    const xml = await this._get('/Status');
    const state = tag(xml, 'state');
    return {
      // BluOS reports "stream"/"play" while playing, "pause"/"stop" otherwise.
      playing: state === 'play' || state === 'stream',
      state,
      title: tag(xml, 'title1'),
      artist: tag(xml, 'title2'),
      album: tag(xml, 'title3'),
      volume: Number(tag(xml, 'volume') ?? 0),
      position: Number(tag(xml, 'secs') ?? 0),
      duration: Number(tag(xml, 'totlen') ?? 0),
      canSeek: tag(xml, 'canSeek') === '1',
      // BluOS reports <secs> as a whole number, so a reading of 90 means the
      // true position is somewhere in [90, 91). Taking it at face value leaves
      // us ~0.5s behind on average -- invisible on a progress bar, obvious when
      // it drives synced lyrics. Flagged so the player can de-bias it.
      coarsePosition: true,
      // The URL the device is pulling. It carries the Jellyfin item id, which
      // is how we recover full metadata for a session we did not start -- and
      // the only way on firmware where we must send a bare URL to keep seeking.
      streamUrl: tag(xml, 'streamUrl'),
    };
  }
}

module.exports = { BluOSTransport };
