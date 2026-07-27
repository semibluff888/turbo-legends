// AudioManager: the entire soundscape of Turbo Kart, fully synthesized with
// WebAudio — no asset files. Engine loop, skid loop, one-shot event SFX, and a
// tiny chiptune pattern sequencer for music.
//
// Lazy by contract: the constructor allocates nothing heavy and touches no
// browser API. init() must be called from a user gesture; every public method
// is a safe no-op while this.ctx === null.

import { AUDIO, DRIFT_TIERS, KART_STATE } from '../core/constants.js';
import { clamp } from '../core/mathx.js';

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Music patterns
// ---------------------------------------------------------------------------
// One step = a 16th note. Channels loop independently on their own length, so
// a 1-bar hat pattern can ride over an 8-bar melody. Melodic entries are
// `null` (rest), a MIDI note, or `[midi, lengthInSteps]`. Drum entries are
// velocities 0..1 (falsy = rest).

const _ = null;

/** Driving root/octave/fifth bass bar used by the race + results themes. */
const bassBar = (r) => [r, _, r, _, r + 12, _, r, _, r, _, r, _, r + 7, _, r, _];

// --- Race theme: E minor, 128 BPM, Em–C–G–D. Lead = A section (bars 1-4,
// chord tones) then B section (bars 5-8, busier). Bass loops every 4 bars.
const RACE = {
  bpm: 128,
  leadWave: 'square', leadGain: 0.085, bassGain: 0.26, hatGain: 1.0, kickGain: 1.0,
  bass: [...bassBar(40), ...bassBar(36), ...bassBar(43), ...bassBar(38)],
  lead: [
    // A — Em
    [64, 2], _, _, _, [67, 2], _, _, _, [69, 2], _, [67, 1], _, [71, 4], _, _, _,
    // C
    [72, 2], _, _, _, [71, 2], _, _, _, [67, 2], _, [64, 1], _, [69, 4], _, _, _,
    // G
    [67, 2], _, _, _, [71, 2], _, _, _, [74, 2], _, [71, 1], _, [67, 4], _, _, _,
    // D
    [66, 2], _, _, _, [69, 2], _, _, _, [66, 2], _, [62, 1], _, [64, 4], _, _, _,
    // B — Em
    [76, 1], _, [76, 1], _, [74, 2], _, _, _, [71, 1], _, [74, 1], _, [76, 2], _, [74, 1], _,
    // C
    [72, 1], _, [72, 1], _, [74, 2], _, _, _, [76, 2], _, _, _, [72, 2], _, _, _,
    // G
    [74, 1], _, [74, 1], _, [71, 2], _, _, _, [67, 1], _, [71, 1], _, [74, 2], _, [76, 1], _,
    // D — F#5 tension, resolve toward E next loop
    [78, 2], _, _, _, [74, 2], _, _, _, [69, 2], _, [66, 1], _, [71, 4], _, _, _,
  ],
  hat: [_, _, 1, _, _, _, 1, _, _, _, 1, _, _, _, 1, 0.5],
  kick: [1, _, _, _, _, _, _, _, 1, _, _, _, _, _, 0.7, _],
};

