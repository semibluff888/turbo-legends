# Turbo Legends — Architecture & Contracts

Turbo Legends has two race modes sharing one presentation stack:

```text
Single-player browser                     Online room
─────────────────────                     ───────────
LocalRaceSession                          OnlineRaceSession
        │                                         │ inputs / snapshots
RaceDirector adapter                      native browser WebSocket
        │                                         │ /ws
RaceSimulation                            Node RoomManager
                                                  │
                                          RaceSimulation
```

The browser has no frontend build step. `server.mjs` serves the vendored browser
assets and hosts the authoritative WebSocket service in the same Node process.

The prime directive remains: simulation and presentation do not mix.
`src/core`, `src/track`, and `src/game` are pure JavaScript with no DOM or
Three.js dependency. Rendering, UI, audio, and input consume Kart-shaped state
but do not decide authoritative physics, items, laps, ranks, or results.

## Runtime boundaries

- `server.mjs` is the production/development entry point. It combines the HTTP
  static server, `GET /healthz`, `/ws`, the room manager, and the 60 Hz room
  scheduler.
- Only `index.html`, `src/`, `vendor/`, and `sound/` are publicly served.
  `server/`, tests, repository metadata, and design documents are not browser
  assets.
- `server/` owns process-memory rooms, WebSocket connections, authoritative
  race scheduling, snapshots, event delivery, and cleanup.
- `src/net/protocol.js` is browser-safe and imported by both client and server;
  it is the canonical source for protocol v4 JSON message names and validation.
  `src/net/binary-race-codec.js` is the shared zero-dependency binary race codec.
- Rooms are local to one Node process. There is no database, durable result
  store, account system, or cross-process room migration.

Run with Node 18 or newer:

```bash
npm install
npm start
```

Configuration:

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | HTTP/WebSocket listen address |
| `PORT` | `5173` | Shared HTTP/WebSocket port |
| `ALLOWED_ORIGINS` | empty | Comma-separated extra origins accepted by `/ws`; same-origin is always accepted |

Public deployments must provide TLS and forward WebSocket Upgrade requests for
`/ws`. Browser clients automatically choose `ws://` or `wss://` from the page
URL.

## Simulation conventions

- Coordinates use the XZ ground plane with +Y up. Yaw is
  `atan2(dx, dz)`, so forward is `(sin(yaw), 0, cos(yaw))` and right is
  `(cos(yaw), 0, -sin(yaw))`.
- Physics uses `FIXED_DT = 1/120` seconds.
- Track space uses wrapped arc length `s` and signed `lateral`, positive to the
  right of travel.
- Race progress is the signed accumulated arc distance `_traveled`. Grid slots
  begin slightly behind zero; a kart finishes when
  `_traveled >= laps * track.length`.
- Simulation code never calls `Math.random()`. All gameplay randomness comes
  from `Rng` or a named stream derived by `deriveRng(seed, namespace)`.
- `Kart.isPlayer` is presentation-only. Controller ownership and AI pacing use
  explicit roster/controller metadata.
- Kart gameplay events are append-only during a simulation step. The browser
  clears local events after presentation consumes them; the server numbers and
  broadcasts online events before clearing them.

## Timing and authority

| Concern | Single-player | Online |
|---|---|---|
| Authority | Browser `RaceSimulation` | Node `RaceSimulation` |
| Physics | 120 Hz fixed-step accumulator | Two 120 Hz steps per 60 Hz network tick |
| Human input | Read locally each frame | Sent at up to 60 Hz with sequence numbers |
| State delivery | Direct object reads | Full binary snapshots at 20 Hz |
| Events | Kart/ItemSystem queues | Numbered `race_events`, deduplicated client-side |
| Pause | Stops local simulation | Local overlay; server continues and receives neutral controls |

`RoomManager` caps one wall-clock delta at 250 ms and performs at most eight
catch-up network ticks per scheduler pass. This bounds spiral-of-death behavior.
Each network tick applies the latest input twice at 1/120 second; a pending item
press is true only on the first of those two steps.

`OnlineRaceSession` mirrors authoritative snapshots into Kart objects used by
the existing renderer and HUD:

- Remote karts blend from their displayed motion to the latest snapshot over
  100 ms, using shortest-path yaw interpolation. Respawns and errors over four
  metres snap immediately.
