# Conduit

A Jellyfin music client for macOS, Windows and Linux with a real device selector:
play on this computer, on any Google Cast device, or on any Bluesound/BluOS player
on the network, and move playback between them mid-track.

Built because no existing client covers that combination. Subsonic clients have no
device-handoff concept at all, Feishin has zero casting code, and Bluesound
deliberately supports neither Chromecast nor UPnP/DLNA, so it needs its own
transport.

## Status

Working: discovery, both transports, local playback, library browse, search,
instant mix, device handoff.

Not built yet: iOS and Android clients (blocked on developer accounts), queue
reordering, playlists, offline caching.

## How it works

Three transports behind one controller (`src/player/usePlayer.js`):

| Transport | Protocol | Notes |
|---|---|---|
| `local` | HTML5 `<audio>` | plays in the app window |
| `cast` | CASTV2 on :8009 | Default Media Receiver, no Cast app id needed |
| `bluos` | HTTP on :11000 | undocumented but stable XML API, no auth |

Switching device captures the position from the outgoing device, stops it, and
resumes on the incoming one at the same offset.

**Cast and BluOS devices fetch the audio themselves.** Stream URLs must therefore
be absolute and reachable *from the speaker*, carrying their own `api_key`. A
`localhost` address works in the app window and fails silently on the speaker.
This is why the login screen insists on a LAN address.

## Develop

```bash
npm install
npm run dev          # vite + electron with hot reload
```

Check discovery and both transports against real hardware without playing
anything:

```bash
node electron/selftest.js
```

## Build

Unsigned builds, so no Apple or Microsoft developer account is required.

```bash
npm run dist:mac     # dmg + zip
npm run dist:win     # nsis installer + portable exe
npm run dist:linux   # AppImage + deb
npm run dist         # all three
```

Unsigned apps need one extra step on first launch:

- **macOS** right-click the app and choose Open, or `xattr -dr com.apple.quarantine /Applications/Conduit.app`
- **Windows** SmartScreen shows "More info" then "Run anyway"
- **Linux** `chmod +x Conduit-*.AppImage`

## Known limits

- A Cast device that is asleep or off refuses the connection. It reappears in the
  picker when it wakes.
- BluOS has no push notifications, so remote state is polled every 2s. Position on
  a remote device can lag by up to that long.
- Some Cast receivers reject FLAC. `Jellyfin.transcodeUrl()` exists for a fallback
  but is not wired into the automatic path yet.
