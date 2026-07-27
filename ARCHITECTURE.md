# Turbo Kart — Architecture & Frozen Contracts

A Mario Kart-style 3D kart racer. Browser-only, no build step: ES modules +
vendored Three.js (`vendor/three.module.js`, import-mapped to `three`).
`node server.mjs` serves the folder; `node --test` runs headless sim tests
(bare `node --test tests/` breaks on Node ≥ 24 Windows — use default discovery).

**Prime directive: simulation and presentation never mix.**
Everything under `src/core`, `src/track`, `src/game` is pure JS (no THREE, no DOM)
and must run under Node. Everything under `src/render`, `src/ui`, `src/audio`,
`src/input` is presentation and may touch THREE/DOM/WebAudio.

## Conventions (frozen)

- Coordinates: XZ ground plane, +Y up. Yaw convention: `yaw = atan2(dx, dz)`,
  so `forward = (sin(yaw), 0, cos(yaw))`, `right = (cos(yaw), 0, -sin(yaw))`.
- Fixed timestep `FIXED_DT = 1/120` s; render interpolation is NOT used —
  120 Hz sim with a frame-clamped accumulator is smooth enough.
- All randomness through `Rng` (src/core/rng.js). Never `Math.random()` in sim code.
- All tuning through `src/core/constants.js`. No magic numbers in systems.
- Track space: `s` = arc length along spline (wraps at `track.length`),
  `lateral` = signed offset, positive = right of travel direction.
- Ranking: `kart.progress = (lap-1 adjusted) monotonic meters` — see race.js.
- Per-step gameplay events: `kart.emit(type, data)` → consumed by audio/VFX,
  cleared once per rendered frame by the main loop (NOT by systems).

## Module map & owners

