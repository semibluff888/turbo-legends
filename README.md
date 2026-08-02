# 🏎️ Turbo Legends

A Mario Kart-style 3D kart racer with single-player and server-authoritative
online rooms. The browser has no build step: Three.js is vendored, visuals and
SFX are procedural, and the Node process serves both the game and WebSocket
multiplayer.

![genre](https://img.shields.io/badge/genre-kart%20racer-ff5fa2) ![node](https://img.shields.io/badge/node-%3E%3D18-4aa8ff) ![multiplayer](https://img.shields.io/badge/multiplayer-WebSocket-36d6a0)

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open `http://127.0.0.1:5173/`. ES modules require an HTTP origin, so opening
`index.html` directly from disk will not work. To test multiplayer, open the
page in two browser windows, create a room from the multiplayer lobby in one,
and join it from the room list in the other.

For other devices on the same LAN, listen on all interfaces and open the host
machine's LAN address (for example, `http://192.168.1.20:5173/`):

```powershell
$env:HOST = '0.0.0.0'
npm start
```

```bash
HOST=0.0.0.0 npm start
```

The process also exposes `GET /healthz` with uptime, room, race, and connection
counts.

## Multiplayer

- A live multiplayer lobby lists public and password-protected private rooms,
  with search, direct joining, invite codes, and quick match for available
  public rooms.
- Rooms choose a 2–8 human-player capacity; AI fills every race to eight karts.
  Full rooms and rooms already in a race remain visible but cannot be joined.
- Room names may repeat. Private rooms require a case-sensitive 3–20 character
  password, stored by the server only as a salted scrypt digest.
- The host chooses the track and AI difficulty. Every connected player must be
  ready before the host can start.
- Nicknames are display-only and may repeat. A racing-themed nickname is chosen
  on first use and can be edited in the lobby; participant IDs remain the sole
  identity for permissions, reconnects, input, and results. Players may select
  the same Racer and independently choose one of 12 paints and 8 animal avatars.
- The Room shows the local choice as a rotating 3D kart; the customization dialog
  previews Racer stats, paint, and avatar before saving the complete loadout.
- Single-player keeps its Racer-only selection flow: the chosen Racer receives
  its default appearance automatically, while AI paint and avatars are randomized.
- Changing any loadout field clears that player's ready state; changing track or
  difficulty clears everyone's ready state.
- Starting a race creates a seeded grid and a 10-second loading phase. If fewer
  than two connected players finish loading, the race is cancelled.
- The Node server owns physics, items, laps, ranks, and results. Browsers send
  inputs and locally smooth/predict presentation.
- A disconnected kart is immediately driven by takeover AI. The same live page
  can reclaim it with its in-memory session token for 30 seconds; takeover AI
  remains active until the resumed page sends a fresh movement input. The earliest
  joined connected player becomes host when needed.
- Online input uses client-side send-buffer backpressure, while remote racers use
  buffered snapshot interpolation so temporary Wi-Fi stalls do not replay stale
  controls or force ordinary movement corrections to teleport.
- Every player can return from results independently and prepare for the next
  race while remaining players are shown as `IN GAME`. The room becomes fully
  startable after everyone returns, or automatically after 30 seconds. Rooms
  with no connected players are hidden and expire after 60 seconds.
- Leaving a room or an online race returns to the multiplayer lobby. The online
  results screen only offers `RETURN TO ROOM`.

Rooms, reconnect tokens, and results are process-memory state. Restarting the
server clears them; v2 does not include accounts, persistent results, chat, or
cross-process room migration.

Invite links may include `?room=ROOMCODE`. Public rooms are joined automatically,
while private rooms ask for a password. Missing, full, and racing rooms report an
error and fall back to the lobby. Creating, joining, or resuming a room keeps its
code in the address bar; leaving clears it. Passwords are never placed in URLs or
browser storage. The browser stores only the nickname in `localStorage`;
`participantId` and `resumeToken` remain in memory and legacy v1/v2 session
records are purged.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | ← → / A D | Left stick |
| Accelerate | ↑ / W | A or RT |
| Brake / reverse | ↓ / S | B or LT |
| Hop / drift | Space / Shift | X or RB |
| Use item | Ctrl / E | Y or LB |
| Look back | R | — |
| Live standings | Hold Tab | — |
| Pause | Esc | Start |
| Mute | M | — |

Touch devices get on-screen controls automatically (auto-gas, steer zone on
the left, drift/item buttons on the right). Holding Tab shows live position,
lap, and racer status without pausing. In online races, pause is a local overlay:
the server race continues while the client sends neutral controls.

## The game

- **8 racers** with real stat trade-offs (speed / accel / handling / weight)
- **3 tracks** — Sunset Circuit, Harbor Loop, Summit Raceway — with boost
  pads, item box rows, kerbs, elevation, and themed scenery
- **Drift & mini-turbo** — hop into a slide, hold it through the corner,
  release for blue → orange → purple tier boosts
- **10 items** — bananas, green/red/blue shells, mushrooms, bob-omb, star,
  lightning, Bullet autopilot — dealt by race position
- **AI drivers** with personalities, racing-line pursuit, mistakes,
  rubber-banding, item tactics, and disconnected-player takeover
- **3 difficulty levels**, rocket starts, jump-start penalties, drafting,
  lap timing, wrong-way detection, minimap, and results podium
- **Dynamic audio** — procedural WebAudio engines, skids and item SFX plus
  looping menu/track-specific MP3 soundtracks

## Server configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP/WebSocket listen address |
| `PORT` | `5173` | HTTP/WebSocket listen port |
| `ALLOWED_ORIGINS` | empty | Comma-separated extra WebSocket origins; same-origin is always accepted |

The multiplayer endpoint is `/ws` and automatically uses `wss://` when the
page is served over HTTPS. For public deployment, terminate TLS in the hosting
platform or reverse proxy and ensure WebSocket Upgrade requests for `/ws` are
forwarded to this process.

Protocol v2 is JSON. The shared message names, validators, limits, room states,
and error codes are defined in `src/net/protocol.js`.

## Development

```bash
npm test         # Node test discovery: simulation, protocol, server, and UI contracts
npm run check    # import every browser module under Node (syntax/contract check)
```

The authoritative simulation (`src/core`, `src/track`, `src/game`) is pure
JavaScript with no DOM or Three.js dependency. Local and online races expose a
common presentation-facing session shape, so rendering, HUD, audio, and input
do not need to know where the authoritative state lives. See
`ARCHITECTURE.md` for the module and protocol contracts.

All characters and tracks are original. The *genre* is a homage; the content
is ours.