- The local kart predicts only `stepKartPhysics`. On an acknowledged snapshot,
  it restores the authoritative state, drops acknowledged commands, replays
  unacknowledged 60 Hz inputs as two 120 Hz steps each, then smooths small
  display corrections over 100 ms.
- Collisions, item outcomes, ranks, lap state, results, projectiles, hazards,
  and item-box activity are never client-authoritative.
- Event IDs are remembered in a bounded 1,024-entry deduplication window.

## Module map and ownership

| Path | Responsibility |
|---|---|
| `src/core/constants.js` | Shared tuning and enums |
| `src/core/mathx.js` | Pure math helpers |
| `src/core/rng.js` | Seeded RNG plus named child-stream derivation |
| `src/track/*` | Spline, Track projection/surfaces, and four authored track definitions |
| `src/game/kart.js` | Complete Kart state and controls shape |
| `src/game/characters.js` | Stable eight-Racer catalog, six-playable allowlist, locked prototypes, and safe fallback |
| `src/game/appearance.js` | Paint/avatar catalogs plus loadout defaults and sanitization |
| `src/game/physics.js` | Kart motion, drift, surfaces, status timers, collisions, drafting |
| `src/game/items.js` | Item boxes, roulette, projectiles, hazards, and item VFX |
| `src/game/ai.js` | `AiDriver`, which writes controls and AI speed pacing only |
| `src/game/race-simulation.js` | Generic eight-kart authoritative race pipeline |
| `src/game/race.js` | Backward-compatible single-player `RaceDirector` adapter |
| `src/session/local-race-session.js` | Presentation-facing wrapper for local races |
| `src/net/protocol.js` | Shared protocol v4 JSON constants, limits, errors, and client-message validation |
| `src/net/binary-race-codec.js` | Shared little-endian snapshot/input codec and strict wire validation |
| `src/net/online-client.js` | Browser transport, lobby subscription, room commands, credentials, and reconnect loop |
| `src/net/online-race-session.js` | Snapshot mirror, input sampling, prediction, and correction |
| `src/net/online-race-loader.js` | Cancellable shader compilation and first-frame warmup barrier |
| `server/room-manager.js` | Room lifecycle, scheduler, authoritative input and snapshot flow |
| `server/websocket-game-server.js` | Upgrade/origin checks, connection limits, routing, and heartbeat |
| `server/race-factory.js` | Builds a Track and `RaceSimulation` for an online room |
| `src/render/racer-model-builders.js` | Shared procedural bodies for the six available Racers; reused by production and Demo |
| `src/render/racer-models.js` | Normalizes shared bodies into the live wheel/effect/material/disposal contract |
| `src/render/*` | Three.js scene, track/kart visuals, particles, showroom, and camera |
| `src/ui/*` | Menus, multiplayer lobby/room views, HUD, settings, and local/online results |
| `src/audio/*` | WebAudio gameplay/UI SFX and local MP3 background music |
| `src/input/*` | Keyboard, gamepad, and touch controls |
| `src/main.js` | Browser boot, mode routing, session mounting, and presentation loop |
| `server.mjs` | Combined HTTP/WebSocket process entry point |

## Core race contracts

### Track and Kart

`Track` remains the only owner of spline projection, road widths, boost pads,
item-box positions, grid slots, and respawn points. Key methods are
`sampleWorld`, `toWorld`, `halfWidthAt`, `racingLineLateral`, `gridSlot`, and
`respawnPoint`.

`Kart` is the shared simulation/presentation state shape. In addition to motion,
drift, status, item, lap, and rank fields, multiplayer supplies:

```js
kart.participantId
kart.displayName
kart.controllerKind // 'human' | 'ai' | 'takeover-ai'
```

Only the local browser mirror sets `isPlayer = true`. The authoritative server
does not use it to choose controls or AI behavior.

### Physics and items

```js
stepKartPhysics(kart, track, dt)
resolveKartCollisions(karts, dt)
updateDrafting(karts, dt)

new ItemSystem(track, rng)
items.update(dt, karts, raceTime)
items.drainVfx()
```

