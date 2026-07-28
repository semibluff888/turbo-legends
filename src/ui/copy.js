import { ITEM } from '../core/constants.js';
import { MENU_BGM_CHOICES, RACE_BGM_CHOICES } from '../audio/bgm.js';

// English-only UI copy for the current release. Keeping presentation strings
// together makes a later localization pass mechanical without adding locale
// state or a language selector now.
export const UI_COPY = Object.freeze({
  title: {
    heading: 'MAIN MENU',
    items: [
      { value: 'single', icon: '🏁', label: 'SINGLE PLAYER', desc: 'Race against 7 AI drivers' },
      { value: 'multiplayer', icon: '🌐', label: 'MULTIPLAYER', desc: 'Online competitive racing', badge: 'COMING SOON' },
      { value: 'settings', icon: '⚙️', label: 'SETTINGS', desc: 'Audio and game options' },
      { value: 'help', icon: '📖', label: 'HELP', desc: 'Controls, items and racing tips' },
    ],
    hint: 'Arrows / WASD to navigate · Enter to select · M to mute',
    multiplayerToast: 'MULTIPLAYER IS COMING SOON',
  },
  character: {
    heading: 'PICK YOUR RACER',
    hint: 'Arrows to browse · Enter to pick · Esc to go back',
  },
  track: {
    heading: 'CHOOSE A TRACK',
    hint: 'Enter to select · Esc to go back',
  },
  difficulty: {
    heading: 'DIFFICULTY',
    hint: 'Enter to race · Esc to go back',
    flavor: {
      easy: { icon: '☀️', desc: 'Relaxed rivals, gentle items. A sunny Sunday drive.' },
      normal: { icon: '🏁', desc: 'A proper race. The pack fights back — so should you.' },
      hard: { icon: '🔥', desc: 'Ruthless AI, maximum rubber-band. Bring mushrooms.' },
    },
  },
  pause: {
    heading: 'PAUSED',
    items: [
      ['resume', 'RESUME'],
      ['settings', 'SETTINGS'],
      ['help', 'HELP'],
      ['restart', 'RESTART'],
      ['quit', 'QUIT TO TITLE'],
    ],
  },
  results: {
    heading: 'RACE RESULTS',
    racer: 'Racer',
    time: 'Time',
    bestLap: 'Best Lap',
    continue: 'Press Enter to continue',
  },
  settings: {
    heading: 'SETTINGS',
    rows: [
      { key: 'muted', kind: 'toggle', label: 'MUTE ALL', desc: 'Silence every audio channel' },
      { key: 'master', kind: 'volume', label: 'MASTER VOLUME', desc: 'Overall game volume' },
      { key: 'musicEnabled', kind: 'toggle', label: 'BACKGROUND MUSIC', desc: 'Enable the soundtrack' },
      { key: 'music', kind: 'volume', label: 'MUSIC VOLUME', desc: 'Soundtrack level' },
      { key: 'menuBgm', kind: 'choice', label: 'MENU BGM', desc: 'Music used across the main menus', options: MENU_BGM_CHOICES },
      { key: 'raceBgm', kind: 'choice', label: 'RACE BGM', desc: 'Default follows the selected track', options: RACE_BGM_CHOICES },
      { key: 'sfx', kind: 'volume', label: 'SFX VOLUME', desc: 'Engines, items and interface sounds' },
    ],
    reset: 'RESET TO DEFAULTS',
    back: 'BACK',
    hint: 'Up / Down to select · Left / Right to adjust · Esc to go back',
  },
  help: {
    heading: 'HELP',
    tabs: [
      { value: 'controls', label: 'CONTROLS' },
      { value: 'items', label: 'ITEMS' },
      { value: 'gameplay', label: 'GAMEPLAY' },
    ],
    back: 'BACK',
    hint: 'Left / Right changes tab · Up / Down scrolls · Esc goes back',
  },
});

