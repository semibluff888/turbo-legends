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
  it is the canonical source for protocol v2 names and validation.
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
| State delivery | Direct object reads | Full JSON snapshots at 20 Hz |
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
| `src/track/*` | Spline, Track projection/surfaces, and three authored track definitions |
| `src/game/kart.js` | Complete Kart state and controls shape |
| `src/game/physics.js` | Kart motion, drift, surfaces, status timers, collisions, drafting |
| `src/game/items.js` | Item boxes, roulette, projectiles, hazards, and item VFX |
| `src/game/ai.js` | `AiDriver`, which writes controls and AI speed pacing only |
| `src/game/race-simulation.js` | Generic eight-kart authoritative race pipeline |
| `src/game/race.js` | Backward-compatible single-player `RaceDirector` adapter |
| `src/session/local-race-session.js` | Presentation-facing wrapper for local races |
| `src/net/protocol.js` | Shared protocol v2 constants and client-message validation |
| `src/net/online-client.js` | Browser transport, lobby subscription, room commands, credentials, and reconnect loop |
| `src/net/online-race-session.js` | Snapshot mirror, input sampling, prediction, and correction |
| `server/room-manager.js` | Room lifecycle, scheduler, authoritative input and snapshot flow |
| `server/websocket-game-server.js` | Upgrade/origin checks, connection limits, routing, and heartbeat |
| `server/race-factory.js` | Builds a Track and `RaceSimulation` for an online room |
| `src/render/*` | Three.js scene, track/kart visuals, particles, and camera |
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

The roster must contain exactly eight unique characters. Each entry contains:

```js
{
  participantId,
  displayName,
  characterId,
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

It keeps the player in the final grid slot, fills the other seven slots with
distinct AI characters, exposes `player`, and supports deterministic `reset()`.
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
  case-sensitive 4–20 character password; only a salted scrypt digest is kept.
- A room accepts humans only while in `waiting` and below its own capacity.
  Reserved reconnect seats count toward the displayed occupancy and capacity.
- Nicknames are 1–20 visible characters, may repeat, and reject control or
  bidirectional formatting characters. `participantId` is the only identity
  used for host permissions, reconnects, input ownership, and results.
- Human character selections are unique. AI fills unused characters until the
  race has eight karts.
- The first member is host. If the host disconnects or leaves, ownership moves
  to the earliest joined connected, non-abandoned member.
- Only the host can change track/difficulty or start the room. A character change
  clears that member's ready flag; a room-setting change clears all ready flags.
- Starting requires at least two members, with every member connected and ready.
  The room then locks against new joins and sends `prepare_race`.
- Clients build the track/roster and answer `race_loaded`. The loading deadline
  is 10 seconds; unready clients use takeover AI. Fewer than two connected,
  loaded humans cancels the launch and resets the room to `waiting`.
- A disconnect immediately enables takeover AI and opens a 30-second resume
  window. A successful resume restores human control. An explicit leave during
  a race abandons the session and cannot be resumed; its AI finishes the race.
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

## Protocol v2

The WebSocket endpoint is `/ws`. Every application message is a JSON object
with `v: 2` and a `type`. Unknown fields in client messages are discarded by the
shared validator.

Client → server:

```text
enter_lobby, create_room, join_room, quick_match, resume,
select_character, set_room, set_ready,
start_race, race_loaded, input,
return_room, leave_room, ping
```

Server → client:

```text
welcome, lobby_state, room_state, prepare_race,
snapshot, race_events, race_results,
error, pong
```

`lobby_state` contains public-safe summaries for both public and private rooms:
room code/name/type, password requirement, occupied/capacity counts, host display
name, status, and whether the room is joinable. It never contains member IDs,
resume tokens, passwords, or password digests. `create_room` supplies room
name/type/capacity and an optional private-room password; `join_room` supplies
the password only when needed.

The authoritative driving message is:

```js
{
  type: 'input',
  v: 2,
  raceId,
  seq,
  useItemSeq,
  throttle, // clamped 0..1
  brake,    // clamped 0..1
  steer,    // clamped -1..1
  drift,
  lookBack,
}
```

Movement `seq` and item `useItemSeq` are monotonic and handled independently.
Stale movement can be discarded without losing a newer item edge. Each
participant's snapshot contains `ack`/`inputAck` for the last applied movement
sequence plus `receivedInputSeq` and `receivedUseItemSeq` cursors. Catch-up
clients use those received cursors to continue above the server's high-water
marks instead of restarting either counter at zero.

Snapshots contain the race clock/state, standings order, all Kart fields needed
by presentation, projectiles, hazards, and item-box activity. They are complete
replacement state and may be skipped under backpressure. `race_events` carries
globally increasing event IDs and is not intentionally skipped.

`welcome` returns opaque `participantId` and `resumeToken` credentials after a
room action. The browser keeps them only in memory and automatically retries
with delays of 250, 500, 1,000, 2,000, and 4,000 ms within the 30-second resume
window. Refreshing or opening another tab does not transfer those credentials.
For a mounted race, a resumed `prepare_race` reuses the existing race session so
its input cursors and event-deduplication state remain continuous. Browser
offline/online events detach the stale socket and resume directly; independently,
the race session freezes prediction after 15 unacknowledged 60 Hz inputs and
waits for a fresh authoritative snapshot. Realtime input also observes a small
WebSocket `bufferedAmount` high-water mark, preventing a stalled LAN connection
from flushing enough queued controls to trigger the message-rate limit.

## WebSocket safety and health

- Upgrade requests must target `/ws` and include an allowed browser Origin.
  Same-origin HTTP/HTTPS is accepted; `ALLOWED_ORIGINS` adds explicit origins.
- Client messages are limited to 16 KiB and 90 messages per second per
  connection.
- Create/join/quick-match/resume attempts are limited to 20 per IP per minute
  by default. Wrong private-room passwords consume the same budget.
- Binary client messages are rejected. Per-message compression is disabled.
- Ping/pong heartbeat runs every 15 seconds and terminates dead sockets.
- A snapshot is skipped when buffered output exceeds 256 KiB. Connections are
  closed as too slow when buffered output exceeds 1 MiB.
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
locates the corresponding lobby row and requests a password when required.

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
```

The Node test suite covers:

- spline/track geometry and surfaces;
- physics, items, AI, full deterministic local races, and multiplayer
  `RaceSimulation` controller/RNG behavior;
- the shared protocol validator;
- room creation, permissions, loading, input ordering, takeover/reconnect,
  results, expiry, and scheduler behavior;
- WebSocket origin, limits, routing, and combined game-server health behavior;
- local/online session contracts, prediction/correction, event deduplication,
  reconnect transport, menus, settings, input, and audio.

`npm run check` imports every browser module under Node with the repository's
presentation stubs and fails on syntax or import-contract errors.