`ItemSystem` owns rising-edge detection for `kart.controls.useItem`, roulette
outcomes, item-box state, projectiles, hazards, and item VFX. Physics owns kart
motion and status progression, including Bullet movement after the item system
enters the Bullet state.

### RaceSimulation

```js
new RaceSimulation(track, {
  roster,
  difficulty,
  laps,
  seed,
  mode: 'online',
});

simulation.update(dt, controlsByKartIndex);
simulation.setController(kartIndex, controllerKind);
```

The roster contains two to eight unique participant identities. Multiple human
or AI seats may use the same racer; `characterId` selects stats, while paint and
avatar fields are cosmetic. Only the six IDs in `PLAYABLE_CHARACTERS` are valid
for simulation; the two locked prototype IDs are rejected before Kart creation:

```js
{
  participantId,
  displayName,
  characterId,
  paintId,
  avatarId,
  controllerKind, // 'human' | 'ai' | 'takeover-ai'
}
```

Roster array order is authoritative kart/grid order and must remain stable after
it is announced to clients. `shuffleRosterForGrid(roster, seed)` returns a
copied, deterministically shuffled roster before kart indices are assigned.

Public race data includes `track`, `roster`, `karts`, `items`, `standings`,
`controllerKinds`, `state`, `countdown`, `elapsed`, `laps`, and `isRaceOver`.
The authoritative state machine uses only `countdown`, `racing`, and `results`;
one human finishing does not create a global intermediate state.

Every seat gets an independent `AiDriver` at construction, including human
seats. `setController` switches ownership without replacing the Kart or driver:

- `human`: consume `controlsByKartIndex[index]`.
- `ai`: regular AI with difficulty pacing and gap-based rubber-banding.
- `takeover-ai`: disconnected/input-timeout AI with difficulty base pace but no
  gap-based catch-up bonus.

Regular online AI uses the median progress of current human-controlled seats as
its pacing reference. Random streams are isolated into roster/grid, item, and
per-participant AI namespaces, so activating takeover AI cannot consume the item
stream or another driver's random sequence.

### RaceDirector and the session interface

`RaceDirector` extends `RaceSimulation` as the compatibility adapter for the
original local API:

```js
new RaceDirector(track, {
  playerCharacterId,
  difficulty,
  laps,
  seed,
  autopilot,
});

director.update(dt, playerControls);
```

It keeps the player in the final grid slot, fills the other seven slots by
deterministically cycling the six available Racers, applies the selected Racer's
default cosmetic loadout, and gives each AI a slot-seeded paint/avatar pair. It
exposes `player` and supports deterministic `reset()`.
`autopilot: true` is used by headless full-race tests.

Presentation code receives either `LocalRaceSession` or `OnlineRaceSession`
with the common shape:

```js
{
  kind, track, karts, player, items,
  state, countdown, elapsed, laps, standings, isRaceOver,
  update(dt, controls),
  dispose(),
}
```

Local sessions additionally expose `reset()`.

## Room lifecycle and rules

```text
waiting → loading → countdown → racing → results → waiting
```

- Room codes are six characters from an alphabet that omits `I`, `L`, `O`,
  `0`, and `1`. Codes are case-insensitive.
- Rooms have an immutable display name, `public` or `private` type, and a human
  capacity from two to eight. AI still fills every race to eight karts.
- Both room types appear in the multiplayer lobby. Private rooms require a
  case-sensitive 3–20 character password; only a salted scrypt digest is kept.
- A room accepts humans only while in `waiting` and below its own capacity.
  Reserved reconnect seats count toward the displayed occupancy and capacity.
- Nicknames are 1–20 visible characters, may repeat, and reject control or
  bidirectional formatting characters. `participantId` is the only identity
  used for host permissions, reconnects, input ownership, and results.
- Human racer, paint, and avatar selections may repeat. Locked prototype IDs are
  rejected with `character_locked`. AI prefers unused available Racers for visual
  variety, then deterministically cycles the six-Racer playable catalog.
- The first member is host. If the host disconnects or leaves, ownership moves
  to the earliest joined connected, non-abandoned member.
- Only the host can change track/difficulty or start the room. Any player loadout
  change clears that member's ready flag; a room-setting change clears all ready flags.
- Starting requires at least two members, with every member connected and ready.
  The room then locks against new joins and sends `prepare_race`.
