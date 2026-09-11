// Minimal Jellyfin client, scoped to what a music app actually needs.
//
// Important: stream and artwork URLs are handed to Chromecast and BluOS devices,
// which fetch them over the network themselves. They must therefore be absolute
// LAN URLs carrying their own api_key -- a relative path or a localhost address
// works in the app window and fails silently on the speaker.

const CLIENT = 'Conduit';
const VERSION = '0.1.0';

function deviceId() {
  const KEY = 'conduit.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `conduit-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function authHeader(token) {
  const parts = [
    `Client="${CLIENT}"`,
    `Device="${navigator.platform || 'Desktop'}"`,
    `DeviceId="${deviceId()}"`,
    `Version="${VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

export class Jellyfin {
  constructor({ baseUrl, token = null, userId = null }) {
    // Trailing slashes produce double-slash URLs that some reverse proxies 404.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.userId = userId;
  }

  async _fetch(path, options = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(this.token),
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jellyfin ${res.status} on ${path}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }
    return res.status === 204 ? null : res.json();
  }

  static async login(baseUrl, username, password) {
    const client = new Jellyfin({ baseUrl });
    const data = await client._fetch('/Users/AuthenticateByName', {
      method: 'POST',
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    client.token = data.AccessToken;
    client.userId = data.User.Id;
    return client;
  }

  async publicInfo() {
    return this._fetch('/System/Info/Public');
  }

  // --- library ------------------------------------------------------------

  async albums({ limit = 500, startIndex = 0, search = null } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,ProductionYear,ChildCount',
      Limit: String(limit),
      StartIndex: String(startIndex),
      userId: this.userId,
    });
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  async artists({ limit = 500, startIndex = 0, search = null } = {}) {
    const q = new URLSearchParams({
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Limit: String(limit),
      StartIndex: String(startIndex),
      userId: this.userId,
    });
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Artists?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  async tracks({ albumId = null, artistId = null, limit = 500, search = null } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Fields: 'MediaSources,ParentId',
      SortBy: albumId ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName',
      Limit: String(limit),
      userId: this.userId,
    });
    if (albumId) q.set('ParentId', albumId);
    if (artistId) q.set('ArtistIds', artistId);
    if (search) q.set('searchTerm', search);
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  async search(term, limit = 40) {
    const [albums, artists, tracks] = await Promise.all([
      this.albums({ search: term, limit }),
      this.artists({ search: term, limit }),
      this.tracks({ search: term, limit }),
    ]);
    return { albums: albums.items, artists: artists.items, tracks: tracks.items };
  }

  // Jellyfin's own "more like this" -- no Last.fm key required.
  async instantMix(itemId, limit = 100) {
    const q = new URLSearchParams({ userId: this.userId, Limit: String(limit) });
    const data = await this._fetch(`/Items/${itemId}/InstantMix?${q}`);
    return data.Items || [];
  }

  // --- urls handed to remote devices --------------------------------------

  streamUrl(itemId, { container = null } = {}) {
    const q = new URLSearchParams({ static: 'true', api_key: this.token });
    if (container) q.set('container', container);
    return `${this.baseUrl}/Audio/${itemId}/stream?${q}`;
  }

  // Transcode to MP3 for receivers that will not take FLAC.
  transcodeUrl(itemId, { codec = 'mp3', bitrate = 320000 } = {}) {
    const q = new URLSearchParams({
      audioCodec: codec,
      audioBitRate: String(bitrate),
      api_key: this.token,
    });
    return `${this.baseUrl}/Audio/${itemId}/universal?${q}`;
  }

  imageUrl(itemId, { maxHeight = 480, tag = null } = {}) {
    if (!itemId) return null;
    const q = new URLSearchParams({ maxHeight: String(maxHeight), api_key: this.token });
    if (tag) q.set('tag', tag);
    return `${this.baseUrl}/Items/${itemId}/Images/Primary?${q}`;
  }

  // --- playback reporting -------------------------------------------------
  // Keeps "resume where you left off" and play counts working across clients.

  reportStart(itemId) {
    return this._fetch('/Sessions/Playing', {
      method: 'POST',
      body: JSON.stringify({ ItemId: itemId, PlayMethod: 'DirectStream' }),
    }).catch(() => null);
  }

  reportProgress(itemId, positionSeconds, isPaused = false) {
    return this._fetch('/Sessions/Playing/Progress', {
      method: 'POST',
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: Math.round(positionSeconds * 10_000_000),
        IsPaused: isPaused,
        PlayMethod: 'DirectStream',
      }),
    }).catch(() => null);
  }

  reportStop(itemId, positionSeconds) {
    return this._fetch('/Sessions/Playing/Stopped', {
      method: 'POST',
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: Math.round(positionSeconds * 10_000_000),
      }),
    }).catch(() => null);
  }
}

export function persistSession(session) {
  localStorage.setItem('conduit.session', JSON.stringify(session));
}

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('conduit.session') || 'null');
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem('conduit.session');
}
