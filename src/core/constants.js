// Central tuning + shared enums. This module is the contract every other
// system codes against; changing a value here should never require changing
// code elsewhere. Pure data + enums only — no imports, no side effects.

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Fixed simulation timestep (seconds). Physics is deterministic at this rate. */
export const FIXED_DT = 1 / 120;

/** Never advance more than this much wall-clock in one frame (tab-switch guard). */
export const MAX_FRAME_TIME = 0.25;

/** Ground plane height. The track surface sits at y = 0. */
export const GROUND_Y = 0;

export const GRAVITY = 26.0;

// ---------------------------------------------------------------------------
// Kart handling
// ---------------------------------------------------------------------------

export const KART = {
  // Longitudinal
  maxSpeed: 26.0,          // units/sec at full throttle on tarmac
  reverseMaxSpeed: 9.0,
  accel: 21.0,             // acceleration toward max speed
  brakeDecel: 34.0,
  coastDecel: 8.0,         // engine braking when no input
  offroadDrag: 30.0,       // extra decel applied when off the track surface
  offroadMaxSpeedMul: 0.46,

  // Steering
  steerRate: 3.1,          // how fast steering input ramps (per second)
  maxSteerAngle: 0.62,     // radians of steering at full lock
  // Steering authority falls off with speed so the kart is controllable at top end.
  steerSpeedFalloff: 0.55,
  // Minimum fraction of steering retained at max speed.
  steerMinAuthority: 0.42,

  // Grip / drift
  grip: 12.0,              // lateral velocity damping on tarmac
  driftGrip: 4.4,          // lateral damping while drifting (lets the rear slide)
  offroadGrip: 6.0,
  driftSteerBoost: 1.55,   // steering multiplier while drifting
  driftMinSpeed: 9.0,      // can't initiate a drift below this speed
  driftYawBias: 0.42,      // how much the kart body rotates into the slide

  // Body / visual
  bodyLength: 2.0,
  bodyWidth: 1.25,
  bodyHeight: 0.85,
  collisionRadius: 1.05,

  // Airborne
  hopVelocity: 6.2,        // vertical impulse when hopping into a drift
  airControl: 0.35,        // fraction of steering authority while airborne

  // Recovery
  spinOutDuration: 1.35,
  squashDuration: 1.6,
  respawnDuration: 1.7,
  spinOutSpeedMul: 0.18,   // speed retained when spun out
};

/** Per-character stat spread. Values multiply the KART baseline. */
export const CHARACTER_STAT_RANGE = {
  speed: [0.92, 1.09],
  accel: [0.86, 1.18],
  handling: [0.88, 1.16],
  weight: [0.80, 1.30],
};

// ---------------------------------------------------------------------------
// Drift / boost
// ---------------------------------------------------------------------------

/** Charge thresholds (seconds of sustained drift) for each mini-turbo tier. */
export const DRIFT_TIERS = [
  { name: 'blue', chargeTime: 0.85, boostDuration: 0.62, boostPower: 1.28, color: 0x4fc3ff },
  { name: 'orange', chargeTime: 1.85, boostDuration: 1.05, boostPower: 1.42, color: 0xffa028 },
  { name: 'purple', chargeTime: 3.10, boostDuration: 1.55, boostPower: 1.58, color: 0xc766ff },
];

