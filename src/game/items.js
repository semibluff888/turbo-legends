// ItemSystem — item boxes, roulette, projectiles, hazards, item activation.
// Pure simulation: no THREE, no DOM. All randomness flows through the injected
// Rng so a seeded race replays identically.
//
// Ownership pins honored here (see ARCHITECTURE.md):
//  - useItem edge detection lives HERE (race.js does not edge-detect).
//  - Bullet: we only ENTER the state; physics.js drives and exits it.
//  - Roulette duration + face cycling live here; the HUD reads
//    kart.rouletteTimer / kart.rouletteFace.
//  - VFX one-shots are queued on `this.vfx`; main.js calls drainVfx() per frame.

import {
  ITEM, ITEM_WEIGHTS_BY_RANK, ITEM_PHYSICS, BOOST, KART_STATE, GRAVITY,
} from '../core/constants.js';
import { clamp, lerp, damp, moveTowards, angleDelta, loopDelta } from '../core/mathx.js';

// --- Local tuning (values with no constants.js equivalent) ------------------
const ROULETTE_DURATION = 1.1;   // pinned in ARCHITECTURE.md (~1.1 s)
const ROULETTE_TICK = 0.07;      // HUD face-cycle interval while spinning
const BOX_PICKUP_RADIUS = 1.7;   // xz distance to collect an item box
const BOX_PICKUP_HEIGHT = 2.2;   // |Δy| tolerance for box pickup
const BOMB_ARM_TIME = 0.4;       // planted bombs are inert this long
const SHELL_WALL_MARGIN = 1.0;   // shells ride this far past the road edge before the wall
const SHELL_HEIGHT = 0.45;       // shells hover slightly above the road surface
const RED_LOOKAHEAD = 7.0;       // racing-line aim distance for red shells
const RED_HOME_RANGE = 26.0;     // arc distance where a red shell switches from line-follow to homing
const BLUE_TURN_RATE = 3.2;      // rad/s of cruise steering for the blue shell
const BLUE_DIVE_RANGE = 11.0;    // xz distance at which the blue shell tips into its dive
const BLUE_DIVE_TURN_MUL = 2.5;  // extra steering authority while diving (guarantees the spiral closes)
const BLUE_BLAST_TRIGGER = 1.8;  // xz distance that detonates the dive
const BLUE_CLIMB_LAMBDA = 2.6;   // damp rate toward cruise height
const BOMB_THROW_SPEED = 16.0;   // horizontal lob speed added to the thrower's speed
const BOMB_THROW_LIFT = 7.5;     // vertical lob impulse
const BOMB_CHAIN_DELAY = 0.12;   // chained bombs pop this long after a nearby blast
const HIT_HEIGHT = 2.4;          // max |Δy| for a projectile/hazard to touch a kart
const HAZARD_REST_HEIGHT = 0.35; // hazards sit this far above the road surface
const LIGHTNING_MIN_SCALE = 0.6; // shrink duration scale for the kart just ahead of the user
const MAX_LIVE = 64;             // hard cap on live projectiles / hazards (each)

/** ITEM_WEIGHTS_BY_RANK row for a 1-based race rank. */
function rankToRow(rank) {
  if (rank <= 1) return 0;
  if (rank <= 3) return 1;
  if (rank <= 5) return 2;
  if (rank <= 7) return 3;
  return 4;
}

/** Resolve a kart by stable kart.index (karts is normally index-ordered). */
function findKart(karts, index) {
  const direct = karts[index];
  if (direct && direct.index === index) return direct;
  for (const k of karts) if (k.index === index) return k;
  return null;
}

/** The current race leader (rank 1), falling back to best progress. */
function findLeader(karts) {
  let best = null;
  for (const k of karts) {
    if (k.rank === 1) return k;
    if (!best || k.progress > best.progress) best = k;
  }
  return best;
}

function newProjectile() {
  return {
    id: 0, kind: ITEM.GREEN_SHELL,
    x: 0, y: 0, z: 0, yaw: 0,
    vx: 0, vy: 0, vz: 0,
    ownerIndex: -1, age: 0, s: 0,
    bounces: 0, targetIndex: -1,
    straight: false, diving: false, armed: true,
  };
}