// --- Menu theme: laid back, 96 BPM, Amaj7–F#m7–Dmaj7–E7 (2 bars each).
const menuBassA = (r) => [[r, 4], _, _, _, _, _, _, _, [r + 7, 2], _, _, _, _, _, [r, 1], _];
const menuBassB = (r) => [[r, 4], _, _, _, _, _, [r + 12, 1], _, [r + 7, 2], _, _, _, _, _, _, _];
const MENU = {
  bpm: 96,
  leadWave: 'triangle', leadGain: 0.15, bassGain: 0.24, hatGain: 0.5, kickGain: 0.55,
  bass: [
    ...menuBassA(45), ...menuBassB(45), ...menuBassA(42), ...menuBassB(42),
    ...menuBassA(38), ...menuBassB(38), ...menuBassA(40), ...menuBassB(40),
  ],
  lead: [
    // Amaj7
    [69, 3], _, _, _, [71, 2], _, _, _, [73, 6], _, _, _, _, _, _, _,
    [76, 4], _, _, _, _, _, _, _, [73, 2], _, _, _, [71, 2], _, _, _,
    // F#m7
    [73, 3], _, _, _, [71, 2], _, _, _, [69, 6], _, _, _, _, _, _, _,
    [66, 4], _, _, _, _, _, _, _, [64, 4], _, _, _, _, _, _, _,
    // Dmaj7
    [66, 3], _, _, _, [69, 2], _, _, _, [71, 6], _, _, _, _, _, _, _,
    [73, 4], _, _, _, _, _, _, _, [69, 4], _, _, _, _, _, _, _,
    // E7
    [68, 3], _, _, _, [66, 2], _, _, _, [64, 6], _, _, _, _, _, _, _,
    [71, 4], _, _, _, _, _, _, _, [68, 2], _, _, _, [64, 2], _, _, _,
  ],
  hat: [_, _, _, _, 0.6, _, _, _, _, _, _, _, 0.6, _, _, 0.3],
  kick: [0.8, _, _, _, _, _, _, _, _, _, 0.5, _, _, _, _, _],
};

// --- Results theme: victory-ish doo-wop loop, C–Am–F–G at 112 BPM.
const RESULTS = {
  bpm: 112,
  leadWave: 'square', leadGain: 0.09, bassGain: 0.26, hatGain: 0.7, kickGain: 0.9,
  bass: [...bassBar(36), ...bassBar(45), ...bassBar(41), ...bassBar(43)],
  lead: [
    [72, 1], _, [72, 1], _, [76, 2], _, _, _, [79, 3], _, _, _, [76, 2], _, _, _,
    [76, 2], _, _, _, [74, 2], _, _, _, [72, 4], _, _, _, _, _, [69, 1], _,
    [69, 2], _, _, _, [72, 2], _, _, _, [77, 3], _, _, _, [76, 2], _, _, _,
    [74, 2], _, _, _, [71, 2], _, _, _, [67, 2], _, [71, 1], _, [74, 2], _, _, _,
  ],
  hat: [_, _, 0.8, _, _, _, 0.8, _, _, _, 0.8, _, _, _, 0.8, _],
  kick: [1, _, _, _, _, _, _, _, 1, _, _, _, _, _, _, _],
};

const THEMES = { menu: MENU, race: RACE, results: RESULTS };

/** Star invincibility arpeggio: C and D chords alternating, Mario-style. */
const STAR_ARP = [72, 76, 79, 84, 74, 78, 81, 86];
const STAR_STEP_DUR = 0.085;

const FINAL_LAP_RATE = 1.12;
const LOOKAHEAD = 0.1;         // seconds scheduled ahead of currentTime
const SCHEDULER_MS = 25;
const RAMP_WINDOW = 0.08;      // small linearRamp window for engine params

// Engine pitch map: 60 Hz idle → 210 Hz at top speed (+ extra past 1 for
// bullet/boost overspeed), ×1.25 while boosting.
const ENGINE_F_IDLE = 60;
const ENGINE_F_SPAN = 150;
const ENGINE_F_OVER = 55;
const ENGINE_BOOST_PITCH = 1.25;

