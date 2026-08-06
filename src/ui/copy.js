import { ITEM } from '../core/constants.js';
import { MENU_BGM_CHOICES, RACE_BGM_CHOICES } from '../audio/bgm.js';

export const DEFAULT_LANGUAGE = 'zh-CN';
export const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'en']);
export const LANGUAGE_CHOICES = Object.freeze([
  Object.freeze({ value: 'zh-CN', label: '简体中文' }),
  Object.freeze({ value: 'en', label: 'English' }),
]);

const SUPPORTED_LANGUAGE_SET = new Set(SUPPORTED_LANGUAGES);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function localizeBgmChoices(choices, { random, defaultByTrack }) {
  return choices.map((choice) => ({
    value: choice.value,
    label: choice.value === 'random'
      ? random
      : choice.value === 'default' ? defaultByTrack : choice.label,
  }));
}

const HELP_ITEM_IDS = Object.freeze([
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

const EN_COPY = {
  common: {
    on: 'ON', off: 'OFF', percent: '{value} percent', previous: 'Previous {label}', next: 'Next {label}',
    lockedAria: '{name}, locked, coming soon', comingSoon: 'COMING SOON',
    weights: { light: 'light', medium: 'medium', heavy: 'heavy' },
    stats: { speed: 'Speed', accel: 'Accel', handling: 'Turn', weight: 'Weight' },
    laps: '{count} LAPS', you: 'YOU', dnf: 'DNF', racerFallback: 'Racer {rank}', aiPlayer: 'AI player', max: ' MAX+',
  },
  document: {
    finishSkip: 'ENTER / A  ·  SKIP', finishSkipTouch: 'SKIP', finishSkipAria: 'Skip finish cinematic',
    steer: 'STEER', steerAria: 'Drag left or right to steer', controlsAria: 'Race controls',
    pauseAria: 'Pause race', item: 'ITEM', itemAria: 'Use item', brake: 'BRAKE',
    brakeAria: 'Brake or reverse', drift: 'DRIFT', driftAria: 'Drift',
    noscript: 'Turbo Legends needs JavaScript enabled.',
  },
  title: {
    heading: 'MAIN MENU', tagline: 'START YOUR ENGINES',
    items: [
      { value: 'single', icon: '🏁', label: 'SINGLE PLAYER', desc: 'Race against 7 AI drivers' },
      { value: 'multiplayer', icon: '🌐', label: 'MULTIPLAYER', desc: 'Browse public and private online rooms' },
      { value: 'settings', icon: '⚙️', label: 'SETTINGS', desc: 'Audio and game options' },
      { value: 'help', icon: '📖', label: 'HELP', desc: 'Controls, items and racing tips' },
    ],
    hint: 'Arrows / WASD to navigate · Enter to select · M to mute',
    multiplayerToast: 'OPENING ONLINE PLAY',
  },
  character: { heading: 'PICK YOUR KART', hint: 'Arrows to browse · Enter to pick · Esc to go back' },
  track: { heading: 'CHOOSE A TRACK', hint: 'Enter to select · Esc to go back' },
  difficulty: {
    heading: 'DIFFICULTY', hint: 'Enter to race · Esc to go back',
    labels: { easy: 'Easy', normal: 'Normal', hard: 'Hard' },
    flavor: {
      easy: { icon: '☀️', desc: 'Relaxed rivals, gentle items. A sunny Sunday drive.' },
      normal: { icon: '🏁', desc: 'A proper race. The pack fights back — so should you.' },
      hard: { icon: '🔥', desc: 'Ruthless AI, maximum rubber-band. Bring mushrooms.' },
    },
  },
  pause: {
    heading: 'PAUSED',
    items: [['resume', 'RESUME'], ['settings', 'SETTINGS'], ['help', 'HELP'], ['restart', 'RESTART'], ['quit', 'QUIT TO TITLE']],
  },
  results: { heading: 'RACE RESULTS', racer: 'Racer', time: 'Time', bestLap: 'Best Lap', continue: 'Press Enter to continue' },
  settings: {
    heading: 'SETTINGS',
    rows: [
      { key: 'language', kind: 'choice', label: 'LANGUAGE', desc: 'Choose the game display language', options: LANGUAGE_CHOICES },
      { key: 'muted', kind: 'toggle', label: 'MUTE ALL', desc: 'Silence every audio channel' },
      { key: 'master', kind: 'volume', label: 'MASTER VOLUME', desc: 'Overall game volume' },
      { key: 'musicEnabled', kind: 'toggle', label: 'BACKGROUND MUSIC', desc: 'Enable the soundtrack' },
      { key: 'music', kind: 'volume', label: 'MUSIC VOLUME', desc: 'Soundtrack level' },
      { key: 'menuBgm', kind: 'choice', label: 'MENU BGM', desc: 'Random picks one track when entering the menus', options: localizeBgmChoices(MENU_BGM_CHOICES, { random: 'Random' }) },
      { key: 'raceBgm', kind: 'choice', label: 'RACE BGM', desc: 'Default follows the track; Random picks one per race', options: localizeBgmChoices(RACE_BGM_CHOICES, { random: 'Random', defaultByTrack: 'Default (By Track)' }) },
      { key: 'sfx', kind: 'volume', label: 'SFX VOLUME', desc: 'Engines, items and interface sounds' },
    ],
    reset: 'RESET TO DEFAULTS', back: 'BACK',
    hint: 'Up / Down to select · Left / Right to adjust · Esc to go back',
  },
  help: {
    heading: 'HELP',
    tabs: [{ value: 'controls', label: 'CONTROLS' }, { value: 'items', label: 'ITEMS' }, { value: 'gameplay', label: 'GAMEPLAY' }],
    back: 'BACK', hint: 'Left / Right changes tab · Up / Down scrolls · Esc goes back',
    controls: [
      { title: 'KEYBOARD', rows: [['Steer', 'A / D or ← / →'], ['Accelerate', 'W or ↑'], ['Brake / Reverse', 'S or ↓'], ['Hop / Drift', 'Space or Shift'], ['Use Item', 'Ctrl, E or Enter'], ['Look Back', 'R'], ['Live Standings', 'Hold Tab'], ['Pause / Back', 'Esc'], ['Mute', 'M']] },
      { title: 'GAMEPAD', rows: [['Steer', 'Left Stick / D-pad'], ['Accelerate', 'RT or A'], ['Brake / Reverse', 'LT or B'], ['Hop / Drift', 'RB or X'], ['Use Item', 'LB or Y'], ['Look Back', 'Right Stick Down'], ['Pause', 'Start'], ['Menu Back', 'B']] },
      { title: 'TOUCH', rows: [['Accelerate', 'Automatic'], ['Steer', 'Drag in the left side of the screen'], ['Hop / Drift', 'Drift button'], ['Use Item', 'Item button']] },
    ],
    itemOrder: HELP_ITEM_IDS,
    itemDescriptions: {
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
    },
    gameplay: [
      { icon: '🏆', title: 'FINISH FIRST', text: 'Eight racers compete over the track\'s required lap count. Cross the final line ahead of the pack.' },
      { icon: '🚦', title: 'ROCKET START', text: 'Press accelerate just before GO for an opening boost. Holding it too early causes a jump-start penalty.' },
      { icon: '🌀', title: 'DRIFT BOOSTS', text: 'Hop while steering and keep drifting. Release after blue, orange or purple sparks for increasingly stronger boosts.' },
      { icon: '🎁', title: 'ITEM BOXES', text: 'Drive through item boxes to start the roulette. Racers farther behind receive stronger comeback items.' },
      { icon: '⚡', title: 'KEEP YOUR SPEED', text: 'Hit boost pads, chain drift boosts and follow rivals closely to charge a slipstream boost.' },
      { icon: '👀', title: 'USE ITEMS SMARTLY', text: 'Look backward while using shells or Bob-ombs to defend your position from racers behind.' },
    ],
  },
  hud: {
    lap: 'LAP', time: 'TIME', best: 'BEST', wrongWay: 'WRONG WAY ⚠', liveStandings: 'LIVE STANDINGS',
    standingsHead: ['POS', 'RACER', 'LAP', 'STATUS'], holdTab: 'HOLD TAB', go: 'GO!', finalLap: 'FINAL LAP!',
    finished: 'FINISHED! {place}', waitingFinish: 'WAITING FOR OTHER RACERS TO FINISH...', loadingRace: 'LOADING RACE...',
    statuses: { left: 'LEFT ROOM', disconnected: 'DISCONNECTED', reconnecting: 'RECONNECTING', finished: 'FINISHED', takeover: 'AI TAKE OVER', ai: 'AI RACER', ready: 'READY', racing: 'RACING' },
  },
  network: {
    states: { connected: 'CONNECTED', connecting: 'CONNECTING', reconnecting: 'RECONNECTING', disconnected: 'OFFLINE', error: 'ERROR' },
    onlinePlayers: 'ONLINE PLAYERS {count}', onlinePlayersUnknown: 'ONLINE PLAYERS —', version: 'VERSION {version}', versionUnknown: 'VERSION —',
  },
  main: {
    sessionReplaced: 'This room session was resumed in another window.', reconnectExpired: 'The reconnect window expired. Join the room again.',
    unableStartOnlineRace: 'Unable to start the online race.',
    preparingResources: 'PREPARING LOCAL RESOURCES', playersLoaded: '{loaded}/{total} PLAYERS LOADED', buildingRace: 'BUILDING RACE...',
    waitingConnection: 'WAITING FOR CONNECTION...', syncingRace: 'SYNCING RACE...', warmingGpu: 'WARMING UP GPU...', preparingFrame: 'PREPARING FIRST FRAME...',
  },
  online: {
    pageActions: { label: 'Page actions', settings: 'SETTINGS', help: 'HELP' },
    alerts: { genericTitle: 'ONLINE REQUEST FAILED', joinTitle: 'UNABLE TO JOIN ROOM', createTitle: 'UNABLE TO CREATE ROOM', quickTitle: 'QUICK START UNAVAILABLE', roomTitle: 'ROOM ACTION FAILED', connectionTitle: 'CONNECTION PROBLEM', reconnectExpiredTitle: 'RECONNECTION FAILED', updateRequiredTitle: 'GAME UPDATE REQUIRED', kickedTitle: 'REMOVED FROM ROOM', dismiss: 'OK', cancel: 'CANCEL', returnLobby: 'RETURN TO LOBBY', refreshPage: 'REFRESH PAGE' },
    connection: { connecting: 'CONNECTING', connected: 'ONLINE', reconnecting: 'RECONNECTING', disconnected: 'OFFLINE', error: 'CONNECTION ERROR' },
    lobby: {
      heading: 'MULTIPLAYER LOBBY', back: 'BACK', playerSetup: 'Player setup', nickname: 'NICKNAME', nicknamePlaceholder: 'Enter your racer name', quickMatch: 'QUICK START', createRoom: 'CREATE ROOM', roomList: 'AVAILABLE ROOMS', search: 'Search rooms', searchPlaceholder: 'Search room, track, host, or code', newRoom: 'NEW ROOM', roomName: 'ROOM NAME', roomNamePlaceholder: 'Enter a room name', defaultRoomName: 'Competition Room', unnamedRoom: 'Unnamed Room', unknownHost: 'Unknown racer', roomType: 'ROOM TYPE', publicRoom: 'Public - no password', privateRoom: 'Private - password required', maxPlayers: 'PLAYER LIMIT', track: 'TRACK', password: 'PASSWORD', passwordPlaceholder: '3-20 characters', passwordHelp: 'Passwords are case-sensitive.', enterPassword: 'Enter the room password', publicBadge: 'PUBLIC', privateBadge: 'PRIVATE', passwordRequired: 'Password required', noPasswordRequired: 'No password required', privateRoomHeading: 'PRIVATE ROOM', joinRoom: 'JOIN ROOM', players: 'PLAYERS', host: 'HOST', statusLabel: 'Status', status: { waiting: 'WAITING', full: 'FULL', in_game: 'IN GAME' }, join: 'JOIN', create: 'CREATE', cancel: 'CANCEL', close: 'Close dialog', roomFull: 'This room is full.', roomInGame: 'This room is already racing.', noRooms: 'No rooms are available yet', noRoomsHint: 'Create a room or wait for another racer to open one.', noSearchResults: 'No rooms match your search', tryAnotherSearch: 'Try a room name, host nickname, or six-character code.', roomCount: '{count} rooms online', searchCount: '{count} matching rooms', inviteLocated: 'Invite found: {roomName}', inviteMissing: 'Room {roomCode} is not currently available.',
    },
    room: {
      unnamedRoom: 'ONLINE ROOM', back: 'BACK', copyInvite: 'Copy invite link', copied: 'INVITE LINK COPIED', copyFallback: 'INVITE LINK COPIED', copyFailed: 'The invite link could not be copied. Please try again.', publicRoom: 'PUBLIC', privateRoom: 'PRIVATE', playerCount: '{count}/{max} RACERS', racers: 'RACERS', chooseRacer: 'CHOOSE YOUR KART', yourRacer: 'YOUR RACER', customize: 'CUSTOMIZE', customizeRacer: 'CUSTOMIZE RACER', loadoutEyebrow: 'YOUR LOOK', racerTab: 'KART', paintTab: 'PAINT', avatarTab: 'AVATAR', save: 'SAVE', cancel: 'CANCEL', close: 'Close customization', raceSetup: 'RACE SETUP', track: 'TRACK', difficulty: 'AI DIFFICULTY', autoFillAi: 'AUTO-FILL OPEN SLOTS WITH AI', autoFillAiHelp: 'When the race starts, AI racers fill the remaining room slots.', hostControls: 'You are the host. Setup changes reset everyone\'s ready state.', hostOnly: 'Only the host can change the race setup.', openSlot: 'Open slot', choosing: 'Choosing kart…', taken: 'TAKEN', you: 'YOU', host: 'HOST', ready: 'READY', notReady: 'NOT READY', inGame: 'IN GAME', offline: 'OFFLINE', reconnecting: 'RECONNECTING', reconnectingHint: 'Connection lost. This seat is reserved while the racer reconnects.', kickPlayer: 'Remove {name} from the room', kickTitle: 'REMOVE RACER?', kickMessage: 'Remove {name} from this room?', kickConfirm: 'REMOVE', kickedMessage: 'You were removed from the room by the host.', restoringSession: 'Restoring your room session...', leave: 'LEAVE ROOM', readyUp: 'READY UP', cancelReady: 'CANCEL READY', start: 'START RACE', loading: 'Loading the race…', waitingForRacer: 'Waiting for at least one more racer', waitingForReconnect: 'Waiting for {name} to reconnect.', waitingForReconnectCount: 'Waiting for {count} racers to reconnect.', readyCount: '{ready} / {total} racers ready', readyToStart: 'Everyone is ready — start the race!', waitingForHost: 'Everyone is ready — waiting for the host', phase: { loading: 'Loading the race…', countdown: 'The race is starting…', racing: 'Race in progress.', results: 'Waiting for racers to return to the room.' },
    },
    results: { official: 'OFFICIAL RESULTS', heading: 'RACE COMPLETE', place: 'Place', racer: 'Racer', time: 'Time', bestLap: 'Best Lap', returnRoom: 'RETURN TO ROOM', returnHint: 'Return to the room when you are ready.', autoReturn: 'Returning to the room automatically in {seconds}s.' },
    errors: {
      nickname: 'Enter a nickname before going online.', roomCode: 'Enter a valid 6-character room code.', INVALID_JSON: 'The server received invalid data.', INVALID_MESSAGE: 'The online request was invalid.', UNSUPPORTED_VERSION: 'This game version is not supported. Refresh the page.', UNKNOWN_MESSAGE: 'The server did not recognize that request.', NOT_IN_ROOM: 'You are no longer in this room.', ALREADY_IN_ROOM: 'You are already in a room.', ROOM_CODE_INVALID: 'The invite link has an invalid room code. Room codes must be exactly 6 valid characters.', ROOM_NOT_FOUND: 'That room is no longer available.', ROOM_FULL: 'That room is full.', ROOM_LOCKED: 'That room cannot be joined while a race is in progress.', ROOM_NAME_INVALID: 'Enter a room name between 1 and 32 characters.', ROOM_TYPE_INVALID: 'Choose a valid room type.', ROOM_CAPACITY_INVALID: 'Choose a player limit between 2 and 8.', PASSWORD_REQUIRED: 'Enter a case-sensitive password between 3 and 20 characters.', PASSWORD_INVALID: 'That room password is incorrect.', NO_MATCHING_ROOM: 'No joinable public room is available right now.', NAME_INVALID: 'Enter a nickname between 1 and 20 characters.', CHARACTER_INVALID: 'Choose a valid kart.', CHARACTER_LOCKED: 'That kart is not unlocked yet.', CHARACTER_TAKEN: 'That kart is already selected.', PAINT_INVALID: 'Choose a valid paint theme.', AVATAR_INVALID: 'Choose a valid avatar.', FORBIDDEN: 'You do not have permission to do that.', INVALID_STATE: 'That action is not available right now.', INVALID_SETTING: 'Choose a valid room setting.', NOT_READY: 'Every connected racer must be ready.', NOT_ENOUGH_PLAYERS: 'At least two racers are required to start.', SESSION_NOT_FOUND: 'That room session could not be restored.', SESSION_EXPIRED: 'The reconnect window expired. Join the room again.', RACE_MISMATCH: 'The race session is no longer current.', RATE_LIMITED: 'Too many requests. Please wait and try again.', SERVER_BUSY: 'The server is busy. Please try again shortly.', CLIENT_UPDATE_REQUIRED: 'The game was updated. Refresh the page to continue.', INTERNAL_ERROR: 'The server encountered an error. Please try again.', generic: 'Something went wrong. Please try again.',
    },
  },
};

const ZH_COPY = {
  common: {
    on: '开启', off: '关闭', percent: '百分之 {value}', previous: '上一个{label}', next: '下一个{label}',
    lockedAria: '{name}，尚未解锁，敬请期待', comingSoon: '敬请期待',
    weights: { light: '轻型', medium: '中型', heavy: '重型' },
    stats: { speed: '速度', accel: '加速', handling: '操控', weight: '重量' },
    laps: '{count} 圈', you: '你', dnf: 'DNF', racerFallback: '车手 {rank}', aiPlayer: 'AI玩家', max: ' 极限+',
  },
  document: {
    finishSkip: 'ENTER / A  ·  跳过', finishSkipTouch: '跳过', finishSkipAria: '跳过终点动画',
    steer: '转向', steerAria: '左右拖动进行转向', controlsAria: '比赛控制', pauseAria: '暂停比赛',
    item: '道具', itemAria: '使用道具', brake: '刹车', brakeAria: '刹车或倒车', drift: '漂移', driftAria: '漂移',
    noscript: 'Turbo Legends 需要启用 JavaScript。',
  },
  title: {
    heading: '主菜单', tagline: 'START YOUR ENGINES',
    items: [
      { value: 'single', icon: '🏁', label: '单人游戏', desc: '与 7 名 AI 车手竞速' },
      { value: 'multiplayer', icon: '🌐', label: '多人在线', desc: '浏览公开或私人在线房间' },
      { value: 'settings', icon: '⚙️', label: '游戏设置', desc: '调整声音与游戏选项' },
      { value: 'help', icon: '📖', label: '游戏帮助', desc: '查看操作、道具与竞速技巧' },
    ],
    hint: '方向键 / WASD 导航 · Enter 确认 · M 静音', multiplayerToast: '正在进入多人在线',
  },
  character: { heading: '选择你的赛车', hint: '方向键浏览 · Enter 选择 · Esc 返回' },
  track: { heading: '选择赛道', hint: 'Enter 选择 · Esc 返回' },
  difficulty: {
    heading: '难度', hint: 'Enter 开始比赛 · Esc 返回', labels: { easy: '简单', normal: '普通', hard: '困难' },
    flavor: {
      easy: { icon: '☀️', desc: '对手较轻松，道具更温和。享受一场阳光兜风。' },
      normal: { icon: '🏁', desc: '标准竞速体验。对手会全力反击，你也一样。' },
      hard: { icon: '🔥', desc: '强悍 AI 与最大追赶强度。记得准备蘑菇。' },
    },
  },
  pause: { heading: '已暂停', items: [['resume', '继续比赛'], ['settings', '游戏设置'], ['help', '游戏帮助'], ['restart', '重新开始'], ['quit', '返回主菜单']] },
  results: { heading: '比赛结果', racer: '车手', time: '用时', bestLap: '最佳圈速', continue: '按 Enter 继续' },
  settings: {
    heading: '游戏设置',
    rows: [
      { key: 'language', kind: 'choice', label: '语言', desc: '选择游戏界面的显示语言', options: LANGUAGE_CHOICES },
      { key: 'muted', kind: 'toggle', label: '全部静音', desc: '关闭所有声音' },
      { key: 'master', kind: 'volume', label: '主音量', desc: '调整游戏整体音量' },
      { key: 'musicEnabled', kind: 'toggle', label: '背景音乐', desc: '开启游戏音乐' },
      { key: 'music', kind: 'volume', label: '音乐音量', desc: '调整背景音乐音量' },
      { key: 'menuBgm', kind: 'choice', label: '菜单音乐', desc: '随机会在进入菜单时选择一首音乐', options: localizeBgmChoices(MENU_BGM_CHOICES, { random: '随机' }) },
      { key: 'raceBgm', kind: 'choice', label: '比赛音乐', desc: '默认跟随赛道；随机会为每场比赛选择音乐', options: localizeBgmChoices(RACE_BGM_CHOICES, { random: '随机', defaultByTrack: '默认（跟随赛道）' }) },
      { key: 'sfx', kind: 'volume', label: '音效音量', desc: '调整引擎、道具和界面音效' },
    ],
    reset: '恢复默认设置', back: '返回', hint: '上 / 下选择 · 左 / 右调整 · Esc 返回',
  },
  help: {
    heading: '游戏帮助', tabs: [{ value: 'controls', label: '操作' }, { value: 'items', label: '道具' }, { value: 'gameplay', label: '玩法' }],
    back: '返回', hint: '左 / 右切换分页 · 上 / 下滚动 · Esc 返回',
    controls: [
      { title: '键盘', rows: [['转向', 'A / D 或 ← / →'], ['加速', 'W 或 ↑'], ['刹车 / 倒车', 'S 或 ↓'], ['跳跃 / 漂移', 'Space 或 Shift'], ['使用道具', 'Ctrl、E 或 Enter'], ['向后看', 'R'], ['实时排名', '按住 Tab'], ['暂停 / 返回', 'Esc'], ['静音', 'M']] },
      { title: '手柄', rows: [['转向', '左摇杆 / 十字键'], ['加速', 'RT 或 A'], ['刹车 / 倒车', 'LT 或 B'], ['跳跃 / 漂移', 'RB 或 X'], ['使用道具', 'LB 或 Y'], ['向后看', '右摇杆向下'], ['暂停', 'Start'], ['菜单返回', 'B']] },
      { title: '触屏', rows: [['加速', '自动'], ['转向', '在屏幕左侧拖动'], ['跳跃 / 漂移', '漂移按钮'], ['使用道具', '道具按钮']] },
    ],
    itemOrder: HELP_ITEM_IDS,
    itemDescriptions: {
      [ITEM.BANANA]: '丢在赛车后方，命中的下一名车手会失控打滑。',
      [ITEM.GREEN_SHELL]: '沿直线前进并从墙面反弹。按住向后看可向后发射。',
      [ITEM.RED_SHELL]: '追踪前方最近的车手。按住向后看可改为向后发射。',
      [ITEM.BLUE_SHELL]: '追击领先车手，并在第一名附近产生大范围爆炸。',
      [ITEM.MUSHROOM]: '提供强力加速，可用于超车或快速穿过崎岖路面。',
      [ITEM.TRIPLE_MUSHROOM]: '一次获得三次可分别使用的蘑菇加速。',
      [ITEM.BOMB]: '向前投掷并在落地后爆炸。按住向后看可把它放在赛车后方。',
      [ITEM.STAR]: '暂时提升速度、获得无敌效果，并能撞开对手。',
      [ITEM.LIGHTNING]: '缩小并减速当前位于你前方的所有对手。',
      [ITEM.BULLET]: '把赛车变为高速自动驾驶状态，快速冲过车群。',
    },
    gameplay: [
      { icon: '🏆', title: '争夺第一', text: '八名车手将在规定圈数内竞速。领先所有对手冲过最终终点线。' },
      { icon: '🚦', title: '火箭起步', text: '在 GO 出现前一刻按下加速可获得起步加速。过早按住会受到抢跑惩罚。' },
      { icon: '🌀', title: '漂移加速', text: '转向时跳跃并保持漂移。在蓝色、橙色或紫色火花出现后松开，可获得逐级增强的加速。' },
      { icon: '🎁', title: '道具箱', text: '驶过道具箱开始抽取道具。排名越靠后的车手越容易得到强力追赶道具。' },
      { icon: '⚡', title: '保持速度', text: '利用加速带、连续漂移加速，并紧跟对手积累尾流加速。' },
      { icon: '👀', title: '聪明使用道具', text: '使用龟壳或炸弹时向后观察，可以防御来自后方车手的攻击。' },
    ],
  },
  hud: {
    lap: '圈数', time: '用时', best: '最佳', wrongWay: '方向错误 ⚠', liveStandings: '实时排名',
    standingsHead: ['名次', '车手', '圈数', '状态'], holdTab: '按住 TAB', go: '出发！', finalLap: '最后一圈！',
    finished: '完成比赛！{place}', waitingFinish: '正在等待其他车手完成比赛…', loadingRace: '正在加载比赛…',
    statuses: { left: '已离开房间', disconnected: '已断线', reconnecting: '重连中', finished: '已完赛', takeover: 'AI 接管', ai: 'AI 车手', ready: '准备完成', racing: '比赛中' },
  },
  network: {
    states: { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '离线', error: '连接错误' },
    onlinePlayers: '在线玩家 {count}', onlinePlayersUnknown: '在线玩家 —', version: '版本 {version}', versionUnknown: '版本 —',
  },
  main: {
    sessionReplaced: '此房间会话已在另一个窗口中恢复。', reconnectExpired: '重连时限已结束，请重新加入房间。',
    unableStartOnlineRace: '无法开始在线比赛。',
    preparingResources: '正在准备本地资源', playersLoaded: '已加载 {loaded}/{total} 名玩家', buildingRace: '正在构建比赛…',
    waitingConnection: '正在等待连接…', syncingRace: '正在同步比赛…', warmingGpu: '正在预热图形资源…', preparingFrame: '正在准备首帧画面…',
  },
  online: {
    pageActions: { label: '页面操作', settings: '游戏设置', help: '游戏帮助' },
    alerts: { genericTitle: '在线请求失败', joinTitle: '无法加入房间', createTitle: '无法创建房间', quickTitle: '快速开始不可用', roomTitle: '房间操作失败', connectionTitle: '连接出现问题', reconnectExpiredTitle: '重新连接失败', updateRequiredTitle: '需要更新游戏', kickedTitle: '已被移出房间', dismiss: '确定', cancel: '取消', returnLobby: '返回大厅', refreshPage: '刷新页面' },
    connection: { connecting: '连接中', connected: '在线', reconnecting: '重连中', disconnected: '离线', error: '连接错误' },
    lobby: {
      heading: '多人在线大厅', back: '返回', playerSetup: '玩家设置', nickname: '昵称', nicknamePlaceholder: '输入你的车手昵称', quickMatch: '快速开始', createRoom: '创建房间', roomList: '可加入的房间', search: '搜索房间', searchPlaceholder: '搜索房间、赛道、房主或房间码', newRoom: '新建房间', roomName: '房间名称', roomNamePlaceholder: '输入房间名称', defaultRoomName: '竞速房间', unnamedRoom: '未命名房间', unknownHost: '未知车手', roomType: '房间类型', publicRoom: '公开房间 - 无需密码', privateRoom: '私人房间 - 需要密码', maxPlayers: '玩家上限', track: '赛道', password: '密码', passwordPlaceholder: '3-20 个字符', passwordHelp: '密码区分大小写。', enterPassword: '输入房间密码', publicBadge: '公开', privateBadge: '私人', passwordRequired: '需要密码', noPasswordRequired: '无需密码', privateRoomHeading: '私人房间', joinRoom: '加入房间', players: '玩家', host: '房主', statusLabel: '状态', status: { waiting: '等待中', full: '已满', in_game: '比赛中' }, join: '加入', create: '创建', cancel: '取消', close: '关闭对话框', roomFull: '该房间人数已满。', roomInGame: '该房间正在比赛。', noRooms: '暂时没有可用房间', noRoomsHint: '创建一个房间，或等待其他车手开放房间。', noSearchResults: '没有符合搜索条件的房间', tryAnotherSearch: '尝试搜索房间名、房主昵称或六位房间码。', roomCount: '当前有 {count} 个房间', searchCount: '找到 {count} 个房间', inviteLocated: '已找到邀请房间：{roomName}', inviteMissing: '房间 {roomCode} 当前不可用。',
    },
    room: {
      unnamedRoom: '在线房间', back: '返回', copyInvite: '复制邀请链接', copied: '邀请链接已复制', copyFallback: '邀请链接已复制', copyFailed: '无法复制邀请链接，请重试。', publicRoom: '公开', privateRoom: '私人', playerCount: '{count}/{max} 名车手', racers: '车手', chooseRacer: '选择你的赛车', yourRacer: '你的车手', customize: '自定义', customizeRacer: '自定义车手', loadoutEyebrow: '你的外观', racerTab: '赛车', paintTab: '涂装', avatarTab: '头像', save: '保存', cancel: '取消', close: '关闭自定义窗口', raceSetup: '比赛设置', track: '赛道', difficulty: 'AI 难度', autoFillAi: '使用 AI 填补空位', autoFillAiHelp: '比赛开始时，AI 车手会填补房间中的剩余空位。', hostControls: '你是房主。修改比赛设置会重置所有人的准备状态。', hostOnly: '只有房主可以修改比赛设置。', openSlot: '空位', choosing: '正在选择赛车…', taken: '已选择', you: '你', host: '房主', ready: '已准备', notReady: '未准备', inGame: '比赛中', offline: '离线', reconnecting: '重连中', reconnectingHint: '连接已中断，重连期间会为该车手保留席位。', kickPlayer: '将 {name} 移出房间', kickTitle: '移出车手？', kickMessage: '确定要将 {name} 移出房间吗？', kickConfirm: '移出', kickedMessage: '房主已将你移出房间。', restoringSession: '正在恢复房间会话…', leave: '离开房间', readyUp: '准备', cancelReady: '取消准备', start: '开始比赛', loading: '正在加载比赛…', waitingForRacer: '正在等待至少一名车手加入', waitingForReconnect: '正在等待 {name} 重新连接。', waitingForReconnectCount: '正在等待 {count} 名车手重新连接。', readyCount: '{ready} / {total} 名车手已准备', readyToStart: '所有人都已准备，可以开始比赛！', waitingForHost: '所有人都已准备，正在等待房主', phase: { loading: '正在加载比赛…', countdown: '比赛即将开始…', racing: '比赛正在进行。', results: '正在等待车手返回房间。' },
    },
    results: { official: '官方结果', heading: '比赛完成', place: '名次', racer: '车手', time: '用时', bestLap: '最佳圈速', returnRoom: '返回房间', returnHint: '准备好后返回房间。', autoReturn: '{seconds} 秒后自动返回房间。' },
    errors: {
      nickname: '请输入昵称后再进入多人在线。', roomCode: '请输入有效的六位房间码。', INVALID_JSON: '服务器收到了无效数据。', INVALID_MESSAGE: '在线请求无效。', UNSUPPORTED_VERSION: '当前游戏版本不受支持，请刷新页面。', UNKNOWN_MESSAGE: '服务器无法识别该请求。', NOT_IN_ROOM: '你已不在该房间中。', ALREADY_IN_ROOM: '你已经加入了一个房间。', ROOM_CODE_INVALID: '邀请链接中的房间码无效，房间码必须是六位有效字符。', ROOM_NOT_FOUND: '该房间已不可用。', ROOM_FULL: '该房间人数已满。', ROOM_LOCKED: '比赛进行期间无法加入该房间。', ROOM_NAME_INVALID: '请输入 1 到 32 个字符的房间名称。', ROOM_TYPE_INVALID: '请选择有效的房间类型。', ROOM_CAPACITY_INVALID: '请选择 2 到 8 人的玩家上限。', PASSWORD_REQUIRED: '请输入 3 到 20 个字符且区分大小写的密码。', PASSWORD_INVALID: '房间密码不正确。', NO_MATCHING_ROOM: '当前没有可加入的公开房间。', NAME_INVALID: '请输入 1 到 20 个字符的昵称。', CHARACTER_INVALID: '请选择有效的赛车。', CHARACTER_LOCKED: '该赛车尚未解锁。', CHARACTER_TAKEN: '该赛车已被选择。', PAINT_INVALID: '请选择有效的涂装。', AVATAR_INVALID: '请选择有效的头像。', FORBIDDEN: '你没有权限执行该操作。', INVALID_STATE: '当前无法执行该操作。', INVALID_SETTING: '请选择有效的房间设置。', NOT_READY: '所有已连接车手都必须准备完成。', NOT_ENOUGH_PLAYERS: '至少需要两名车手才能开始比赛。', SESSION_NOT_FOUND: '无法恢复该房间会话。', SESSION_EXPIRED: '重连时限已结束，请重新加入房间。', RACE_MISMATCH: '该比赛会话已失效。', RATE_LIMITED: '请求过于频繁，请稍后再试。', SERVER_BUSY: '服务器繁忙，请稍后重试。', CLIENT_UPDATE_REQUIRED: '游戏已更新，请刷新页面后继续。', INTERNAL_ERROR: '服务器出现错误，请重试。', generic: '出现了问题，请重试。',
    },
  },
};

const ENTITY_COPY = deepFreeze({
  en: {
    characters: {}, tracks: {}, paints: {}, avatars: {},
    items: {
      [ITEM.BANANA]: 'Banana', [ITEM.GREEN_SHELL]: 'Green Shell', [ITEM.RED_SHELL]: 'Red Shell',
      [ITEM.MUSHROOM]: 'Mushroom', [ITEM.TRIPLE_MUSHROOM]: 'Triple Mushroom', [ITEM.BOMB]: 'Bob-omb',
      [ITEM.STAR]: 'Star', [ITEM.LIGHTNING]: 'Lightning', [ITEM.BULLET]: 'Bullet Bill', [ITEM.BLUE_SHELL]: 'Spiny Shell',
    },
  },
  'zh-CN': {
    characters: {
      pip: '低矮的赛博机械，为冷酷无情的直线极速而生。', nova: '糖果涂装的轻量赛车，起步迅猛、转向灵敏。',
      kit: '开放式车轮带来精准操控：速度快、转向锐利，但碰撞容错较低。', roscoe: '水晶推进系统带来爆发式起步，同时拥有极轻的车身。',
      mirage: '钢制防滚架、长行程悬挂和足以赢下碰撞的重量。', brick: '一辆为快速恢复和精准过弯调校的轻型经典赛车。',
      tundra: '机密低温驱动原型车，性能预计将突破当前抓地极限。', gearbox: '尚未发布的动力单元，速度和冲击力足以打破联赛规则。',
    },
    tracks: {
      'sunset-circuit': '节奏明快的入门赛道，包含两个发卡弯和一条带加速的后直道。',
      'harbor-loop': '狭窄的码头弯道，注意起重机旁的减速弯。',
      'summit-raceway': '一路攀升的雄心之路，拥有长距离漂移和大落差路段。',
      'aurora-icefall': '穿越蓝冰隧道、镜湖折返弯，以及横跨自身赛道的空中桥梁。',
      'monaco-gp': '标志性的 F1 街道赛道，包含狭窄发卡弯、港湾游艇、赌场广场与幽暗隧道。',
      'metropolis-highway': '穿梭于高架道路、玻璃摩天楼和流畅的城市直道。',
    },
    paints: {
      'turbo-blue': '极速蓝', 'sunset-pop': '落日流行', 'mint-rush': '薄荷冲刺', 'orange-flare': '橙色烈焰',
      'solar-gold': '太阳金', 'violet-volt': '紫罗兰电光', 'ice-cyan': '冰晶青', 'crimson-heat': '绯红热浪',
      'lime-strike': '青柠突击', 'midnight-neon': '午夜霓虹', 'pearl-flash': '珍珠闪光', 'graphite-gold': '石墨金',
    },
    avatars: { cat: '猫', dog: '狗', rabbit: '兔子', fox: '狐狸', bear: '熊', panda: '熊猫', tiger: '老虎', raccoon: '浣熊' },
    items: {
      [ITEM.BANANA]: '香蕉皮', [ITEM.GREEN_SHELL]: '绿龟壳', [ITEM.RED_SHELL]: '红龟壳',
      [ITEM.MUSHROOM]: '蘑菇', [ITEM.TRIPLE_MUSHROOM]: '三重蘑菇', [ITEM.BOMB]: '炸弹',
      [ITEM.STAR]: '无敌星', [ITEM.LIGHTNING]: '闪电', [ITEM.BULLET]: '炮弹', [ITEM.BLUE_SHELL]: '蓝刺龟壳',
    },
  },
});

const COPY_BY_LANGUAGE = deepFreeze({ en: EN_COPY, 'zh-CN': ZH_COPY });

export function sanitizeLanguage(value) {
  return SUPPORTED_LANGUAGE_SET.has(value) ? value : DEFAULT_LANGUAGE;
}

export function getUiCopy(language = DEFAULT_LANGUAGE) {
  return COPY_BY_LANGUAGE[sanitizeLanguage(language)];
}

export function formatCopy(template, values = {}) {
  return String(template ?? '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ));
}

export function formatOrdinal(rank, language = DEFAULT_LANGUAGE) {
  const n = Math.max(1, Math.trunc(Number(rank) || 1));
  if (sanitizeLanguage(language) === 'zh-CN') return `第${n}名`;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

export function formatOrdinalParts(rank, language = DEFAULT_LANGUAGE) {
  const n = Math.max(1, Math.trunc(Number(rank) || 1));
  if (sanitizeLanguage(language) === 'zh-CN') return { prefix: '第', number: String(n), suffix: '名' };
  const value = formatOrdinal(n, language);
  return { prefix: '', number: String(n), suffix: value.slice(String(n).length) };
}

export function localizeCharacter(character, language = DEFAULT_LANGUAGE) {
  if (!character) return character;
  const blurb = ENTITY_COPY[sanitizeLanguage(language)].characters[character.id];
  return blurb ? { ...character, blurb } : character;
}

export function localizeTrack(track, language = DEFAULT_LANGUAGE) {
  if (!track) return track;
  const subtitle = ENTITY_COPY[sanitizeLanguage(language)].tracks[track.id];
  return subtitle ? { ...track, subtitle } : track;
}

export function localizePaint(paint, language = DEFAULT_LANGUAGE) {
  if (!paint) return paint;
  const name = ENTITY_COPY[sanitizeLanguage(language)].paints[paint.id];
  return name ? { ...paint, name } : paint;
}

export function localizeAvatar(avatar, language = DEFAULT_LANGUAGE) {
  if (!avatar) return avatar;
  const name = ENTITY_COPY[sanitizeLanguage(language)].avatars[avatar.id];
  return name ? { ...avatar, name } : avatar;
}

export function localizeDifficulty(key, preset, language = DEFAULT_LANGUAGE) {
  if (!preset) return preset;
  const label = getUiCopy(language).difficulty.labels[key];
  return label ? { ...preset, label } : preset;
}

export function localizeItem(itemId, info, language = DEFAULT_LANGUAGE) {
  if (!info) return info;
  const label = ENTITY_COPY[sanitizeLanguage(language)].items[itemId];
  return label ? { ...info, label } : info;
}

export function applyDocumentLanguage(doc = globalThis.document, language = DEFAULT_LANGUAGE) {
  if (!doc) return getUiCopy(language);
  const normalized = sanitizeLanguage(language);
  const copy = getUiCopy(normalized);
  if (doc.documentElement) doc.documentElement.lang = normalized;
  const setText = (selector, value) => {
    const node = doc.querySelector?.(selector);
    if (node) node.textContent = value;
  };
  const setAria = (selector, value) => doc.querySelector?.(selector)?.setAttribute?.('aria-label', value);
  setAria('#finish-cinematic-skip', copy.document.finishSkipAria);
  setText('.finish-skip-desktop', copy.document.finishSkip);
  setText('.finish-skip-touch', copy.document.finishSkipTouch);
  setAria('#touch-steer-zone', copy.document.steerAria);
  setText('.touch-steer-label', copy.document.steer);
  setAria('#touch-controls', copy.document.controlsAria);
  setAria('.btn-pause', copy.document.pauseAria);
  setAria('.btn-item', copy.document.itemAria);
  setText('.btn-item .touch-action-label', copy.document.item);
  setAria('.btn-brake', copy.document.brakeAria);
  setText('.btn-brake .touch-action-label', copy.document.brake);
  setAria('.btn-drift', copy.document.driftAria);
  setText('.btn-drift .touch-action-label', copy.document.drift);
  setText('.noscript-warning', copy.document.noscript);
  return copy;
}

// Backward-compatible default-language exports for presentation-only callers.
export const UI_COPY = getUiCopy();
export const HELP_CONTROLS = UI_COPY.help.controls;
export const HELP_ITEM_ORDER = UI_COPY.help.itemOrder;
export const HELP_ITEM_DESCRIPTIONS = UI_COPY.help.itemDescriptions;
export const HELP_GAMEPLAY = UI_COPY.help.gameplay;
