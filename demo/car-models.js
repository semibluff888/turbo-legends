import { getCharacter } from '../src/game/characters.js';
import { DEFAULT_ONLINE_LOADOUT } from '../src/game/appearance.js';
import { makeKartPreview } from '../src/render/kartMesh.js';
import {
  buildBreezeKart,
  buildCartoonAvatar,
  buildChibiCuteRacer,
  buildCyberHypercar,
  buildFormula1RealRacer,
  buildQuantumHoverRacer,
  buildRuggedOffroadBeast,
  disposeGroup,
} from '../src/render/racer-model-builders.js';

export {
  buildBreezeKart,
  buildCartoonAvatar,
  buildChibiCuteRacer,
  buildCyberHypercar,
  buildFormula1RealRacer,
  buildQuantumHoverRacer,
  buildRuggedOffroadBeast,
  disposeGroup,
};

// Demo-only wrapper for the legacy default kart shown as model 01.
export function buildDefaultKart(
  characterId = 'kit',
  loadout = DEFAULT_ONLINE_LOADOUT,
  nitroBoost = false,
) {
  // Keep model 01 as the original chunky kart even though the production
  // catalog now maps `kit` to the shared Formula Racer body.
  const character = { ...getCharacter(characterId), modelId: null };
  const preview = makeKartPreview(character, loadout);

  return {
    group: preview.group,
    id: 'default',
    name: '默认房间赛车 (Default Arcade Kart)',
    styleTag: '经典游戏样式',
    description: '多人游戏房间 CUSTOMIZE RACER 默认使用的高亮卡丁车模型，完全保留原始驾驶员与像素几何体结构。',
    specs: {
      风格类型: 'Chunky Toy Kart',
      驾驶员系统: '原始内置 Driver Mesh (不可开关)',
      网格组成: 'Three.js 原生基础几何体 (Box / Cylinder / Sphere)',
      悬挂结构: '固定轮轴无避震',
      氮气特效: nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
    },
    update(time) {
      preview.update?.(time, 0);
      preview.group.position.y = 0.03 + Math.sin(time * 2) * 0.015;
    },
    dispose() {
      preview.dispose();
    },
  };
}