export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this._muted = false;

    // Deferred intent recorded before init() (autoplay gate).
    this._themeName = null;
    this._engineWanted = false;

    this._finalLap = false;
    this._engineOn = false;

    // Sequencer state.
    this._musicStep = 0;
    this._nextStepTime = 0;
    this._starOn = false;
    this._starStep = 0;
    this._starNext = 0;
    this._timer = null;

    // Per-key rate limiting for one-shot SFX (also collapses the cases where
    // two systems report the same moment, e.g. 'boost' + 'drift_boost').
    this._gateMap = new Map();
    this._lastRouletteFace = null;
  }

  get muted() { return this._muted; }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Create the context + graph. Must be called from a user gesture. */
  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = (typeof window !== 'undefined')
      && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    const ctx = this.ctx = new AC();

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : AUDIO.masterVolume;
    this.master.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = AUDIO.sfxVolume;
    this.sfxGain.connect(this.master);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = AUDIO.musicVolume;
    this.musicGain.connect(this.master);

    // Soften the square lead — mellow, not grating.
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 5200;
    this.musicFilter.Q.value = 0.4;
    this.musicFilter.connect(this.musicGain);

    // Shared white-noise buffer for every noise-based voice.
    const len = Math.floor(ctx.sampleRate * 1.2);
    this._noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this._noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._buildEngine(ctx);
    this._buildSkid(ctx);
    this._buildAiLayer(ctx);

    this._timer = setInterval(() => this._tick(), SCHEDULER_MS);
    // Under Node (harness/tests) don't hold the process open.
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();

    if (this._engineWanted) this.startEngine();
    const pending = this._themeName;
    this._themeName = null;
    if (pending) this.playMusic(pending);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMuted(m) {
    this._muted = !!m;
    if (!this.ctx) return;
    this._ramp(this.master.gain, this._muted ? 0 : AUDIO.masterVolume, 0.06);
  }

  toggleMuted() { this.setMuted(!this._muted); }

  // -------------------------------------------------------------------------
  // Engine / skid / AI hum (continuous layers)
  // -------------------------------------------------------------------------

  _buildEngine(ctx) {
    this._engineGain = ctx.createGain();
    this._engineGain.gain.value = 0;
    this._engineGain.connect(this.sfxGain);

    this._engineFilter = ctx.createBiquadFilter();
    this._engineFilter.type = 'lowpass';
    this._engineFilter.frequency.value = 300;
    this._engineFilter.Q.value = 0.9;
    this._engineFilter.connect(this._engineGain);

    // Two detuned saws give the classic fat kart growl.
    this._engineOsc1 = ctx.createOscillator();
    this._engineOsc1.type = 'sawtooth';
    this._engineOsc1.frequency.value = ENGINE_F_IDLE;
    this._engineOsc1.connect(this._engineFilter);
    this._engineOsc1.start();

    this._engineOsc2 = ctx.createOscillator();
    this._engineOsc2.type = 'sawtooth';
    this._engineOsc2.frequency.value = ENGINE_F_IDLE * 1.012;
    this._engineOsc2.detune.value = 9;
    this._engineOsc2.connect(this._engineFilter);
    this._engineOsc2.start();

    // Subtle mechanical hiss under the saws.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    noise.loop = true;
    const noiseLp = ctx.createBiquadFilter();
    noiseLp.type = 'lowpass';
    noiseLp.frequency.value = 260;
    const noiseG = ctx.createGain();
    noiseG.gain.value = 0.35;
    noise.connect(noiseLp);
    noiseLp.connect(noiseG);
    noiseG.connect(this._engineGain);
    noise.start();
  }

  _buildSkid(ctx) {
    this._skidGain = ctx.createGain();
    this._skidGain.gain.value = 0;
    this._skidGain.connect(this.sfxGain);
    this._skidFilter = ctx.createBiquadFilter();
    this._skidFilter.type = 'bandpass';
    this._skidFilter.frequency.value = 850;
    this._skidFilter.Q.value = 1.3;
    this._skidFilter.connect(this._skidGain);
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    src.connect(this._skidFilter);
    src.start();
  }

  /** One shared distant engine standing in for all seven AI karts. */
  _buildAiLayer(ctx) {
    this._aiGain = ctx.createGain();
    this._aiGain.gain.value = 0;
    this._aiGain.connect(this.sfxGain);
    this._aiFilter = ctx.createBiquadFilter();
    this._aiFilter.type = 'lowpass';
    this._aiFilter.frequency.value = 240;
    this._aiFilter.connect(this._aiGain);
    this._aiOsc = ctx.createOscillator();
    this._aiOsc.type = 'sawtooth';
    this._aiOsc.frequency.value = 70;
    this._aiOsc.connect(this._aiFilter);
    this._aiOsc.start();
  }

  startEngine() {
    this._engineWanted = true;
    if (!this.ctx) return;
    this._engineOn = true;
    this._ramp(this._engineGain.gain, 0.16, 0.4);
  }

  stopEngine() {
    this._engineWanted = false;
    this._engineOn = false;
    if (!this.ctx) return;
    this._ramp(this._engineGain.gain, 0, 0.3);
    this._ramp(this._skidGain.gain, 0, 0.15);
    this._ramp(this._aiGain.gain, 0, 0.3);
  }

  /**
   * Per-frame continuous adjustment: engine pitch/filter from the player's
   * speed, skid loop while drifting, AI hum by proximity, star jingle state,
   * roulette ticks, wrong-way alarm.
   */
  update(dt, playerKart, race) {
    if (!this.ctx || !playerKart) return;
    const now = this.ctx.currentTime;

    if (this._engineOn) {
      const ratio = playerKart.speedRatio;
      const boosting = playerKart.boostTimer > 0
        || playerKart.state === KART_STATE.BULLET;
      let f = ENGINE_F_IDLE
        + ENGINE_F_SPAN * Math.min(ratio, 1)
        + ENGINE_F_OVER * Math.max(0, ratio - 1);
      if (boosting) f *= ENGINE_BOOST_PITCH;
      this._ramp(this._engineOsc1.frequency, f, RAMP_WINDOW);
      this._ramp(this._engineOsc2.frequency, f * 1.012, RAMP_WINDOW);
      const cutoff = 260 + 1100 * Math.min(ratio, 1) + (boosting ? 900 : 0);
      this._ramp(this._engineFilter.frequency, cutoff, RAMP_WINDOW);
      this._ramp(this._engineGain.gain, 0.15 + 0.09 * Math.min(ratio, 1), RAMP_WINDOW);

      // Skid loop: audible while drifting on the ground; tier lifts the pitch.
      const skidding = playerKart.drifting && !playerKart.airborne
        && !playerKart.incapacitated;
      this._ramp(this._skidGain.gain, skidding ? 0.15 : 0, 0.06);
      if (skidding) {
        const tier = Math.max(playerKart.driftTier, 0);
        this._ramp(this._skidFilter.frequency, 780 + tier * 260, RAMP_WINDOW);
      }

      // Distant AI layer follows the nearest rival.
      if (race && race.karts) {
        let bestD2 = Infinity;
        let nearest = null;
        for (const k of race.karts) {
          if (k.isPlayer) continue;
          const dx = k.x - playerKart.x, dz = k.z - playerKart.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; nearest = k; }
        }
        if (nearest) {
          const g = clamp(0.09 / (1 + bestD2 / 250), 0, 0.09);
          this._ramp(this._aiGain.gain, g, RAMP_WINDOW);
          const nf = 55 + 120 * Math.min(nearest.speedRatio, 1.2);
          this._ramp(this._aiOsc.frequency, nf, RAMP_WINDOW);
        }
      }
    }

    // Star jingle follows the player's timer (looped scheduled arpeggio).
    const wantStar = playerKart.starTimer > 0;
    if (wantStar && !this._starOn) {
      this._starOn = true;
      this._starStep = 0;
      this._starNext = now + 0.02;
    } else if (!wantStar && this._starOn) {
      this._starOn = false;
    }

    // Roulette ticks: one blip per face change while the wheel spins.
    if (playerKart.rouletteTimer > 0) {
      if (playerKart.rouletteFace !== this._lastRouletteFace) {
        this._lastRouletteFace = playerKart.rouletteFace;
        this._sfxRouletteTick(playerKart.rouletteTimer);
      }
    } else {
      this._lastRouletteFace = null;
    }

    // Soft rate-limited alarm while driving the wrong way.
    if (playerKart.wrongWay && this._gate('wrongway', 1.4)) this._sfxWrongWay();
  }

  // -------------------------------------------------------------------------
  // Event consumption
  // -------------------------------------------------------------------------

  /**
   * Read (never clear) every kart's event queue. Player events play at full
   * volume; AI events fall off with distance squared and are skipped when
   * inaudible.
   */
  consume(karts, race) {
    if (!this.ctx || !karts) return;
    let player = null;
    for (const k of karts) if (k.isPlayer) { player = k; break; }
    for (const kart of karts) {
      if (kart.events.length === 0) continue;
      let vol = 1;
      if (player && kart !== player) {
        const dx = kart.x - player.x, dz = kart.z - player.z;
        vol = 1 / (1 + (dx * dx + dz * dz) / 900);
        if (vol < 0.05) continue;
      }
      for (const ev of kart.events) this._playEvent(ev, kart, vol);
    }
  }

  _playEvent(ev, kart, vol) {
    const i = kart.index;
    switch (ev.type) {
      case 'boost': {
        // Shared gate keys collapse doubled reports (kart.applyBoost emits
        // 'boost' and physics may also emit a specific event).
        const src = ev.source;
        if (src === 'drift') {
          if (this._gate(`dboost:${i}`, 0.3)) {
            this._sfxDriftBoost(this._tierFromPower(ev.power), vol);
          }
        } else if (src === 'start' || src === 'rocket') {
          if (this._gate(`rocket:${i}`, 1.0)) this._sfxRocketStart(vol);
        } else if (src === 'bullet') {
          if (this._gate(`bullet:${i}`, 1.0)) this._sfxBulletStart(vol);
        } else if (src === 'star') {
          this._sfxBoost(vol * 0.6); // jingle carries the moment
        } else if (src === 'draft') {
          if (this._gate(`draft:${i}`, 0.5)) this._sfxBoost(vol * 0.6);
        } else {
          if (this._gate(`boost:${i}`, 0.18)) this._sfxBoost(vol);
        }
        break;
      }
      case 'drift_boost':
        if (this._gate(`dboost:${i}`, 0.3)) {
          this._sfxDriftBoost(ev.tier ?? Math.max(kart.driftTier, 0), vol);
        }
        break;
      case 'drift_tier':
        if (kart.isPlayer) this._sfxDriftTier(ev.tier ?? kart.driftTier, vol);
        break;
      case 'rocket_start':
        if (this._gate(`rocket:${i}`, 1.0)) this._sfxRocketStart(vol);
        break;
      case 'jump_start':
        if (this._gate(`jump:${i}`, 1.5)) this._sfxJumpStart(vol);
        break;
      case 'bullet_start':
        if (this._gate(`bullet:${i}`, 1.0)) this._sfxBulletStart(vol);
        break;
      case 'spinout':
        this._sfxSpinout(vol);
        break;
      case 'squash':
        this._sfxSquash(vol);
        break;
      case 'item_get':
        this._sfxItemGet(vol);
        break;
      case 'itembox':
        this._sfxItemBox(vol);
        break;
      case 'shell_fire':
      case 'throw':
      case 'banana_drop':
      case 'bomb_drop':
      case 'item_drop':
        this._sfxShellFire(vol);
        break;
      case 'lightning':
        // Global event — full volume regardless of emitter.
        if (this._gate('lightning', 0.5)) this._sfxLightning();
        break;
      case 'lap':
        if (kart.isPlayer) this._sfxLap(!!ev.isFinal);
        break;
      case 'finish':
        if (kart.isPlayer) {
          if (this._gate('finish', 2.0)) this._sfxFinishFanfare();
        } else {
          this._sfxLapChime(vol * 0.5);
        }
        break;
      case 'collide':
        if (this._gate(`collide:${i}`, 0.12)) {
          this._sfxCollide(vol * clamp((ev.impactSpeed ?? 6) / 18, 0.15, 1));
        }
        break;
      case 'wall_hit':
        if (this._gate(`wall:${i}`, 0.15)) this._sfxCollide(vol * 0.4);
        break;
      case 'land':
        if (this._gate(`land:${i}`, 0.15)) this._sfxLand(vol);
        break;
      case 'respawn':
      case 'fall':
        if (kart.isPlayer) this._sfxRespawn();
        break;
      default:
        break; // drift_start / offroad etc. are covered by continuous layers
    }
  }

  _tierFromPower(power) {
    if (typeof power !== 'number') return 1;
    let best = 0;
    for (let t = 0; t < DRIFT_TIERS.length; t++) {
      if (Math.abs(DRIFT_TIERS[t].boostPower - power)
        < Math.abs(DRIFT_TIERS[best].boostPower - power)) best = t;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Music sequencer
  // -------------------------------------------------------------------------

  /** @param {'menu'|'race'|'results'|null} name */
  playMusic(name) {
    if (!this.ctx) { this._themeName = name; return; }
    if (name === this._themeName) return;
    this._themeName = name;
    this._musicStep = 0;
    this._nextStepTime = this.ctx.currentTime + 0.06;
  }

  setFinalLap(b) { this._finalLap = !!b; }

  /** Lookahead scheduler: services the music loop and the star jingle. */
  _tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;

    const theme = this._themeName ? THEMES[this._themeName] : null;
    if (theme) {
      const rate = (this._themeName === 'race' && this._finalLap) ? FINAL_LAP_RATE : 1;
      const stepDur = 60 / theme.bpm / 4 / rate;
      // Resync after a long stall (tab hidden) instead of burst-scheduling.
      if (this._nextStepTime < now - 0.25) this._nextStepTime = now + 0.02;
      while (this._nextStepTime < now + LOOKAHEAD) {
        this._scheduleMusicStep(theme, this._musicStep, this._nextStepTime, stepDur);
        this._musicStep++;
        this._nextStepTime += stepDur;
      }
    }

    if (this._starOn) {
      if (this._starNext < now - 0.2) this._starNext = now + 0.02;
      while (this._starNext < now + LOOKAHEAD) {
        const m = STAR_ARP[this._starStep % STAR_ARP.length];
        this._tone(this._starNext, midiHz(m), 0.075, 'square', 0.05);
        this._starStep++;
        this._starNext += STAR_STEP_DUR;
      }
    }
  }

  _scheduleMusicStep(theme, step, t, stepDur) {
    const octaveUp = (this._themeName === 'race' && this._finalLap) ? 12 : 0;

    const bassEntry = theme.bass[step % theme.bass.length];
    if (bassEntry != null) {
      const m = Array.isArray(bassEntry) ? bassEntry[0] : bassEntry;
      const len = Array.isArray(bassEntry) ? bassEntry[1] : 1;
      this._tone(t, midiHz(m), stepDur * len * 0.92, 'triangle',
        theme.bassGain, { dest: this.musicGain });
    }

    const leadEntry = theme.lead[step % theme.lead.length];
    if (leadEntry != null) {
      const m = (Array.isArray(leadEntry) ? leadEntry[0] : leadEntry) + octaveUp;
      const len = Array.isArray(leadEntry) ? leadEntry[1] : 1;
      this._tone(t, midiHz(m), stepDur * len * 0.95, theme.leadWave,
        theme.leadGain, { dest: this.musicFilter });
    }

    const hatVel = theme.hat[step % theme.hat.length];
    if (hatVel) this._hat(t, hatVel * theme.hatGain);

    const kickVel = theme.kick[step % theme.kick.length];
    if (kickVel) this._kick(t, kickVel * theme.kickGain);
  }

  _hat(t, vel) {
    this._noise(t, 0.035, 0.11 * vel,
      { type: 'highpass', freq: 6500, dest: this.musicGain });
  }

  _kick(t, vel) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    osc.connect(g);
    g.connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.15);
    osc.onended = () => g.disconnect();
  }

  // -------------------------------------------------------------------------
  // Synth building blocks
  // -------------------------------------------------------------------------

  /** Oscillator one-shot with attack/decay envelope and optional pitch sweep. */
  _tone(t, freq, dur, wave, peak, opts) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(Math.max(freq, 1), t);
    if (opts && opts.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd, 1), t + dur);
    }
    let lfo = null, lfoGain = null;
    if (opts && opts.vibFreq) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = opts.vibFreq;
      lfoGain = ctx.createGain();
      lfoGain.gain.value = opts.vibDepth || 20;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    const g = ctx.createGain();
    const attack = (opts && opts.attack) || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect((opts && opts.dest) || this.sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    osc.onended = () => { g.disconnect(); if (lfoGain) lfoGain.disconnect(); };
    return osc;
  }

  /** Filtered noise one-shot from the shared buffer. */
  _noise(t, dur, peak, opts) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = (opts && opts.type) || 'bandpass';
    filter.frequency.setValueAtTime((opts && opts.freq) || 1000, t);
    if (opts && opts.freqEnd) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd, 1), t + dur);
    }
    filter.Q.value = (opts && opts.Q) || 1;
    const g = ctx.createGain();
    const attack = (opts && opts.attack) || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect((opts && opts.dest) || this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = () => g.disconnect();
    return src;
  }

  /** Small linear ramp toward a target — used for all continuous params. */
  _ramp(param, value, window_) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + window_);
  }

  /** Rate limiter: true if `key` hasn't fired within `interval` seconds. */
  _gate(key, interval) {
    const t = this.ctx.currentTime;
    const last = this._gateMap.get(key);
    if (last !== undefined && t - last < interval) return false;
    this._gateMap.set(key, t);
    return true;
  }

  // -------------------------------------------------------------------------
  // One-shot SFX
  // -------------------------------------------------------------------------

  _sfxBoost(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 180, 0.35, 'sawtooth', 0.16 * vol, { freqEnd: 720 });
    this._noise(t, 0.28, 0.14 * vol, { type: 'highpass', freq: 700, freqEnd: 2600 });
  }

  _sfxDriftBoost(tier, vol) {
    const t = this.ctx.currentTime;
    const f = 440 * (1 + 0.24 * Math.max(tier, 0));
    this._tone(t, f, 0.1, 'square', 0.13 * vol);
    this._tone(t + 0.07, f * 1.5, 0.16, 'square', 0.13 * vol);
    this._noise(t, 0.2, 0.1 * vol, { type: 'highpass', freq: 900, freqEnd: 2400 });
  }

  _sfxDriftTier(tier, vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 700 + Math.max(tier, 0) * 220, 0.06, 'square', 0.09 * vol);
  }

  _sfxItemGet(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 880, 0.12, 'triangle', 0.18 * vol);
    this._tone(t + 0.09, 1318.5, 0.2, 'triangle', 0.18 * vol);
  }

  _sfxRouletteTick(timeLeft) {
    const t = this.ctx.currentTime;
    // Pitch creeps up as the wheel slows toward its result.
    const f = 500 + (1.1 - Math.min(timeLeft, 1.1)) * 300;
    this._tone(t, f, 0.035, 'square', 0.07);
  }

  _sfxShellFire(vol) {
    const t = this.ctx.currentTime;
    this._noise(t, 0.12, 0.2 * vol, { type: 'bandpass', freq: 1400, freqEnd: 300, Q: 1.6 });
    this._tone(t, 420, 0.1, 'sawtooth', 0.1 * vol, { freqEnd: 130 });
  }

  _sfxSpinout(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 520, 0.5, 'triangle', 0.2 * vol,
      { freqEnd: 140, vibFreq: 11, vibDepth: 55 });
    this._noise(t, 0.25, 0.08 * vol, { type: 'bandpass', freq: 800, freqEnd: 250 });
  }

  _sfxSquash(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 900, 0.5, 'sine', 0.2 * vol, { freqEnd: 75 });   // comic slide
    this._tone(t + 0.42, 110, 0.16, 'sine', 0.32 * vol, { freqEnd: 45 }); // thud
  }

  _sfxLightning() {
    const t = this.ctx.currentTime;
    this._noise(t, 0.3, 0.28, { type: 'highpass', freq: 2200 });
    this._tone(t, 1500, 0.4, 'sawtooth', 0.14, { freqEnd: 90 });
    this._tone(t + 0.05, 55, 0.7, 'sine', 0.26, { freqEnd: 38 }); // rumble
  }

  _sfxItemBox(vol) {
    const t = this.ctx.currentTime;
    this._noise(t, 0.08, 0.18 * vol, { type: 'bandpass', freq: 1900, Q: 4 });
    this._tone(t, 1046.5, 0.07, 'sine', 0.14 * vol);
  }

  _sfxLap(isFinal) {
    if (isFinal) {
      const t = this.ctx.currentTime;
      this._tone(t, 740, 0.1, 'square', 0.15);
      this._tone(t + 0.12, 740, 0.1, 'square', 0.15);
      this._tone(t + 0.24, 988, 0.3, 'square', 0.16);
    } else {
      this._sfxLapChime(1);
    }
  }

  _sfxLapChime(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 987.8, 0.22, 'triangle', 0.16 * vol);
  }

  _sfxRocketStart(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 120, 0.5, 'sawtooth', 0.18 * vol, { freqEnd: 900 });
    this._noise(t, 0.45, 0.16 * vol, { type: 'highpass', freq: 400, freqEnd: 3000 });
  }

  _sfxJumpStart(vol) {
    const t = this.ctx.currentTime;
    // Two close squares beat against each other: rude little buzzer.
    this._tone(t, 110, 0.5, 'square', 0.12 * vol);
    this._tone(t, 116.5, 0.5, 'square', 0.12 * vol);
  }

  _sfxBulletStart(vol) {
    const t = this.ctx.currentTime;
    this._noise(t, 0.8, 0.24 * vol, { type: 'lowpass', freq: 300, freqEnd: 1200, attack: 0.12 });
    this._tone(t, 60, 0.9, 'sawtooth', 0.2 * vol, { freqEnd: 190 });
  }

  _sfxCollide(gain) {
    const t = this.ctx.currentTime;
    this._tone(t, 150, 0.12, 'sine', 0.35 * gain, { freqEnd: 55 });
    this._noise(t, 0.06, 0.12 * gain, { type: 'lowpass', freq: 500 });
  }

  _sfxLand(vol) {
    const t = this.ctx.currentTime;
    this._tone(t, 100, 0.08, 'sine', 0.14 * vol, { freqEnd: 60 });
  }

  _sfxRespawn() {
    const t = this.ctx.currentTime;
    this._tone(t, 600, 0.3, 'triangle', 0.12, { freqEnd: 200 });
  }

  _sfxWrongWay() {
    const t = this.ctx.currentTime;
    this._tone(t, 392, 0.14, 'square', 0.08);
    this._tone(t + 0.16, 311, 0.14, 'square', 0.08);
  }

  _sfxFinishFanfare() {
    const t = this.ctx.currentTime;
    const notes = [392, 523.3, 659.3, 784, 1046.5]; // G4 C5 E5 G5 C6
    const times = [0, 0.12, 0.24, 0.36, 0.6];
    for (let n = 0; n < notes.length; n++) {
      const dur = n === notes.length - 1 ? 0.9 : 0.18;
      this._tone(t + times[n], notes[n], dur, 'triangle', 0.16);
      this._tone(t + times[n], notes[n], dur, 'square', 0.05);
    }
  }

  // -------------------------------------------------------------------------
  // Direct-call SFX (main.js)
  // -------------------------------------------------------------------------

  /** @param {'move'|'confirm'|'back'} kind */
  ui(kind) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'confirm') {
      this._tone(t, 660, 0.06, 'square', 0.09);
      this._tone(t + 0.06, 880, 0.09, 'square', 0.09);
    } else if (kind === 'back') {
      this._tone(t, 520, 0.06, 'square', 0.08);
      this._tone(t + 0.06, 390, 0.09, 'square', 0.08);
    } else {
      this._tone(t, 600, 0.045, 'square', 0.07);
    }
  }

  /** 3, 2, 1 = short beep; 0 = the long GO beep. */
  countdownBeep(n) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (n > 0) {
      this._tone(t, 784, 0.13, 'square', 0.2);
    } else {
      this._tone(t, 1046.5, 0.5, 'square', 0.2);
      this._tone(t, 523.3, 0.5, 'triangle', 0.12);
    }
  }
}
