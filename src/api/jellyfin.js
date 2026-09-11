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
    // Real machine name from the main process; navigator.platform is just
    // "MacIntel" and makes every Mac look identical in Jellyfin's session list.
    `Device="${(typeof window !== 'undefined' && window.conduit?.deviceName) || navigator.platform || 'Desktop'}"`,
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
    // Session cache for list reads. A click should never wait on a fetch for
    // something already shown once; mutations evict what they change.
    this._cache = new Map();
    this._lsPrefix = `conduit.cache.${this.userId || 'x'}.`;
  }

  // Read a persisted value written on a previous run (survives reload).
  persisted(key) {
    try {
      const raw = localStorage.getItem(this._lsPrefix + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  _persist(key, value) {
    try { localStorage.setItem(this._lsPrefix + key, JSON.stringify(value)); }
    catch { /* quota or private mode; the in-memory cache still works */ }
  }

  _cached(key, fn) {
    if (this._cache.has(key)) return Promise.resolve(this._cache.get(key));
    return fn().then((v) => { this._cache.set(key, v); return v; });
  }

  _evict(prefix) {
    for (const k of [...this._cache.keys()]) if (k.startsWith(prefix)) this._cache.delete(k);
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

  // The signed-in user's profile picture, if they set one in Jellyfin.
  userImageUrl() {
    const q = new URLSearchParams({ maxHeight: '96', api_key: this.token });
    return `${this.baseUrl}/Users/${this.userId}/Images/Primary?${q}`;
  }

  async me() {
    return this._fetch(`/Users/${this.userId}`);
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

  // Albums this user has played most recently -- feeds the home shortcuts and
  // the "Recently played" shelf, both of which Spotify drives from history.
  async recentlyPlayedAlbums({ limit = 8 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Filters: 'IsPlayed',
      Fields: 'ParentId',
      Limit: '200',
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    // Collapse tracks to their albums, keeping play order.
    const seen = new Set();
    const ids = [];
    for (const t of data.Items || []) {
      const id = t.AlbumId;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      if (ids.length >= limit) break;
    }
    if (!ids.length) return { items: [] };
    const q2 = new URLSearchParams({ Ids: ids.join(','), userId: this.userId, Fields: 'ProductionYear' });
    const d2 = await this._fetch(`/Items?${q2}`);
    const byId = new Map((d2.Items || []).map((a) => [a.Id, a]));
    return { items: ids.map((id) => byId.get(id)).filter(Boolean) };
  }

  async recentlyAddedAlbums({ limit = 8 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Fields: 'ProductionYear',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [] };
  }

  // Albums credited to an artist, newest first (Spotify's discography order).
  artistAlbums(artistId, opts = {}) {
    return this._cached(`artistAlbums:${artistId}`, () => this._artistAlbums(artistId, opts));
  }

  async _artistAlbums(artistId, { limit = 60 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'MusicAlbum',
      Recursive: 'true',
      AlbumArtistIds: artistId,
      SortBy: 'ProductionYear,SortName',
      SortOrder: 'Descending',
      Fields: 'ProductionYear,ChildCount',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  tracks(opts = {}) {
    // Searches are not cached; everything else keyed on its arguments.
    if (opts.search) return this._tracks(opts);
    return this._cached(`tracks:${opts.albumId || ''}:${opts.artistId || ''}:${opts.limit || 500}`, () => this._tracks(opts));
  }

  async _tracks({ albumId = null, artistId = null, limit = 500, search = null } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
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

  // Playlists the user actually made. "Your Library" shows only these.
  async playlists({ limit = 200 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Playlist',
      Recursive: 'true',
      SortBy: 'SortName',
      Fields: 'ChildCount',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    // Jellyfin imports stray .m3u/.info/.sfv files left behind by Soulseek rips
    // as empty playlists -- 86 of them in this library, things like "00.info".
    // Real playlists have contents, so ChildCount is the honest filter.
    const items = (data.Items || []).filter(
      (p) =>
        (p.ChildCount ?? 0) > 0 &&
        (!p.MediaType || p.MediaType === 'Audio' || p.MediaType === 'Unknown')
    );
    return { items, total: items.length };
  }

  playlistTracks(playlistId, opts = {}) {
    return this._cached(`playlist:${playlistId}`, () => this._playlistTracks(playlistId, opts));
  }

  async _playlistTracks(playlistId, { limit = 500 } = {}) {
    const q = new URLSearchParams({
      userId: this.userId,
      Limit: String(limit),
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
    });
    const data = await this._fetch(`/Playlists/${playlistId}/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  /**
   * Lyrics for a track. Jellyfin 10.9+ serves .lrc sidecars and embedded tags
   * here; this library has ~19,000 .lrc files, which is why filetote carries
   * them alongside the audio during the beets reorganise.
   * Returns [{start: seconds|null, text}] -- start is null for unsynced lyrics.
   */
  async lyrics(itemId) {
    const q = new URLSearchParams({ api_key: this.token });
    const res = await fetch(`${this.baseUrl}/Audio/${itemId}/Lyrics?${q}`, {
      headers: { Authorization: authHeader(this.token) },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.Lyrics || []).map((l) => ({
      start: l.Start != null ? l.Start / 10_000_000 : null,
      text: l.Text || '',
    }));
  }

  // Fetch a single item (album, artist, track) by id.
  itemById(id) {
    return this._cached(`item:${id}`, () => this._itemById(id));
  }

  async _itemById(id) {
    const q = new URLSearchParams({
      Ids: id,
      userId: this.userId,
      Fields: 'PrimaryImageAspectRatio,ProductionYear,ChildCount,Overview',
    });
    const data = await this._fetch(`/Items?${q}`);
    return (data.Items || [])[0] || null;
  }

  async search(term, limit = 40) {
    const [albums, artists, tracks, playlists] = await Promise.all([
      this.albums({ search: term, limit }),
      this.artists({ search: term, limit }),
      this.tracks({ search: term, limit }),
      this.playlists().then((p) => ({
        items: p.items.filter((x) => x.Name.toLowerCase().includes(term.toLowerCase())),
      })),
    ]);
    return { albums: albums.items, artists: artists.items, tracks: tracks.items, playlists: playlists.items };
  }

  // Jellyfin's own "more like this" -- no Last.fm key required.
  async instantMix(itemId, limit = 100) {
    const q = new URLSearchParams({ userId: this.userId, Limit: String(limit) });
    const data = await this._fetch(`/Items/${itemId}/InstantMix?${q}`);
    return data.Items || [];
  }

  // --- favourites ("Liked Songs") ----------------------------------------

  async setFavorite(itemId, liked) {
    this._evict('favorites:');
    // The track's UserData is embedded in every cached list that contains it.
    this._evict('tracks:'); this._evict('playlist:');
    return this._fetch(`/Users/${this.userId}/FavoriteItems/${itemId}`, {
      method: liked ? 'POST' : 'DELETE',
    });
  }

  // Newest likes first, which is how Spotify orders Liked Songs.
  favoriteTracks(opts = {}) {
    return this._cached(`favorites:${opts.limit || 500}`, () => this._favoriteTracks(opts));
  }

  async favoriteCount() {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio', Recursive: 'true', Filters: 'IsFavorite',
      Limit: '0', userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return data.TotalRecordCount ?? 0;
  }

  async _favoriteTracks({ limit = 500 } = {}) {
    const q = new URLSearchParams({
      IncludeItemTypes: 'Audio',
      Recursive: 'true',
      Filters: 'IsFavorite',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Fields: 'ParentId,ArtistItems,AlbumArtists,UserData',
      Limit: String(limit),
      userId: this.userId,
    });
    const data = await this._fetch(`/Items?${q}`);
    return { items: data.Items || [], total: data.TotalRecordCount ?? 0 };
  }

  // Container for one track, fetched lazily at play time so list fetches can
  // skip the heavy MediaSources field. Cached per id.
  async container(itemId) {
    return this._cached(`container:${itemId}`, async () => {
      const q = new URLSearchParams({ Ids: itemId, Fields: 'MediaSources', userId: this.userId });
      const d = await this._fetch(`/Items?${q}`);
      const c = d.Items?.[0]?.MediaSources?.[0]?.Container || '';
      return c.split(',')[0].toLowerCase();
    });
  }

  // --- playlist mutation ---------------------------------------------------

  async createPlaylist(name, itemIds = []) {
    return this._fetch('/Playlists', {
      method: 'POST',
      body: JSON.stringify({ Name: name, Ids: itemIds, UserId: this.userId, MediaType: 'Audio' }),
    });
  }

  async addToPlaylist(playlistId, itemIds) {
    this._evict(`playlist:${playlistId}`);
    const q = new URLSearchParams({ ids: itemIds.join(','), userId: this.userId });
    return this._fetch(`/Playlists/${playlistId}/Items?${q}`, { method: 'POST' });
  }

  // Jellyfin removes by the playlist ENTRY id (PlaylistItemId), not the track id,
  // so the same track added twice can be removed individually.
  async removeFromPlaylist(playlistId, entryIds) {
    this._evict(`playlist:${playlistId}`);
    const q = new URLSearchParams({ entryIds: entryIds.join(',') });
    return this._fetch(`/Playlists/${playlistId}/Items?${q}`, { method: 'DELETE' });
  }

  async movePlaylistItem(playlistId, entryId, newIndex) {
    this._evict(`playlist:${playlistId}`);
    return this._fetch(`/Playlists/${playlistId}/Items/${entryId}/Move/${newIndex}`, { method: 'POST' });
  }

  async deletePlaylist(playlistId) {
    this._evict(`playlist:${playlistId}`);
    return this._fetch(`/Items/${playlistId}`, { method: 'DELETE' });
  }

  async renamePlaylist(playlistId, name) {
    const item = await this._fetch(`/Users/${this.userId}/Items/${playlistId}`);
    return this._fetch(`/Items/${playlistId}`, {
      method: 'POST',
      body: JSON.stringify({ ...item, Name: name }),
    });
  }

  // --- urls handed to remote devices --------------------------------------

  /**
   * Always the static original file. Verified against Jellyfin 10.11 and a
   * Bluesound N125:
   *   - static=true returns Content-Length + Accept-Ranges, and BluOS then
   *     reports canSeek=1 and seeks natively via /Play?seek=N.
   *   - the transcoded offset stream is chunked with no Content-Length and
   *     Accept-Ranges: none, and BluOS SILENTLY REJECTS it -- the play command
   *     returns empty and the player never switches streams.
   * So offsets are applied as a seek after playback starts, never baked into
   * the URL. This also keeps playback bit-perfect instead of re-encoding.
   */
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