| Path | Role | May import |
|---|---|---|
| src/core/constants.js | tuning, enums | (nothing) |
| src/core/mathx.js | pure math helpers | (nothing) |
| src/core/rng.js | seeded RNG | (nothing) |
| src/track/spline.js | ClosedSpline | mathx |
| src/track/track.js | Track (width/surface/pads/boxes/grid) | spline, constants, mathx |
| src/track/tracks.js | 3 track definitions (data) | (nothing) |
| src/game/kart.js | Kart state + controls shape | constants, mathx |
| src/game/characters.js | roster (data) | constants |
| src/game/physics.js | stepKartPhysics(kart, track, dt) + kart-kart collisions | constants, mathx |
| src/game/ai.js | AiDriver: fills kart.controls | constants, mathx, rng |
| src/game/items.js | ItemSystem: roulette, projectiles, hazards | constants, mathx, rng |
| src/game/race.js | RaceDirector: countdown/laps/rank/finish + owns systems above | everything in game/track/core |
| src/render/* | THREE scene, track mesh, kart meshes, particles, camera | THREE + read-only game state |
| src/ui/* | HUD, menus, results (DOM) | read-only game state |
| src/audio/* | WebAudio synth engine + sfx | read-only game state + events |
| src/input/* | keyboard/gamepad/touch → controls | (nothing from game) |
| src/main.js | boot, screens, fixed-step loop, glue | everything |

## Frozen APIs (already implemented — DO NOT change signatures)

### ClosedSpline (src/track/spline.js)
- `new ClosedSpline(points, {spacing})` — closed centripetal Catmull-Rom,
  resampled uniformly; `length`, `count`, `spacing` properties.
- `sampleAt(s, out?)` → `{x,y,z,tx,ty,tz,rx,rz,heading,curvature,s}` (wraps).
- `positionAt(s, out?)` → `{x,y,z}`.
- `project(x, z, out?, hintS?)` → `{s,lateral,dist,index,cx,cz}`.
- `heightAt(s)` → number.

### Track (src/track/track.js)
- `new Track(def)` — def from tracks.js. Props: `id,name,subtitle,laps,theme,
  spline,length,boostPads,itemBoxes,baseHalfWidth`.
- `sampleWorld(x, z, hintS?, out?)` → `{s,lateral,halfWidth,surface,offTrackDepth,
  height,heading,curvature,cx,cz}`; `surface` ∈ SURFACE.
- `toWorld(s, lateral, out?)` → `{x,y,z,heading}`.
- `halfWidthAt(s)`, `isOnBoostPad(s, lateral)`, `racingLineLateral(s)`,
  `respawnPoint(s, out?)`, `gridSlot(i, total, rowSpacing, colOffset, out?)`.
- Item boxes: `box ∈ {id,s,lateral,active,respawnAt,x,y,z}`;
  `updateItemBoxes(now)`, `consumeItemBox(box, now)`, `resetItemBoxes()`.

### Kart (src/game/kart.js)
State machine `kart.state` ∈ KART_STATE; controls shape from `makeControls()`.
Key fields (all already defined — read the file):
transform `x,y,z,yaw,vx,vy,vz,speed,airborne`; drift `drifting,driftDirection,
driftCharge,driftTier,hopTimer`; boost `boostTimer,boostPower,boostSource,
speedMul,draftCharge`; status `state,stateTimer,invulnTimer,starTimer,
shrinkTimer,aiSpeedMul,startPenaltyTimer`; items `item,itemUses,rouletteTimer,
rouletteFace`; track `s,lateral,surface,offTrackDepth,progress,lap,rank,
finished,finishTime,lapTimes,bestLap,wrongWay`; visual-only `visualYawOffset,
visualRoll,visualPitch,visualScale,wheelSpin`; stats `statSpeed,statAccel,
statHandling,statWeight`.
Methods: `applyBoost(power,duration,source)`, `spinOut(cause)`, `squash(cause)`,
`cancelDrift()`, `giveItem(item)`, `consumeItemUse()`, `clearItem()`,
`resetTo(x,y,z,yaw)`, `emit(type,data?)`, `clearEvents()`.
Getters: `maxSpeed,forwardX,forwardZ,rightX,rightZ,invulnerable,incapacitated,
speedRatio,itemInfo,driftTierInfo`.

## Contracts for modules TO BE implemented

### Cross-module ownership pins (read carefully — prevents divergence)
- **Bullet state**: items.js only *enters* the state (`kart.state = KART_STATE.BULLET`,
  `stateTimer = BOOST.bulletDuration`). physics.js *drives* it: autopilot along the
  centreline at `KART.maxSpeed * BOOST.bulletPower`, lateral → 0, invulnerable,
  exits to NORMAL when stateTimer expires (small exit boost).
- **useItem edges**: race.js does NOT edge-detect. ItemSystem.update reads
  `kart.controls.useItem`, tracks rising edges internally, calls its own
  `onUseItem`.
- **Drafting**: physics.js exports `updateDrafting(karts, dt)`; race.js calls it
  every step after collisions.
- **Start penalty**: race.js detects jump starts / rocket starts during the
  countdown and sets `kart.startPenaltyTimer` / applyBoost at GO. physics.js
  forces throttle to 0 while `startPenaltyTimer > 0` and decrements it.
- **Respawn**: physics.js triggers RESPAWNING when a kart is beyond
  `BOUNDS.offroadExtent + 8` laterally (or falls), using `track.respawnPoint`.
- **VFX queue**: ItemSystem pushes world-space one-shots to `this.vfx`
  (`[{type:'explosion'|'shell_break'|'banana_gone', x,y,z}]`);
  `drainVfx()` returns and clears it. main.js drains into Effects each frame.
- **Roulette duration**: owned by items.js (~1.1 s), writes `kart.rouletteTimer`
  (counts down to 0) and cycles `kart.rouletteFace` for the HUD.
- **Autopilot**: `new RaceDirector(track, {autopilot: true})` gives the player
  kart an AiDriver too (used by headless tests and the post-finish cruise).
- **Lap counting**: race.js accumulates signed arc-length deltas
  (`loopDelta(prevS, s, length)`) into a per-kart `_traveled` float;
  `lap = floor(_traveled / length)`; finish when `_traveled >= laps * length`.
  This makes back-and-forth over the line safe by construction.
  `kart.progress = _traveled` drives ranking.
- **Events consumed by presentation**: main.js calls `kart.clearEvents()` once
  per rendered frame AFTER effects + audio have read them. Systems only push.

### src/game/physics.js
```js
export function stepKartPhysics(kart, track, dt)   // one fixed step, one kart
export function resolveKartCollisions(karts, dt)   // pairwise push-out + events
export function updateDrafting(karts, dt)          // slipstream charge/boost
```
Responsibilities: throttle/brake/steer→speed & yaw; drift model (hop, charge
via DRIFT_TIERS, release boost via kart.applyBoost); surfaces (offroad slow,
boost pads via BOOST.padPower); soft wall at road edge + BOUNDS.offroadExtent
(beyond that = wall bounce); gravity/airborne; state timers (spin/squash/
respawn/invuln/star/shrink/startPenalty/boost decay via BOOST rates → writes
kart.speedMul); track projection each step (use hintS = kart.s), writes
kart.s/lateral/surface/offTrackDepth; wrong-way detection (kart.wrongWay);
visual fields (visualYawOffset lean while drifting, visualScale squash,
wheelSpin). Emits: 'land','drift_start','drift_tier',
'drift_boost','offroad','wall_hit','collide'. Collisions: circle push-out with
mass = statWeight, both karts emit 'collide' with impact speed.

### src/game/ai.js
```js
export class AiDriver {
  constructor(kart, track, rng, difficulty /* DIFFICULTY[key] */, personality /* 0..1 aggression */)
  update(dt, world /* {karts, items, raceState, elapsed} */)  // writes kart.controls
}
```
Pure-pursuit on racingLineLateral with per-driver lateral bias + noise;
lookahead scales with speed; brake for curvature ahead; drift on sustained
corners (respect KART.driftMinSpeed); use items with position-aware logic
(shells forward at targets, banana drops before corners, mushroom on straights,
star/lightning when behind, defensive hold vs red shells); rubber-band via
kart.aiSpeedMul (DIFFICULTY.rubberBand, clamp ~[0.88, 1.15]); avoid hazards
listed in world.items.hazards (see items.js) by steering offset; small
mistake rate scaled by (1 - aiSkill). Never touches physics directly —
controls only, plus aiSpeedMul.

### src/game/items.js
```js
export class ItemSystem {
  constructor(track, rng)
  reset()
  update(dt, karts, raceTime)
  // queries for AI + renderer:
  get projectiles()  // [{id,kind,x,y,z,yaw,ownerIndex,...}]
  get hazards()      // [{id,kind:'banana'|'bomb',x,y,z,armed,...}]
  onUseItem(kart, karts)      // called on rising edge of controls.useItem
  startRoulette(kart, rankOfKart, totalKarts)
}
```
Owns: item box pickup detection (track.itemBoxes, radius ~1.6+shrink aware),
roulette timing (~1.1s, writes kart.rouletteTimer/rouletteFace, resolves via
ITEM_WEIGHTS_BY_RANK + Rng.weighted), green shells (straight, bounce off walls
using track.sampleWorld, ITEM_PHYSICS), red shells (follow racing line, home on
next kart ahead by progress within lock range), blue shell (flies to 1st,
blast), bananas (drop behind or throw forward), bombs (fuse+blast radius),
mushroom (applyBoost), star (starTimer), lightning (all karts ahead of user:
squash+shrinkTimer, scaled by progress), bullet (KART_STATE.BULLET autopilot
along centreline at BOOST.bulletPower for BOOST.bulletDuration, handled here by
setting state; physics respects it). Hit → kart.spinOut()/squash(). Emits
events on karts. All randomness through rng.

### src/game/race.js
```js
export class RaceDirector {
  constructor(track, {playerCharacterId, difficulty, laps, seed})
  get karts(); get player(); get items(); get state(); get countdown(); get elapsed()
  reset()
  update(dt, playerControls)   // full fixed step: input→ai→items→physics→laps→rank
  get standings()              // karts sorted by rank
  get isRaceOver()
}
```
Owns kart creation (player + 7 AI on grid via track.gridSlot), countdown
(RACE.countdownDuration, rocket start / jump start via RACE windows), per-step
pipeline, lap counting via s-wrap detection near line with loopDelta guard
(kart.lap, lapTimes, bestLap; finish at track.laps → finished, finishTime,
freeze to AI control), progress = lap*length + s (careful at pre-line), rank
assignment (sort by progress; finished karts keep finish order), wrong-way flag,
results (RACE.postRaceTimeout auto-place), state machine RACE_STATE.

### src/render/* (scene.js, trackMesh.js, kartMesh.js, effects.js, camera.js)
- `createRenderer(canvas)` → {renderer, resize}via THREE.WebGLRenderer,
  antialias, shadows PCFSoft, sRGB, ACES tone mapping.
- `buildScene(track)` → {scene, sunLight, …} — sky gradient (big sphere or fog +
  clear color from theme), hemisphere+directional light, scenery by
  theme.scenery ('desert' cacti+rocks / 'harbor' cranes+containers+water /
  'alpine' pines+peaks), start gate over line, item box meshes (spinning
  translucent cubes with '?' feel), boost pad chevron decals.
- `buildTrackMesh(track)` — ribbon geometry from spline samples (positions
  px/py/pz ± right*halfWidth), UVs along s for dashed edge lines; offroad skirt;
  vertex colors or 2 materials; kerbs (red/white stripes) where |curvature| high.
- `KartVisual` class — low-poly kart from THREE primitives (body box + bevel,
  4 torus/cylinder wheels that spin via kart.wheelSpin and steer front wheels
  via kart.steerAngle, character-colored shell + accent, simple driver head
  with helmet), per-frame `sync(kart)` applying x/y/z, yaw+visualYawOffset,
  visualRoll/Pitch/Scale, star rainbow flash (material emissive cycling),
  shrink scale, drift spark emitters at rear wheels colored by driftTier
  (DRIFT_TIERS color), boost flame cone, brake light.
- `Effects` — pooled particles: drift sparks, boost flames, hit stars,
  explosion, item box shatter, offroad dust, confetti at finish. All pooled,
  zero allocation per frame.
- `ChaseCamera` — CAMERA constants; position damping via mathx.damp with
  look-ahead along kart forward, FOV kick with speedRatio + boost, shake on
  hits (kart.events), look-back when controls.lookBack.
- Minimap: build once from spline (2D polyline in a <canvas> overlay), per-frame
  dots for karts (player highlighted), colored by kart.color.

### src/ui/hud.js + screens
HUD: item slot w/ roulette animation, lap "2/3", position "3rd" big with
ordinal, speed lines at high speedRatio, lap time + best, final-lap banner,
wrong-way warning, countdown 3-2-1-GO, minimap canvas. Menus (DOM overlays,
gamepad/keyboard navigable): title → character select (grid of 8 with stats
bars) → track select (3 cards) → difficulty → race; pause (Esc: resume/
restart/quit); results table (positions, times, best lap) with confetti +
"press Enter". All styled in styles.css — chunky kart-racer aesthetic, bold
rounded sans (system stack), thick outlines, gradients, no external assets.

### src/audio/audio.js
WebAudio, all synthesized (no files): engine loop per-kart-ish (player full
detail: 2 detuned saws + noise, pitch from speedRatio + boost; AI karts one
shared distant layer scaled by proximity), skid loop while drifting, event
sfx map (boost woosh, item get chime, roulette ticks, shell fire, hits, spin,
squash horn, star jingle loop, lightning, countdown beeps + GO, finish
fanfare, UI move/confirm), lightweight music: chiptune-ish pattern sequencer
(two 16-step channels + kick/hat) with menu theme, race theme, final-lap
speedup, results theme. Master/music/sfx gains from AUDIO constants; created
lazily on first user gesture; `setMuted(m)`; mute toggle key M.

### src/input/input.js
```js
export class InputManager {
  constructor(targetEl)
  update()                    // poll gamepad, refresh edges
  readControls(out)           // fills a controls object (makeControls shape)
  menu                        // {up,down,left,right,confirm,back,pause} edge-triggered
  anyKey                      // edge
  usingGamepad; usingTouch
}
```
Keyboard: arrows/WASD steer+throttle, Space/Shift drift, Ctrl/E/Enter item,
R look back, Esc pause, M mute. Gamepad: stick + RT/A throttle, LT/B brake, RB/X
drift, LB/Y item, Start pause. Touch (only if 'ontouchstart'): left steer zone,
right buttons (gas auto, drift, item). Digital steer is smoothed in physics,
not input.

### src/main.js
Boot: import map check, create canvas, InputManager, AudioManager, screen
router (title/select/race/pause/results as DOM sections), race lifecycle:
build Track+RaceDirector+scene+visuals, fixed-step accumulator loop
(FIXED_DT, MAX_FRAME_TIME clamp), per frame: input.update → (menus or race
update) → visuals sync → effects → camera → HUD update → audio.consume(events)
→ kart.clearEvents() for all karts → render. Track/character/difficulty
selection state, restart/quit flows, window resize, visibilitychange pause.

## index.html
Already provided: import map `three` → /vendor/three.module.js, `#app` with
`<canvas id="game-canvas">`, DOM overlay roots: `#screen-title`,
`#screen-character`, `#screen-track`, `#screen-difficulty`, `#hud`,
`#screen-pause`, `#screen-results`, `#minimap` canvas inside #hud.
`src/styles.css` linked. main.js is the only script tag (type=module).

## Testing (node --test tests/)
- tests/spline.test.js — closure, uniform spacing, project() round-trip,
  hint disambiguation.
- tests/track.test.js — surfaces, widths, grid slots on-road, item box
  placement on-road, racing line within bounds, all 3 TRACKS build.
- tests/physics.test.js — accelerates to ~maxSpeed, brakes, turns, drift
  charges tiers & boosts on release, offroad slows, wall keeps kart within
  bounds, spinout timers, boost decay.
- tests/race.test.js — full headless race, 8 AI (player kart driven by an AI
  driver): with seed X the race completes < 6 min sim time, all karts finish,
  laps == track.laps, ranks are a permutation, lap times sane (> 15s each),
  determinism: same seed twice → identical finish order & times.
- tests/items.test.js — weights sum, roulette resolves, shell hit spins target,
  banana drop/hit, item box consume/respawn.

Run `node tools/syntax-check.mjs` to import every module (with DOM/THREE stubs
for presentation modules) and fail on syntax/import errors.