- Clients build the track/roster, compile shaders, pre-render one frame, and
  answer `race_loaded`. The server replies with `race_loaded_ack` before launch
  or snapshot delivery. The loading deadline is 10 seconds; at least two loaded
  humans start while unready seats use takeover AI. A late client may load during
  countdown/racing, receives an ACK, and reclaims its seat only after a newer
  movement sequence. Fewer than two loaded humans cancels the launch and resets
  the room to `waiting`.
- A disconnect immediately enables takeover AI and opens a 30-second resume
  window. A successful resume keeps takeover AI active until the first newer
  movement input arrives. An explicit leave during a race abandons the session
  and cannot be resumed; its AI finishes the race.
- The browser also arms its own 30-second Room reconnect watchdog, so a retry
  socket stuck while offline still expires locally. During a mounted online race,
  expiry shows a blocking confirmation before the client destroys the race and
  returns to the Lobby.
- Each `room_state` member exposes an additive `presenceState` value:
  `connected`, `reconnecting`, `disconnected`, or `left`. Presence changes use
  the existing event-driven room broadcast and are not repeated in 20 Hz race snapshots.
- A connected participant that sends no accepted input for 1.5 seconds is also
  temporarily switched to takeover AI. A newer valid input restores control.
- Every player can return from results independently. Returned players may change
  character, ready up, and, if host, change room settings while remaining players
  are shown as `IN GAME`; starting stays disabled until everyone returns. Results
  return globally after the last connected player returns or after 30 seconds.
  Disconnected or abandoned members are removed then.
- A room with no connected members is hidden from the lobby and expires after
  60 seconds. Connected waiting rooms remain available without an inactivity
  timeout.
- The server publishes full lobby directory snapshots after room visibility,
  occupancy, host, or status changes. Quick match atomically chooses an available
  public waiting room and never creates a room implicitly.

## Protocol v4

The WebSocket endpoint is `/ws`. Lobby, room, authentication, event, result,
telemetry, and error messages remain JSON objects with `v: 4` and a `type`.
Unknown fields in JSON client messages are discarded by the shared validator.
Race snapshots and race inputs use binary codec revision 1 instead.

Client → server:

```text
enter_lobby, create_room, join_room, quick_match, resume,
select_character, set_loadout, set_room, set_ready,
start_race, race_loaded, input,
return_room, leave_room, ping
```

Server → client:

```text
welcome, lobby_state, room_state, prepare_race,
race_loaded_ack, snapshot, race_events, race_results,
kicked, error, pong, server_stats
```

In those lists, `input` and `snapshot` are logical message types rather than
JSON frames. The binary preamble is little-endian and contains `TLG4`, codec
revision, packet type, and a `uint16` total length. `prepare_race` remains JSON
and announces both the business `raceId` and a nonzero `wireRaceId: uint32`.

`lobby_state` contains public-safe summaries for both public and private rooms:
room code/name/type, selected track, password requirement, occupied/capacity counts,
host display name, status, and whether the room is joinable. It never contains member IDs,
resume tokens, passwords, or password digests. `create_room` supplies room
name/type/capacity/track and an optional private-room password; `join_room` supplies
the password only when needed.

The authoritative driving packet is exactly 28 bytes:

```js
{
  type: 'input',
  v: 4,
  wireRaceId,
  seq,
  useItemSeq,
  throttle, // uint16 normalized 0..1
  brake,    // uint16 normalized 0..1
  steer,    // int16 normalized -1..1
  drift,
  lookBack,
}
```

Movement `seq` and item `useItemSeq` are monotonic and handled independently.
Stale movement can be discarded without losing a newer item edge. Clients do
not send normal race input until the matching `race_loaded_ack`. Every shared
snapshot contains `acks: [[kartIndex, inputSeq, useItemSeq], ...]` for real room
members only; AI-only seats do not consume ACK bytes.

Each room writes one shared immutable 20 Hz binary snapshot and sends the same
packet to all room connections. It is a complete replacement state containing
the race header, up to eight fixed kart records, bounded projectile/hazard
sections, item-box activity/timers, and human ACKs. Float32 carries world and
unbounded values, normalized Int16 carries angles, millisecond Uint16/Uint32
fields carry timers, and stable Uint8 tables carry item/controller/surface/state
enums. Static roster identity/appearance and `lapTimes` remain in
`prepare_race` or results.

