// Local race session adapter.
//
// Presentation code talks to this stable session shape instead of depending
// directly on RaceDirector. The online implementation exposes the same
// getters, which keeps rendering/HUD/audio agnostic about where simulation
// state comes from.

import { RaceDirector } from '../game/race.js';

export class LocalRaceSession {
  constructor(track, options = {}) {
    this.track = track;
    this.director = new RaceDirector(track, options);
    this.kind = 'local';
  }

  get karts() { return this.director.karts; }
  get player() { return this.director.player; }
  get items() { return this.director.items; }
  get state() { return this.director.state; }
  get countdown() { return this.director.countdown; }
  get elapsed() { return this.director.elapsed; }
  get laps() { return this.director.laps; }
  get standings() { return this.director.standings; }
  get isRaceOver() { return this.director.isRaceOver; }

  update(dt, controls) {
    this.director.update(dt, controls);
  }

  reset() {
    this.director.reset();
  }

  setAiPlayerLabel(label) {
    this.director.setAiPlayerLabel(label);
  }

  dispose() {}
}