function newHazard() {
  return {
    id: 0, kind: ITEM.BANANA,
    x: 0, y: 0, z: 0, yaw: 0,
    ownerIndex: -1, age: 0, s: 0, lateral: 0,
    armed: false, fuse: Infinity, dead: false,
  };
}

export class ItemSystem {
  /**
   * @param {import('../track/track.js').Track} track
   * @param {import('../core/rng.js').Rng} rng
   */
  constructor(track, rng) {
    this.track = track;
    this.rng = rng;

    this._projectiles = [];
    this._hazards = [];
    this._projectilePool = [];
    this._hazardPool = [];
    this._nextId = 1;

    /** World-space one-shot VFX; main.js drains into Effects each frame. */
    this.vfx = [];
    this._vfxBack = [];

    // Per-kart internal state, keyed by kart.index.
    this._prevUse = [];
    this._rouletteRow = [];
    this._rouletteTick = [];

    // Face lists per weight row so the roulette only shows plausible items.
    this._rowFaces = ITEM_WEIGHTS_BY_RANK.map((row) => Object.keys(row));

    // Scratch objects — reused every query to avoid per-frame allocation.
    this._ws = {};
    this._tw = {};
  }

  /** Live projectiles: green/red/blue shells + bombs in flight. */
  get projectiles() { return this._projectiles; }

  /** Live ground hazards: bananas and planted bombs. */
  get hazards() { return this._hazards; }

  /** Clear all live objects and restore every item box. IDs stay monotonic. */
  reset() {
    while (this._projectiles.length) this._projectilePool.push(this._projectiles.pop());
    while (this._hazards.length) this._hazardPool.push(this._hazards.pop());
    this.vfx.length = 0;
    this._vfxBack.length = 0;
    this._prevUse.length = 0;
    this._rouletteRow.length = 0;
    this._rouletteTick.length = 0;
    this.track.resetItemBoxes();
  }

  /**
   * Return the queued one-shot VFX and start a fresh queue. Double-buffered:
   * the returned array is valid until the next drain, no allocation per frame.
   */
  drainVfx() {
    const out = this.vfx;
    this.vfx = this._vfxBack;
    this._vfxBack = out;
    this.vfx.length = 0;
    return out;
  }

  /**
   * One fixed step of the whole item layer.
   * @param {number} dt seconds
   * @param {Array} karts all karts in the race (stable order)
   * @param {number} raceTime elapsed race time in seconds (item box respawns)
   */
  update(dt, karts, raceTime) {
    this.track.updateItemBoxes(raceTime);
    if (this._prevUse.length !== karts.length) {
      this._prevUse.length = karts.length;
      this._prevUse.fill(false);
    }
    this._updateRoulette(dt, karts);
    this._updatePickups(karts, raceTime);
    this._updateUseEdges(karts);
    this._updateProjectiles(dt, karts);
    this._updateHazards(dt, karts);
  }

  // ---------------------------------------------------------------------------
  // Item boxes + roulette
  // ---------------------------------------------------------------------------

  /** Begin the item roulette for a kart. Rank decides the weight row. */
  startRoulette(kart, rankOfKart, totalKarts) {
    const row = Math.min(rankToRow(rankOfKart), ITEM_WEIGHTS_BY_RANK.length - 1);
    kart.rouletteTimer = ROULETTE_DURATION;
    this._rouletteRow[kart.index] = row;
    this._rouletteTick[kart.index] = ROULETTE_TICK;
    kart.rouletteFace = this.rng.pick(this._rowFaces[row]);
  }

  _updateRoulette(dt, karts) {
    for (const kart of karts) {
      if (kart.rouletteTimer <= 0) continue;
      kart.rouletteTimer -= dt;
      const row = this._rouletteRow[kart.index] ?? ITEM_WEIGHTS_BY_RANK.length - 1;
      if (kart.rouletteTimer <= 0) {
        kart.rouletteTimer = 0;
        const result = this.rng.weighted(ITEM_WEIGHTS_BY_RANK[row]);
        if (result) {
          kart.giveItem(result);
          kart.rouletteFace = result; // HUD lands on the item actually won
        }
        continue;
      }
      this._rouletteTick[kart.index] -= dt;
      if (this._rouletteTick[kart.index] <= 0) {
        this._rouletteTick[kart.index] += ROULETTE_TICK;
        const faces = this._rowFaces[row];
        let face = this.rng.pick(faces);
        // One reroll keeps the spinner visibly moving without biasing results.
        if (face === kart.rouletteFace && faces.length > 1) face = this.rng.pick(faces);
        kart.rouletteFace = face;
      }
    }
  }

