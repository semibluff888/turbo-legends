# 🏎️ Turbo Legends

A Mario Kart-style 3D kart racer that runs entirely in your browser.
No build step; vendored Three.js, procedural visuals/SFX, and local soundtrack assets.

![genre](https://img.shields.io/badge/genre-kart%20racer-ff5fa2) ![deps](https://img.shields.io/badge/runtime%20deps-three.js%20(vendored)-4aa8ff)

## Play

```bash
npm start        # serves at http://127.0.0.1:5173
```

Then open the printed URL. (ES modules need an http origin — opening
`index.html` from disk won't work.)

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | ← → / A D | Left stick |
| Accelerate | ↑ / W | A or RT |
| Brake / reverse | ↓ / S | B or LT |
| Hop / drift | Space / Shift | X or RB |
| Use item | Ctrl / E | Y or LB |
| Look back | R | — |
| Pause | Esc | Start |
| Mute | M | — |

Touch devices get on-screen controls automatically (auto-gas, steer zone on
the left, drift/item buttons on the right).

## The game

- **8 racers** with real stat trade-offs (speed / accel / handling / weight)
- **3 tracks** — Sunset Circuit, Harbor Loop, Summit Raceway — with boost
  pads, item box rows, kerbs, elevation, and themed scenery
- **Drift & mini-turbo** — hop into a slide, hold it through the corner,
  release for blue → orange → purple tier boosts
- **10 items** — bananas, green/red/blue shells, mushrooms, bob-omb, star,
  lightning, Bullet autopilot — dealt by race position (leaders get junk,
  stragglers get comebacks)
- **7 AI drivers** with personalities, racing-line pursuit, mistakes,
  rubber-banding, and item spite
- **3 difficulty levels**, rocket starts, jump-start penalties, drafting,
  lap timing, wrong-way detection, minimap, results podium
- **Dynamic audio** — procedural WebAudio engines, skids and item SFX plus
  looping menu/track-specific MP3 soundtracks

## Development

```bash
npm test         # headless simulation tests (node --test)
npm run check    # import every module under Node (syntax/contract check)
```

The simulation (`src/core`, `src/track`, `src/game`) is pure JavaScript with
no DOM or Three.js dependency — the full 8-kart race runs headless in the
test suite, deterministically, from a seed. Presentation (`src/render`,
`src/ui`, `src/audio`, `src/input`) reads simulation state and never mutates
it. See `ARCHITECTURE.md` for the module contracts.

All characters and tracks are original. The *genre* is a homage; the content
is ours.
