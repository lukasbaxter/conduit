'use strict';
// Google Cast transport (Chromecast, Chromecast Audio, Google TV Streamer, Cast-
// enabled TVs).
//
// Uses the Default Media Receiver, so there is no registered Cast app id to
// obtain and no Google developer account needed. Like BluOS, the receiver pulls
// the stream itself, so URLs must be LAN-reachable from the device.

const { Client, DefaultMediaReceiver } = require('castv2-client');

const promisify = (fn, ctx) => (...args) =>
  new Promise((resolve, reject) => {
    fn.call(ctx, ...args, (err, result) => (err ? reject(err) : resolve(result)));
  });

class CastTransport {
  constructor(device) {
    this.device = device;
    this.client = null;
    this.player = null;
  }

  async _connect() {
    if (this.player) return this.player;

    const client = new Client();
    this.client = client;

    await new Promise((resolve, reject) => {
      const onError = (err) => { client.removeListener('error', onError); reject(err); };
      client.once('error', onError);
      client.connect(this.device.host, () => {
        client.removeListener('error', onError);
        resolve();
      });
    });

    // A dropped socket must clear cached state, otherwise the next play call
    // writes into a dead connection and hangs instead of reconnecting.
    client.on('error', () => this.close());
    client.on('close', () => { this.player = null; });

    this.player = await promisify(client.launch, client)(DefaultMediaReceiver);
    return this.player;
  }

  async play(url, meta = {}) {
    const player = await this._connect();
    const media = {
      contentId: url,
      contentType: meta.contentType || 'audio/mpeg',
      streamType: 'BUFFERED',
      metadata: {
        type: 0,
        metadataType: 3, // MusicTrackMediaMetadata
        title: meta.title || 'Unknown title',
        artist: meta.artist || '',
        albumName: meta.album || '',
        // The Default Media Receiver shows images[0] large on the TV. A second
        // entry gives it something if the first 404s.
        images: [meta.artwork, meta.artworkFallback].filter(Boolean).map((url) => ({ url })),
      },
    };
    const status = await promisify(player.load, player)(media, { autoplay: true });

    // A receiver that cannot actually play (TV off, Streamer in standby, media
    // unreachable from the device) still ACKS the load, then flips to
    // IDLE/ERROR a moment later. Without this check that reads as success and
    // the user gets silence with no explanation.
    const settled = await new Promise((resolve) => {
      const onStatus = (s) => {
        if (s.playerState === 'PLAYING' || s.playerState === 'BUFFERING') { done(s); }
        else if (s.playerState === 'IDLE' && s.idleReason === 'ERROR') { done(s); }
      };
      const done = (s) => { player.removeListener('status', onStatus); resolve(s); };
      player.on('status', onStatus);
      setTimeout(() => done(null), 6000);
    });
    if (settled && settled.playerState === 'IDLE' && settled.idleReason === 'ERROR') {
      const err = new Error(
        `${this.device.name} could not play this. If it drives a TV, check the TV is on.`
      );
      err.code = 'ECASTLOAD';
      throw err;
    }
    return settled || status;
  }

  async _withPlayer(method, ...args) {
    const player = await this._connect();
    return promisify(player[method], player)(...args);
  }

  resume() { return this._withPlayer('play'); }
  pause() { return this._withPlayer('pause'); }
  seek(seconds) { return this._withPlayer('seek', Math.max(0, Math.round(seconds))); }

  // Returning early when there is no cached player leaves a receiver playing
  // forever if the connection was dropped and re-established, so reconnect and
  // stop the running receiver rather than assuming it is already silent.
  async stop() {
    try {
      if (this.player) return await this._withPlayer('stop');
      await this._connect();
      return await this._withPlayer('stop');
    } catch (e) {
      // Last resort: tearing down the receiver session always silences it.
      try {
        if (this.client) await promisify(this.client.stop, this.client)(this.player);
      } catch (e2) { /* fall through to close */ }
      this.close();
      return null;
    }
  }

  // Volume lives on the receiver connection, not the media player.
  async setVolume(level) {
    await this._connect();
    const v = Math.max(0, Math.min(1, level / 100));
    return promisify(this.client.setVolume, this.client)({ level: v });
  }

  async status() {
    if (!this.player) return { playing: false, state: 'IDLE' };
    const s = await this._withPlayer('getStatus');
    if (!s) return { playing: false, state: 'IDLE' };
    const md = s.media?.metadata || {};
    return {
      playing: s.playerState === 'PLAYING',
      state: s.playerState,
      title: md.title || null,
      artist: md.artist || null,
      album: md.albumName || null,
      position: s.currentTime || 0,
      duration: s.media?.duration || 0,
      volume: Math.round((s.volume?.level ?? 0) * 100),
      streamUrl: s.media?.contentId || null,
    };
  }

  close() {
    this.player = null;
    if (this.client) {
      try { this.client.close(); } catch (e) { /* socket already gone */ }
      this.client = null;
    }
  }
}

module.exports = { CastTransport };