  _updatePickups(karts, raceTime) {
    const boxes = this.track.itemBoxes;
    const r2 = BOX_PICKUP_RADIUS * BOX_PICKUP_RADIUS;
    for (const kart of karts) {
      if (kart.finished || kart.rouletteTimer > 0 || kart.item !== ITEM.NONE) continue;
      if (kart.state === KART_STATE.BULLET) continue;
      for (const box of boxes) {
        if (!box.active) continue;
        const dx = kart.x - box.x;
        const dz = kart.z - box.z;
        if (dx * dx + dz * dz > r2) continue;
        if (Math.abs(kart.y - box.y) > BOX_PICKUP_HEIGHT) continue;
        this.track.consumeItemBox(box, raceTime);
        this.startRoulette(kart, kart.rank, karts.length);
        kart.emit('itembox', { boxId: box.id });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Item activation
  // ---------------------------------------------------------------------------

  _updateUseEdges(karts) {
    const prev = this._prevUse;
    for (let i = 0; i < karts.length; i++) {
      const kart = karts[i];
      const cur = !!kart.controls.useItem;
      if (cur && !prev[i]
        && kart.rouletteTimer <= 0
        && kart.item !== ITEM.NONE
        && !kart.incapacitated
        && !kart.finished
        && kart.state !== KART_STATE.BULLET) {
        this.onUseItem(kart, karts);
      }
      prev[i] = cur;
    }
  }

  /** Activate the kart's held item. Called on the rising edge of useItem. */
  onUseItem(kart, karts) {
    const item = kart.item;
    if (item === ITEM.NONE) return;
    const back = !!kart.controls.lookBack;
    switch (item) {
      case ITEM.GREEN_SHELL:
      case ITEM.RED_SHELL:
        this._launchShell(kart, item, back, karts);
        break;
      case ITEM.BLUE_SHELL:
        this._launchBlue(kart);
        break;
      case ITEM.BANANA:
        this._dropBanana(kart);
        break;
      case ITEM.BOMB:
        this._throwBomb(kart, back);
        break;
      case ITEM.MUSHROOM:
      case ITEM.TRIPLE_MUSHROOM:
        kart.applyBoost(BOOST.mushroomPower, BOOST.mushroomDuration, 'mushroom');
        break;
      case ITEM.STAR:
        kart.starTimer = BOOST.starDuration;
        kart.applyBoost(BOOST.starPower, BOOST.starDuration, 'star');
        break;
      case ITEM.LIGHTNING:
        this._useLightning(kart, karts);
        break;
      case ITEM.BULLET:
        // Pin: items.js only enters the state; physics.js drives + exits it.
        kart.cancelDrift();
        kart.state = KART_STATE.BULLET;
        kart.stateTimer = BOOST.bulletDuration;
        kart.emit('bullet_start');
        break;
      default:
        break;
    }
    kart.emit('item_used', { item });
    kart.consumeItemUse();
  }

  _launchShell(kart, kind, back, karts) {
    const dir = back ? -1 : 1;
    const off = back ? ITEM_PHYSICS.trailOffset : ITEM_PHYSICS.launchOffset;
    const x = kart.x + kart.forwardX * off * dir;
    const z = kart.z + kart.forwardZ * off * dir;
    const yaw = back ? kart.yaw + Math.PI : kart.yaw;
    const p = this._spawnProjectile(kind, x, kart.y + SHELL_HEIGHT, z, yaw, kart.index, kart.s);
    if (kind === ITEM.RED_SHELL) {
      if (back) {
        p.straight = true; // rear-fired reds fly straight, like a green
      } else {
        const target = this._findRedTarget(kart, karts);
        p.targetIndex = target ? target.index : -1;
      }
    }
  }

  _launchBlue(kart) {
    const p = this._spawnProjectile(
      ITEM.BLUE_SHELL,
      kart.x, kart.y + 1.5, kart.z,
      kart.yaw, kart.index, kart.s,
    );
    p.armed = true;
  }

  _dropBanana(kart) {
    const x = kart.x - kart.forwardX * ITEM_PHYSICS.trailOffset;
    const z = kart.z - kart.forwardZ * ITEM_PHYSICS.trailOffset;
    const ws = this.track.sampleWorld(x, z, kart.s, this._ws, kart.y);
    this._spawnHazard(ITEM.BANANA, x, ws.height + HAZARD_REST_HEIGHT, z, kart.yaw, kart.index, ws.s, ws.lateral);
  }

  _throwBomb(kart, back) {
    if (back) {
      // Plant it behind, like a banana with a fuse.
      const x = kart.x - kart.forwardX * ITEM_PHYSICS.trailOffset;
      const z = kart.z - kart.forwardZ * ITEM_PHYSICS.trailOffset;
      const ws = this.track.sampleWorld(x, z, kart.s, this._ws, kart.y);
      this._spawnHazard(ITEM.BOMB, x, ws.height + HAZARD_REST_HEIGHT, z, kart.yaw, kart.index, ws.s, ws.lateral);
      return;
    }
    const x = kart.x + kart.forwardX * ITEM_PHYSICS.launchOffset;
    const z = kart.z + kart.forwardZ * ITEM_PHYSICS.launchOffset;
    const p = this._spawnProjectile(ITEM.BOMB, x, kart.y + 1.2, z, kart.yaw, kart.index, kart.s);
    const fwd = Math.max(kart.speed, 0) + BOMB_THROW_SPEED;
    p.vx = kart.forwardX * fwd;
    p.vz = kart.forwardZ * fwd;
    p.vy = BOMB_THROW_LIFT;
    p.armed = false; // in-flight bombs render unarmed
  }

  _useLightning(user, karts) {
    const n = karts.length;
    for (const kart of karts) {
      if (kart === user || kart.finished) continue;
      if (kart.progress <= user.progress) continue;
      if (kart.invulnerable) continue;
      kart.squash('lightning');
      // Classic scaling: the further ahead, the longer the shrink — leader worst.
      const frac = n > 1 ? clamp((kart.rank - 1) / (n - 1), 0, 1) : 0;
      kart.shrinkTimer = ITEM_PHYSICS.lightningShrinkDuration * lerp(1, LIGHTNING_MIN_SCALE, frac);
      kart.emit('lightning_hit');
    }
    user.emit('lightning');
  }

  /** Nearest kart ahead of `owner` by progress, within red-shell lock range. */
  _findRedTarget(owner, karts) {
    let best = null;
    let bestDelta = Infinity;
    for (const kart of karts) {
      if (kart === owner || kart.finished) continue;
      const d = kart.progress - owner.progress;
      if (d > 0.5 && d <= ITEM_PHYSICS.redShellLockRange && d < bestDelta) {
        bestDelta = d;
        best = kart;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Projectiles
  // ---------------------------------------------------------------------------

  _updateProjectiles(dt, karts) {
    const list = this._projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      let alive;
      if (p.age > ITEM_PHYSICS.shellLifetime) {
        if (p.kind === ITEM.BLUE_SHELL || p.kind === ITEM.BOMB) {
          this._explode(p.x, p.y, p.z, this._blastRadius(p.kind), karts, p.kind);
        } else {
          this._pushVfx('shell_break', p.x, p.y, p.z);
        }
        alive = false;
      } else {
        switch (p.kind) {
          case ITEM.GREEN_SHELL: alive = this._stepGreen(p, dt); break;
          case ITEM.RED_SHELL: alive = this._stepRed(p, dt, karts); break;
          case ITEM.BLUE_SHELL: alive = this._stepBlue(p, dt, karts); break;
          case ITEM.BOMB: alive = this._stepBombLob(p, dt); break;
          default: alive = false; break;
        }
      }
      if (alive) alive = this._checkProjectileHits(p, karts);
      if (!alive) this._releaseProjectileAt(i);
    }
  }

  _stepGreen(p, dt) {
    p.x += Math.sin(p.yaw) * ITEM_PHYSICS.shellSpeed * dt;
    p.z += Math.cos(p.yaw) * ITEM_PHYSICS.shellSpeed * dt;
    const ws = this.track.sampleWorld(p.x, p.z, p.s, this._ws, p.y);
    p.s = ws.s;
    p.y = ws.height + SHELL_HEIGHT;
    const limit = ws.halfWidth + SHELL_WALL_MARGIN;
    if (Math.abs(ws.lateral) > limit) {
      // Reflect the lateral velocity component in the track frame.
      const fx = Math.sin(ws.heading);
      const fz = Math.cos(ws.heading);
      const rx = Math.cos(ws.heading);
      const rz = -Math.sin(ws.heading);
      const vx = Math.sin(p.yaw);
      const vz = Math.cos(p.yaw);
      const vLat = vx * rx + vz * rz;
      if (vLat * ws.lateral > 0) { // only when still heading outward
        p.bounces += 1;
        if (p.bounces > ITEM_PHYSICS.shellBounces) return this._breakShell(p);
        const vAlong = vx * fx + vz * fz;
        p.yaw = Math.atan2(fx * vAlong - rx * vLat, fz * vAlong - rz * vLat);
        const tw = this.track.toWorld(ws.s, Math.sign(ws.lateral) * limit, this._tw);
        p.x = tw.x;
        p.z = tw.z;
      }
    }
    return true;
  }

  _stepRed(p, dt, karts) {
    if (!p.straight) {
      const target = p.targetIndex >= 0 ? findKart(karts, p.targetIndex) : null;
      let desiredYaw = p.yaw;
      let homing = false;
      if (target && !target.finished) {
        const ahead = loopDelta(p.s, target.s, this.track.length);
        if (ahead > -4 && ahead < RED_HOME_RANGE) {
          desiredYaw = Math.atan2(target.x - p.x, target.z - p.z);
          homing = true;
        }
      }
      if (!homing) {
        // Follow the racing line until close enough to home in.
        const aimS = p.s + RED_LOOKAHEAD;
        const tw = this.track.toWorld(aimS, this.track.racingLineLateral(aimS), this._tw);
        desiredYaw = Math.atan2(tw.x - p.x, tw.z - p.z);
      }
      const maxTurn = ITEM_PHYSICS.redShellTurnRate * dt;
      p.yaw += clamp(angleDelta(p.yaw, desiredYaw), -maxTurn, maxTurn);
    }
    p.x += Math.sin(p.yaw) * ITEM_PHYSICS.shellSpeed * dt;
    p.z += Math.cos(p.yaw) * ITEM_PHYSICS.shellSpeed * dt;
    const ws = this.track.sampleWorld(p.x, p.z, p.s, this._ws, p.y);
    p.s = ws.s;
    p.y = ws.height + SHELL_HEIGHT;
    // Red shells shatter on walls instead of bouncing.
    if (Math.abs(ws.lateral) > ws.halfWidth + SHELL_WALL_MARGIN) return this._breakShell(p);
    return true;
  }

  _stepBlue(p, dt, karts) {
    const ws = this.track.sampleWorld(p.x, p.z, p.s, this._ws, p.y);
    p.s = ws.s;
    const target = findLeader(karts);
    if (!target) {
      p.x += Math.sin(p.yaw) * ITEM_PHYSICS.blueShellSpeed * dt;
      p.z += Math.cos(p.yaw) * ITEM_PHYSICS.blueShellSpeed * dt;
      return true;
    }
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const distXZ = Math.hypot(dx, dz);
    const desiredYaw = Math.atan2(dx, dz);
    const turnMul = p.diving ? BLUE_DIVE_TURN_MUL : 1;
    const maxTurn = BLUE_TURN_RATE * turnMul * dt;
    p.yaw += clamp(angleDelta(p.yaw, desiredYaw), -maxTurn, maxTurn);
    p.x += Math.sin(p.yaw) * ITEM_PHYSICS.blueShellSpeed * dt;
    p.z += Math.cos(p.yaw) * ITEM_PHYSICS.blueShellSpeed * dt;
    if (!p.diving && distXZ < BLUE_DIVE_RANGE) p.diving = true;
    if (p.diving) {
      p.y = moveTowards(p.y, target.y + 0.5, ITEM_PHYSICS.blueShellSpeed * 1.2 * dt);
      const grounded = p.y - target.y < 1.6;
      if ((distXZ < BLUE_BLAST_TRIGGER && grounded)
        || (grounded && distXZ < ITEM_PHYSICS.blueShellBlastRadius && p.y <= target.y + 0.6)) {
        this._explode(p.x, target.y, p.z, ITEM_PHYSICS.blueShellBlastRadius, karts, ITEM.BLUE_SHELL);
        return false;
      }
    } else {
      p.y = damp(p.y, ws.height + ITEM_PHYSICS.blueShellCruiseHeight, BLUE_CLIMB_LAMBDA, dt);
    }
    return true;
  }

  _stepBombLob(p, dt) {
    p.vy -= GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    const ws = this.track.sampleWorld(p.x, p.z, p.s, this._ws, p.y);
    p.s = ws.s;
    if (p.vy <= 0 && p.y <= ws.height + HAZARD_REST_HEIGHT) {
      this._spawnHazard(
        ITEM.BOMB, p.x, ws.height + HAZARD_REST_HEIGHT, p.z,
        p.yaw, p.ownerIndex, ws.s, ws.lateral,
      );
      return false;
    }
    return true;
  }

  _checkProjectileHits(p, karts) {
    const r2 = ITEM_PHYSICS.hitRadius * ITEM_PHYSICS.hitRadius;
    for (const kart of karts) {
      if (kart.finished) continue;
      if (kart.index === p.ownerIndex && p.age < ITEM_PHYSICS.ownerImmunity) continue;
      const dx = kart.x - p.x;
      const dz = kart.z - p.z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(kart.y - p.y) > HIT_HEIGHT) continue;
      if (p.kind === ITEM.BOMB || p.kind === ITEM.BLUE_SHELL) {
        this._explode(p.x, p.y, p.z, this._blastRadius(p.kind), karts, p.kind);
        return false;
      }
      // Green / red shell contact.
      if (kart.starTimer > 0 || kart.state === KART_STATE.BULLET) {
        return this._breakShell(p); // star karts smash shells harmlessly
      }
      if (kart.invulnerable) continue; // brief i-frames: pass through
      kart.spinOut(p.kind);
      return this._breakShell(p);
    }
    // Ground hazards stop shells: bananas absorb them, bombs detonate.
    if (p.kind === ITEM.GREEN_SHELL || p.kind === ITEM.RED_SHELL) {
      for (const h of this._hazards) {
        if (h.dead) continue;
        const dx = h.x - p.x;
        const dz = h.z - p.z;
        if (dx * dx + dz * dz > r2) continue;
        if (Math.abs(h.y - p.y) > HIT_HEIGHT) continue;
        if (h.kind === ITEM.BANANA) h.dead = true;
        else h.fuse = Math.min(h.fuse, h.age); // bomb pops in this step's hazard pass
        return this._breakShell(p);
      }
    }
    return true;
  }

  _blastRadius(kind) {
    return kind === ITEM.BLUE_SHELL
      ? ITEM_PHYSICS.blueShellBlastRadius
      : ITEM_PHYSICS.bombBlastRadius;
  }

  _breakShell(p) {
    this._pushVfx('shell_break', p.x, p.y, p.z);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Hazards
  // ---------------------------------------------------------------------------

  _updateHazards(dt, karts) {
    const list = this._hazards;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      h.age += dt;
      if (h.dead) {
        if (h.kind === ITEM.BANANA) this._pushVfx('banana_gone', h.x, h.y, h.z);
        else this._explode(h.x, h.y, h.z, ITEM_PHYSICS.bombBlastRadius, karts, ITEM.BOMB);
        this._releaseHazardAt(i);
        continue;
      }
      if (h.kind === ITEM.BANANA) {
        if (h.age > ITEM_PHYSICS.bananaLifetime) {
          this._pushVfx('banana_gone', h.x, h.y, h.z);
          this._releaseHazardAt(i);
          continue;
        }
        const hit = this._hazardContact(h, karts);
        if (hit) {
          if (hit.starTimer > 0 || hit.state === KART_STATE.BULLET) {
            this._pushVfx('banana_gone', h.x, h.y, h.z);
            this._releaseHazardAt(i);
          } else if (hit.spinOut('banana')) {
            this._pushVfx('banana_gone', h.x, h.y, h.z);
            this._releaseHazardAt(i);
          }
          continue;
        }
      } else { // planted bomb
        if (!h.armed && h.age >= BOMB_ARM_TIME) h.armed = true;
        if (h.age >= h.fuse) {
          this._explode(h.x, h.y, h.z, ITEM_PHYSICS.bombBlastRadius, karts, ITEM.BOMB);
          this._releaseHazardAt(i);
          continue;
        }
        if (h.armed && this._hazardContact(h, karts)) {
          this._explode(h.x, h.y, h.z, ITEM_PHYSICS.bombBlastRadius, karts, ITEM.BOMB);
          this._releaseHazardAt(i);
          continue;
        }
      }
    }
  }

  /**
   * First kart touching this hazard, or null. Karts with plain i-frames or in
   * respawn pass straight through; star/bullet karts ARE returned so callers
   * can destroy the hazard (or detonate it) without hurting them.
   */
  _hazardContact(h, karts) {
    const r2 = ITEM_PHYSICS.hitRadius * ITEM_PHYSICS.hitRadius;
    for (const kart of karts) {
      if (kart.finished) continue;
      if (kart.index === h.ownerIndex && h.age < ITEM_PHYSICS.ownerImmunity) continue;
      if (kart.state === KART_STATE.RESPAWNING || kart.invulnTimer > 0) continue;
      const dx = kart.x - h.x;
      const dz = kart.z - h.z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(kart.y - h.y) > HIT_HEIGHT) continue;
      return kart;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Blasts, spawning, pooling
  // ---------------------------------------------------------------------------

  /** Squash every kart in the blast radius and chain nearby bombs. */
  _explode(x, y, z, radius, karts, cause) {
    this._pushVfx('explosion', x, y, z);
    const r2 = radius * radius;
    for (const kart of karts) {
      if (kart.finished) continue;
      const dx = kart.x - x;
      const dz = kart.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (Math.abs(kart.y - y) > radius * 1.2) continue;
      kart.squash(cause); // internally rejects invulnerable karts
    }
    // Chain reaction: nearby bombs cook off shortly after; bananas are wiped.
    for (const h of this._hazards) {
      if (h.dead) continue;
      const dx = h.x - x;
      const dz = h.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (h.kind === ITEM.BOMB) h.fuse = Math.min(h.fuse, h.age + BOMB_CHAIN_DELAY);
      else h.dead = true;
    }
  }

  _spawnProjectile(kind, x, y, z, yaw, ownerIndex, hintS) {
    if (this._projectiles.length >= MAX_LIVE) this._releaseProjectileAt(0);
    const p = this._projectilePool.pop() || newProjectile();
    p.id = this._nextId++;
    p.kind = kind;
    p.x = x; p.y = y; p.z = z;
    p.yaw = yaw;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.ownerIndex = ownerIndex;
    p.age = 0;
    p.bounces = 0;
    p.targetIndex = -1;
    p.straight = false;
    p.diving = false;
    p.armed = true;
    const ws = this.track.sampleWorld(x, z, hintS, this._ws, y);
    p.s = ws.s;
    this._projectiles.push(p);
    return p;
  }

  _spawnHazard(kind, x, y, z, yaw, ownerIndex, s, lateral) {
    if (this._hazards.length >= MAX_LIVE) this._releaseHazardAt(0);
    const h = this._hazardPool.pop() || newHazard();
    h.id = this._nextId++;
    h.kind = kind;
    h.x = x; h.y = y; h.z = z;
    h.yaw = yaw;
    h.ownerIndex = ownerIndex;
    h.age = 0;
    h.s = s;
    h.lateral = lateral;
    h.armed = kind === ITEM.BANANA; // bananas are live immediately
    h.fuse = kind === ITEM.BOMB ? ITEM_PHYSICS.bombFuse : Infinity;
    h.dead = false;
    this._hazards.push(h);
    return h;
  }

  _releaseProjectileAt(i) {
    const list = this._projectiles;
    const p = list[i];
    list[i] = list[list.length - 1];
    list.pop();
    this._projectilePool.push(p);
  }

  _releaseHazardAt(i) {
    const list = this._hazards;
    const h = list[i];
    list[i] = list[list.length - 1];
    list.pop();
    this._hazardPool.push(h);
  }

  _pushVfx(type, x, y, z) {
    this.vfx.push({ type, x, y, z });
  }
}