export const HELP_CONTROLS = Object.freeze([
  {
    title: 'KEYBOARD',
    rows: [
      ['Steer', 'A / D or ← / →'],
      ['Accelerate', 'W or ↑'],
      ['Brake / Reverse', 'S or ↓'],
      ['Hop / Drift', 'Space or Shift'],
      ['Use Item', 'Ctrl, E or Enter'],
      ['Look Back', 'R'],
      ['Pause / Back', 'Esc'],
      ['Mute', 'M'],
    ],
  },
  {
    title: 'GAMEPAD',
    rows: [
      ['Steer', 'Left Stick / D-pad'],
      ['Accelerate', 'RT or A'],
      ['Brake / Reverse', 'LT or B'],
      ['Hop / Drift', 'RB or X'],
      ['Use Item', 'LB or Y'],
      ['Look Back', 'Right Stick Down'],
      ['Pause', 'Start'],
      ['Menu Back', 'B'],
    ],
  },
  {
    title: 'TOUCH',
    rows: [
      ['Accelerate', 'Automatic'],
      ['Steer', 'Drag in the left side of the screen'],
      ['Hop / Drift', 'Drift button'],
      ['Use Item', 'Item button'],
    ],
  },
]);

export const HELP_ITEM_ORDER = Object.freeze([
  ITEM.BANANA,
  ITEM.GREEN_SHELL,
  ITEM.RED_SHELL,
  ITEM.BLUE_SHELL,
  ITEM.MUSHROOM,
  ITEM.TRIPLE_MUSHROOM,
  ITEM.BOMB,
  ITEM.STAR,
  ITEM.LIGHTNING,
  ITEM.BULLET,
]);

export const HELP_ITEM_DESCRIPTIONS = Object.freeze({
  [ITEM.BANANA]: 'Drops behind your kart and spins out the next racer who hits it.',
  [ITEM.GREEN_SHELL]: 'Travels in a straight line and bounces off walls. Hold Look Back to fire it behind you.',
  [ITEM.RED_SHELL]: 'Tracks the nearest racer ahead. Hold Look Back to launch it backward instead.',
  [ITEM.BLUE_SHELL]: 'Hunts the race leader and explodes in a wide blast near first place.',
  [ITEM.MUSHROOM]: 'Grants a strong burst of speed for overtaking or cutting through rough ground.',
  [ITEM.TRIPLE_MUSHROOM]: 'Stores three separate mushroom boosts in one item pickup.',
  [ITEM.BOMB]: 'Throws forward and explodes after landing. Hold Look Back to plant it behind your kart.',
  [ITEM.STAR]: 'Temporarily boosts your speed, makes you invulnerable and knocks rivals aside.',
  [ITEM.LIGHTNING]: 'Shrinks and slows every opponent currently ahead of you.',
  [ITEM.BULLET]: 'Transforms your kart into a high-speed autopilot that charges through the field.',
});

export const HELP_GAMEPLAY = Object.freeze([
  { icon: '🏆', title: 'FINISH FIRST', text: 'Eight racers compete over the track\'s required lap count. Cross the final line ahead of the pack.' },
  { icon: '🚦', title: 'ROCKET START', text: 'Press accelerate just before GO for an opening boost. Holding it too early causes a jump-start penalty.' },
  { icon: '🌀', title: 'DRIFT BOOSTS', text: 'Hop while steering and keep drifting. Release after blue, orange or purple sparks for increasingly stronger boosts.' },
  { icon: '🎁', title: 'ITEM BOXES', text: 'Drive through item boxes to start the roulette. Racers farther behind receive stronger comeback items.' },
  { icon: '⚡', title: 'KEEP YOUR SPEED', text: 'Hit boost pads, chain drift boosts and follow rivals closely to charge a slipstream boost.' },
  { icon: '👀', title: 'USE ITEMS SMARTLY', text: 'Look backward while using shells or Bob-ombs to defend your position from racers behind.' },
]);
