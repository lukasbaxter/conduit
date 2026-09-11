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
    return request(this.device.host, this.device.port, path);
  }

  async identify() {
    const xml = await this._get('/SyncStatus');
    return {
      name: tag(xml, 'name') || this.device.name,
      model: xml.match(/model="([^"]*)"/i)?.[1] || null,
      brand: xml.match(/brand="([^"]*)"/i)?.[1] || null,
    };
  }

  // `url` must be absolute and LAN-reachable by the speaker itself.
  async play(url, meta = {}) {
    const q = new URLSearchParams({ url });
    // BluOS shows these in its own app and on the device display.
    if (meta.title) q.set('title1', meta.title);
    if (meta.artist) q.set('title2', meta.artist);
    if (meta.album) q.set('title3', meta.album);
    if (meta.artwork) q.set('image', meta.artwork);
    return this._get(`/Play?${q.toString()}`);
  }

  resume() { return this._get('/Play'); }
  pause() { return this._get('/Pause'); }
  stop() { return this._get('/Stop'); }
  next() { return this._get('/Skip'); }
  previous() { return this._get('/Back'); }

  // BluOS volume is 0-100.
  setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    return this._get(`/Volume?level=${v}`);
  }

  async seek(seconds) {
    return this._get(`/Play?seek=${Math.max(0, Math.round(seconds))}`);
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
    };
  }
}

module.exports = { BluOSTransport };