export const BOOST = {
  /** Multiplier applied to max speed while a boost is active (pad/mushroom). */
  padPower: 1.5,
  padDuration: 0.9,
  mushroomPower: 1.52,
  mushroomDuration: 1.4,
  starPower: 1.45,
  starDuration: 7.0,
  bulletPower: 2.05,
  bulletDuration: 6.0,
  /** How quickly the kart accelerates into a boost, and decays out of it. */
  attackRate: 40.0,
  decayRate: 9.0,
  /** Slipstream (drafting) */
  draftRange: 11.0,
  draftConeDeg: 26,
  draftChargeTime: 1.1,
  draftPower: 1.22,
  draftDuration: 1.4,
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Item identifiers. Use these constants — never raw strings. */
export const ITEM = {
  NONE: 'none',
  BANANA: 'banana',
  GREEN_SHELL: 'green_shell',
  RED_SHELL: 'red_shell',
  MUSHROOM: 'mushroom',
  TRIPLE_MUSHROOM: 'triple_mushroom',
  BOMB: 'bomb',
  STAR: 'star',
  LIGHTNING: 'lightning',
  BULLET: 'bullet',
  BLUE_SHELL: 'blue_shell',
};

/** Display metadata for the HUD. `uses` is how many activations one pickup grants. */
export const ITEM_INFO = {
  [ITEM.BANANA]: { label: 'Banana', glyph: '🍌', color: 0xffdd33, uses: 1 },
  [ITEM.GREEN_SHELL]: { label: 'Green Shell', glyph: '🐢', color: 0x33dd55, uses: 1 },
  [ITEM.RED_SHELL]: { label: 'Red Shell', glyph: '🔴', color: 0xff3344, uses: 1 },
  [ITEM.MUSHROOM]: { label: 'Mushroom', glyph: '🍄', color: 0xff5566, uses: 1 },
  [ITEM.TRIPLE_MUSHROOM]: { label: 'Triple Mushroom', glyph: '🍄', color: 0xff5566, uses: 3 },
  [ITEM.BOMB]: { label: 'Bob-omb', glyph: '💣', color: 0x333344, uses: 1 },
  [ITEM.STAR]: { label: 'Star', glyph: '⭐', color: 0xffe14d, uses: 1 },
  [ITEM.LIGHTNING]: { label: 'Lightning', glyph: '⚡', color: 0xfff066, uses: 1 },
  [ITEM.BULLET]: { label: 'Bullet Bill', glyph: '🚀', color: 0x445577, uses: 1 },
  [ITEM.BLUE_SHELL]: { label: 'Spiny Shell', glyph: '🔵', color: 0x3355ff, uses: 1 },
};

/**
 * Item roulette weights by race position (1st = index 0).
 * Rows are interpolated across the field: a racer's row is chosen by rank.
 * This is classic rubber-banding — leaders get defensive junk, the back of the
 * pack gets comeback power.
 */
export const ITEM_WEIGHTS_BY_RANK = [
  // 1st place — defensive only
  { [ITEM.BANANA]: 45, [ITEM.GREEN_SHELL]: 35, [ITEM.MUSHROOM]: 8, [ITEM.BOMB]: 12 },
  // 2nd–3rd
  { [ITEM.BANANA]: 30, [ITEM.GREEN_SHELL]: 26, [ITEM.RED_SHELL]: 18, [ITEM.MUSHROOM]: 18, [ITEM.BOMB]: 8 },
  // 4th–5th
  { [ITEM.BANANA]: 16, [ITEM.GREEN_SHELL]: 18, [ITEM.RED_SHELL]: 24, [ITEM.MUSHROOM]: 22, [ITEM.TRIPLE_MUSHROOM]: 10, [ITEM.BOMB]: 6, [ITEM.STAR]: 4 },
  // 6th–7th
  { [ITEM.GREEN_SHELL]: 8, [ITEM.RED_SHELL]: 20, [ITEM.MUSHROOM]: 18, [ITEM.TRIPLE_MUSHROOM]: 18, [ITEM.STAR]: 14, [ITEM.LIGHTNING]: 8, [ITEM.BLUE_SHELL]: 8, [ITEM.BULLET]: 6 },
  // 8th and back — full comeback kit
  { [ITEM.RED_SHELL]: 12, [ITEM.TRIPLE_MUSHROOM]: 20, [ITEM.STAR]: 20, [ITEM.LIGHTNING]: 12, [ITEM.BLUE_SHELL]: 14, [ITEM.BULLET]: 22 },
];

export const ITEM_PHYSICS = {
  shellSpeed: 32.0,
  shellLifetime: 9.0,
  shellBounces: 4,
  redShellTurnRate: 3.4,     // radians/sec of homing authority
  redShellLockRange: 120.0,  // max arc-length ahead to acquire a target
  bombFuse: 2.6,
  bombBlastRadius: 6.5,
  bananaLifetime: 45.0,
  /** Radius within which a hazard/projectile registers a hit on a kart. */
  hitRadius: 1.6,
  /** How far behind the kart a dropped/held item sits. */
  trailOffset: 2.2,
  /** Forward launch offset so a thrown shell doesn't hit its owner. */
  launchOffset: 2.4,
  /** Owner is immune to their own projectile for this long after launch. */
  ownerImmunity: 0.35,
  blueShellCruiseHeight: 14.0,
  blueShellSpeed: 46.0,
  blueShellBlastRadius: 8.0,
  lightningShrinkDuration: 7.0,
  lightningSpeedMul: 0.55,
  lightningScale: 0.55,
};

/** Item box respawn delay after being collected. */
export const ITEM_BOX_RESPAWN = 4.0;

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

export const RACE = {
  totalKarts: 8,
  defaultLaps: 3,
  countdownDuration: 3.6,
  /** Grid spacing behind the start line. */
  gridRowSpacing: 4.6,
  gridColumnOffset: 2.6,
  /** Perfect-start window: boost if accel is pressed within this of GO. */
  rocketStartWindow: [0.22, 0.02],
  rocketStartPower: 1.45,
  rocketStartDuration: 1.1,
  /** Penalty for holding accelerate too early. */
  jumpStartPenalty: 1.4,
  /** How long results stay on screen before input is accepted. */
  resultsInputDelay: 1.2,
  /** Seconds after the winner finishes before unfinished AI are auto-placed. */
  postRaceTimeout: 22.0,
};

/** Difficulty presets: scales AI speed and aggression. */
export const DIFFICULTY = {
  easy: { label: 'Easy', aiSpeed: 0.90, aiSkill: 0.55, rubberBand: 0.35, itemAggression: 0.5 },
  normal: { label: 'Normal', aiSpeed: 0.975, aiSkill: 0.78, rubberBand: 0.55, itemAggression: 0.75 },
  hard: { label: 'Hard', aiSpeed: 1.015, aiSkill: 0.93, rubberBand: 0.72, itemAggression: 1.0 },
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export const SURFACE = {
  ROAD: 'road',
  OFFROAD: 'offroad',
  BOOST: 'boost',
  WALL: 'wall',
};

/** How far past the road edge a kart may stray before hitting the soft wall. */
export const BOUNDS = {
  offroadExtent: 16,   // drivable offroad strip width beyond the road edge
  wallRestitution: 0.35,
  wallTangentKeep: 0.86, // fraction of along-wall speed kept on impact
};

// ---------------------------------------------------------------------------
// Race state machine
// ---------------------------------------------------------------------------

export const RACE_STATE = {
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',   // player crossed the line, race still resolving
  RESULTS: 'results',
};

/** Kart status effects — mutually exclusive "you are not driving" states. */
export const KART_STATE = {
  NORMAL: 'normal',
  SPINNING: 'spinning',   // hit by shell/banana
  SQUASHED: 'squashed',   // hit by bomb/blue shell/lightning
  RESPAWNING: 'respawning',
  BULLET: 'bullet',       // on rails, invulnerable
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAMERA = {
  fov: 68,
  near: 0.3,
  far: 900,
  /** Chase camera offsets in kart-local space (x, y, z-back). */
  distance: 7.4,
  height: 3.35,
  lookAhead: 6.5,
  lookHeight: 1.15,
  /** Damping rate constants. */
  positionLambda: 7.5,
  rotationLambda: 6.0,
  /** FOV widens with speed for a sense of velocity. */
  fovSpeedBoost: 16,
  fovLambda: 4.0,
  /** Extra pull-back while boosting. */
  boostPullback: 1.1,
  shakeDecay: 5.0,
};

export const AUDIO = {
  masterVolume: 0.75,
  musicVolume: 0.38,
  sfxVolume: 0.85,
};

/** Canonical layer/collision groups used for spatial queries. */
export const GROUP = {
  KART: 1 << 0,
  HAZARD: 1 << 1,
  PROJECTILE: 1 << 2,
  ITEM_BOX: 1 << 3,
};