Snapshots are complete replacement state and may be skipped when a socket's
buffer exceeds `max(16 KiB, 2 * snapshotBytes)`. Events, results, and
room state are not intentionally skipped. Any connection above 512 KiB total
output backlog is closed. `race_events` carries globally increasing event IDs.

A v3 JSON message receives a terminal `client_update_required` error and close
code `4006`. A v4 browser treats that close code, a damaged binary packet, or a
missing `wireRaceId` as terminal and presents a refresh action without entering
the normal reconnect loop.

`welcome` returns opaque `participantId` and `resumeToken` credentials after a
room action. The browser keeps them only in memory and automatically retries
with delays of 250, 500, 1,000, 2,000, and 4,000 ms within the 30-second resume
window. Refreshing or opening another tab does not transfer those credentials.

## WebSocket safety and health

- Upgrade requests must target `/ws` and include an allowed browser Origin.
  Same-origin HTTP/HTTPS is accepted; `ALLOWED_ORIGINS` adds explicit origins.
- Client frames are limited to 2 KiB and use per-connection message and byte
  token buckets: 120 messages/second with a burst of 180, plus 64 KiB/second
  with a 128 KiB burst.
- Create/join/quick-match/resume attempts are limited to 20 per IP per minute
  by default. Wrong private-room passwords consume the same budget.
- Binary client frames are accepted only when they are valid fixed 28-byte v4
  race inputs. Other binary frames close the connection. Per-message
  compression is disabled.
- Ping/pong heartbeat runs every 15 seconds and terminates dead sockets.
- A complete snapshot may be skipped above its dynamic backpressure threshold.
  Connections are closed as too slow when buffered output exceeds 512 KiB.
- Browsers stop writing race inputs when their WebSocket send buffer exceeds
  4 KiB. Remote karts render from a 100 ms tick buffer with at most 100 ms of
  extrapolation; larger gaps recover through a smooth transition.
- `GET /healthz` returns process uptime plus aggregate room, race, and connection
  counts. It never includes room codes, nicknames, participant IDs, or tokens.

## Browser flow

`src/main.js` routes title, local selection, multiplayer lobby/room, race, pause,
settings/help, and result modes. Both race types are mounted through the common
session interface, then share Track/Kart visuals, Effects, camera, HUD, and audio.

`OnlineClient` owns transport and room commands; `online-screens.js` owns DOM
lobby/room/result views. Entering multiplayer keeps one WebSocket subscribed to
`lobby_state`; create, join, and quick match reuse it. Leaving a room returns the
same connection to lobby subscription, while an active room reconnect uses the
in-memory participant credentials. `prepare_race` builds the Track and
`OnlineRaceSession`, then the client sends `race_loaded`. A `?room=CODE` query
automatically joins an available public room or requests a private-room password;
failed invitations fall back to the Lobby. Successful room entry synchronizes the
query string, and leaving the room clears it.

The first multiplayer visit selects a name from a bundled racing nickname list.
Valid edited names are kept in `localStorage`; names may repeat and are never
used as identifiers. Active room credentials are never written to browser
storage, and obsolete v1/v2 session records are removed on client startup.

Online pause and `visibilitychange` set neutral controls but continue session
updates, snapshot processing, rendering, and server time. Local pause stops the
local simulation.

## Testing

```bash
npm test
npm run check
npm run smoke:multiplayer
npm run ab:multiplayer-phase2
```

The Node test suite covers:

- spline/track geometry and surfaces;
- physics, items, AI, full deterministic local races, and multiplayer
  `RaceSimulation` controller/RNG behavior;
- the shared JSON validator plus binary golden bytes, round trips, boundaries,
  corruption rejection, v3 termination, and v4 recovery ordering;
- room creation, permissions, loading, input ordering, takeover/reconnect,
  results, expiry, and scheduler behavior;
- WebSocket origin, limits, routing, and combined game-server health behavior;
- local/online session contracts, prediction/correction, event deduplication,
  reconnect transport, menus, settings, input, and audio.

`npm run check` imports every browser module under Node with the repository's
presentation stubs and fails on syntax or import-contract errors.
