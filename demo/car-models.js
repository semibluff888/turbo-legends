import * as THREE from 'three';
import { getCharacter } from '../src/game/characters.js';
import { DEFAULT_ONLINE_LOADOUT, AVATARS_BY_ID } from '../src/game/appearance.js';
import { makeKartPreview } from '../src/render/kartMesh.js';

/** Helper to create standard Mesh */
function createMesh(geo, mat, parent, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(...pos);
  mesh.rotation.set(...rot);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (parent) parent.add(mesh);
  return mesh;
}

/** Helper to dispose hierarchy */
export function disposeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });
}

/** In-Game Style Boost Flame Generator (Dual-layer Additive Cones) */
function createInGameBoostFlame(parent, posX, posY, posZ, flameScale = 1.0) {
  const flame = new THREE.Group();
  flame.position.set(posX, posY, posZ);
  flame.rotation.x = -Math.PI / 2 + 0.15; // Cone apex pointing backward

  const flameOuterGeo = new THREE.ConeGeometry(0.13 * flameScale, 0.62 * flameScale, 10);
  flameOuterGeo.translate(0, 0.31 * flameScale, 0); // Base at origin so scaling stretches backward

  const flameInnerGeo = new THREE.ConeGeometry(0.075 * flameScale, 0.40 * flameScale, 8);
  flameInnerGeo.translate(0, 0.20 * flameScale, 0);

  const flameOuterMat = new THREE.MeshBasicMaterial({
    color: 0xffa63b,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const flameInnerMat = new THREE.MeshBasicMaterial({
    color: 0xfff3bd,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const outerMesh = new THREE.Mesh(flameOuterGeo, flameOuterMat);
  const innerMesh = new THREE.Mesh(flameInnerGeo, flameInnerMat);
  flame.add(outerMesh, innerMesh);
  flame.visible = false;
  parent.add(flame);

  return flame;
}

function updateInGameBoostFlame(flames, nitroBoost, time) {
  if (!flames || flames.length === 0) return;
  if (nitroBoost) {
    const pulse = 1 + 0.22 * Math.sin(time * 42) + 0.10 * Math.sin(time * 71 + 1.7);
    const len = 1.25 * pulse;
    flames.forEach((flame) => {
      flame.visible = true;
      flame.scale.set(pulse, len, pulse);
    });
  } else {
    flames.forEach((flame) => {
      flame.visible = false;
    });
  }
}

// ============================================================================
// REDESIGNED 8 CARTOON ANIMAL AVATARS BUILDER (PURE CHARACTER BODY, NO PROPS)
// ============================================================================
export function buildCartoonAvatar(avatarId = 'cat', scaleFactor = 1.0) {
  const group = new THREE.Group();
  group.scale.set(scaleFactor, scaleFactor, scaleFactor);

  const def = AVATARS_BY_ID[avatarId] || AVATARS_BY_ID.cat;

  // Shared Materials for this Avatar
  const headMat = new THREE.MeshStandardMaterial({ color: def.headColor, roughness: 0.6, metalness: 0.1 });
  const muzzleMat = new THREE.MeshStandardMaterial({ color: def.muzzleColor, roughness: 0.65, metalness: 0.0 });
  const detailMat = new THREE.MeshStandardMaterial({ color: def.detailColor, roughness: 0.5, metalness: 0.1 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x11131a, roughness: 0.2 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const pinkMat = new THREE.MeshStandardMaterial({ color: 0xff8faf, roughness: 0.5 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.6 });

  // 1. Pure Torso (No collar, no scarf, no harness, no props)
  const torsoGeo = new THREE.BoxGeometry(0.42, 0.36, 0.3);
  createMesh(torsoGeo, bodyMat, group, [0, 0.18, 0]);

  // Small Paws Holding Steering Wheel
  for (const side of [-1, 1]) {
    const armGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.25);
    createMesh(armGeo, bodyMat, group, [side * 0.22, 0.18, 0.12], [0.5, 0, side * -0.3]);
    const pawGeo = new THREE.SphereGeometry(0.06, 12, 12);
    createMesh(pawGeo, headMat, group, [side * 0.18, 0.22, 0.24]);
  }

  // 2. Pure Head Group (No goggles, no hats, no eye masks accessories)
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.48, 0);
  group.add(headGroup);

  // Base Head Sphere
  const headGeo = new THREE.SphereGeometry(0.28, 20, 20);
  headGeo.scale(1.05, 0.95, 1.0);
  createMesh(headGeo, headMat, headGroup);

  // Eyes with Cute Star Glints
  for (const side of [-1, 1]) {
    const eyeSocket = new THREE.Group();
    eyeSocket.position.set(side * 0.11, 0.04, 0.24);
    headGroup.add(eyeSocket);

    const eyeGeo = new THREE.SphereGeometry(0.045, 12, 12);
    eyeGeo.scale(1, 1.2, 0.5);
    createMesh(eyeGeo, eyeMat, eyeSocket);

    const glintGeo = new THREE.SphereGeometry(0.015, 8, 8);
    createMesh(glintGeo, whiteMat, eyeSocket, [0.012, 0.015, 0.02]);
  }

  // Snout / Muzzle Base (for standard animals)
  if (avatarId !== 'fox') {
    const muzzleGeo = new THREE.SphereGeometry(0.12, 16, 16);
    muzzleGeo.scale(1.1, 0.7, 0.7);
    createMesh(muzzleGeo, muzzleMat, headGroup, [0, -0.05, 0.22]);

    const noseGeo = new THREE.SphereGeometry(0.04, 10, 10);
    noseGeo.scale(1.1, 0.7, 0.7);
    createMesh(noseGeo, detailMat, headGroup, [0, -0.01, 0.28]);
  }

  // 3. ANIMAL-SPECIFIC FEATURES (PURE ANIMAL BODY & FUR PATTERNS)
  switch (avatarId) {
    case 'cat': {
      for (const side of [-1, 1]) {
        const earGeo = new THREE.ConeGeometry(0.1, 0.22, 4);
        const ear = createMesh(earGeo, headMat, headGroup, [side * 0.16, 0.26, 0], [0, Math.PI / 4, side * -0.15]);
        const innerEarGeo = new THREE.ConeGeometry(0.06, 0.16, 4);
        createMesh(innerEarGeo, pinkMat, ear, [0, -0.01, 0.02]);
      }
      for (const side of [-1, 1]) {
        for (const y of [-0.03, -0.07]) {
          const whiskerGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.16);
          createMesh(whiskerGeo, detailMat, headGroup, [side * 0.18, y, 0.22], [0, 0, Math.PI / 2 + side * 0.1]);
        }
      }
      break;
    }

    case 'dog': {
      for (const side of [-1, 1]) {
        const earGeo = new THREE.SphereGeometry(0.12, 12, 12);
        earGeo.scale(0.6, 1.4, 0.6);
        createMesh(earGeo, detailMat, headGroup, [side * 0.24, 0.08, 0.02], [0, 0, side * 0.3]);
      }
      const tongueGeo = new THREE.SphereGeometry(0.035, 10, 10);
      tongueGeo.scale(1, 0.5, 1.2);
      createMesh(tongueGeo, pinkMat, headGroup, [0, -0.08, 0.28]);
      break;
    }

    case 'rabbit': {
      for (const side of [-1, 1]) {
        const earGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.45, 12);
        const ear = createMesh(earGeo, headMat, headGroup, [side * 0.12, 0.42, -0.02], [0.1, 0, side * -0.12]);
        const innerGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.38, 12);
        createMesh(innerGeo, pinkMat, ear, [0, 0, 0.02]);
      }
      break;
    }

    case 'fox': {
      const foxRedMat = new THREE.MeshStandardMaterial({ color: 0xeb6123, roughness: 0.55 });
      const foxWhiteMat = new THREE.MeshStandardMaterial({ color: 0xfff8f0, roughness: 0.6 });
      const foxDarkMat = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.4 });

      for (const side of [-1, 1]) {
        const cheekPatchGeo = new THREE.SphereGeometry(0.15, 12, 12);
        cheekPatchGeo.scale(0.8, 0.7, 0.8);
        createMesh(cheekPatchGeo, foxWhiteMat, headGroup, [side * 0.18, -0.06, 0.16]);
      }

      const foxMuzzleGeo = new THREE.ConeGeometry(0.13, 0.28, 12);
      createMesh(foxMuzzleGeo, foxWhiteMat, headGroup, [0, -0.06, 0.28], [Math.PI / 2 + 0.1, 0, 0]);

      const foxNoseGeo = new THREE.SphereGeometry(0.038, 10, 10);
      createMesh(foxNoseGeo, foxDarkMat, headGroup, [0, -0.01, 0.39]);

      for (const side of [-1, 1]) {
        const earGroup = new THREE.Group();
        earGroup.position.set(side * 0.18, 0.26, 0);
        earGroup.rotation.set(0, Math.PI / 4, side * -0.2);
        headGroup.add(earGroup);

        const mainEarGeo = new THREE.ConeGeometry(0.13, 0.28, 4);
        createMesh(mainEarGeo, foxRedMat, earGroup);

        const tipGeo = new THREE.ConeGeometry(0.06, 0.1, 4);
        createMesh(tipGeo, foxDarkMat, earGroup, [0, 0.09, 0]);

        const tuftGeo = new THREE.ConeGeometry(0.075, 0.2, 4);
        createMesh(tuftGeo, foxWhiteMat, earGroup, [0, -0.02, 0.02]);
      }
      break;
    }

    case 'bear': {
      for (const side of [-1, 1]) {
        const earGeo = new THREE.SphereGeometry(0.1, 14, 14);
        earGeo.scale(1, 1, 0.6);
        createMesh(earGeo, headMat, headGroup, [side * 0.22, 0.22, 0]);
        const innerGeo = new THREE.SphereGeometry(0.06, 12, 12);
        createMesh(innerGeo, muzzleMat, headGroup, [side * 0.22, 0.22, 0.03]);
      }
      break;
    }

    case 'panda': {
      for (const side of [-1, 1]) {
        const patchGeo = new THREE.SphereGeometry(0.08, 12, 12);
        patchGeo.scale(1, 1.2, 0.4);
        createMesh(patchGeo, detailMat, headGroup, [side * 0.11, 0.04, 0.22], [0, 0, side * 0.2]);
        const earGeo = new THREE.SphereGeometry(0.09, 14, 14);
        earGeo.scale(1, 1, 0.6);
        createMesh(earGeo, detailMat, headGroup, [side * 0.22, 0.22, 0]);
      }
      break;
    }

    case 'tiger': {
      for (const side of [-1, 1]) {
        const earGeo = new THREE.SphereGeometry(0.09, 14, 14);
        createMesh(earGeo, headMat, headGroup, [side * 0.2, 0.22, 0]);
      }
      for (const [x, angle] of [[-0.08, -0.2], [0, 0], [0.08, 0.2]]) {
        const stripeGeo = new THREE.BoxGeometry(0.025, 0.1, 0.02);
        createMesh(stripeGeo, detailMat, headGroup, [x, 0.18, 0.24], [0, 0, angle]);
      }
      break;
    }

    case 'raccoon': {
      const maskGeo = new THREE.BoxGeometry(0.36, 0.12, 0.05);
      createMesh(maskGeo, detailMat, headGroup, [0, 0.04, 0.22]);
      for (const side of [-1, 1]) {
        const earGeo = new THREE.ConeGeometry(0.1, 0.2, 4);
        createMesh(earGeo, headMat, headGroup, [side * 0.18, 0.25, 0], [0, Math.PI / 4, side * -0.15]);
      }
      break;
    }
  }

  return {
    group,
    headGroup,
    update(time) {
      headGroup.rotation.z = Math.sin(time * 3) * 0.05;
      headGroup.rotation.x = Math.cos(time * 2) * 0.03;
    }
  };
}

// ============================================================================
// 1. DEFAULT ROOM MODEL (DEFAULT KART) - UNTOUCHED
// ============================================================================
export function buildDefaultKart(characterId = 'kit', loadout = DEFAULT_ONLINE_LOADOUT, nitroBoost = false) {
  const character = getCharacter(characterId);
  const preview = makeKartPreview(character, loadout);

  return {
    group: preview.group,
    id: 'default',
    name: '默认房间赛车 (Default Arcade Kart)',
    styleTag: '经典游戏样式',
    description: '多人游戏房间 CUSTOMIZE RACER 默认使用的高亮卡丁车模型，完全保留原始驾驶员与像素几何体结构。',
    specs: {
      '风格类型': 'Chunky Toy Kart',
      '驾驶员系统': '原始内置 Driver Mesh (不可开关)',
      '网格组成': 'Three.js 原生基础几何体 (Box / Cylinder / Sphere)',
      '悬挂结构': '固定轮轴无避震'
    },
    update(time, dt) {
      preview.group.position.y = 0.03 + Math.sin(time * 2) * 0.015;
    },
    dispose() {
      preview.dispose();
    }
  };
}

// ============================================================================
// 2. CYBER NEON HYPERCAR (赛博酷炫超跑)
// ============================================================================
export function buildCyberHypercar(primaryColor = 0x0f172a, accentColor = 0x00f0ff, avatarId = 'cat', showDriver = true, nitroBoost = false) {
  const group = new THREE.Group();

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({ color: primaryColor, roughness: 0.15, metalness: 0.9, envMapIntensity: 1.5 });
  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x111625, roughness: 0.4, metalness: 0.8 });
  const neonMat = new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 3.5, roughness: 0.2 });
  const neonMagentaMat = new THREE.MeshStandardMaterial({ color: 0xff007f, emissive: 0xff007f, emissiveIntensity: 4.0 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.35, roughness: 0.05, transmission: 0.9 });
  const cyberTireMat = new THREE.MeshStandardMaterial({ color: 0x090b10, roughness: 0.8, metalness: 0.2 });
  const titaniumMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.95, roughness: 0.2 });

  // Chassis Extrude
  const mainChassisShape = new THREE.Shape();
  mainChassisShape.moveTo(-0.65, -1.8);
  mainChassisShape.lineTo(-0.75, -0.4);
  mainChassisShape.lineTo(-0.85, 0.6);
  mainChassisShape.lineTo(-0.45, 1.8);
  mainChassisShape.lineTo(0, 2.1);
  mainChassisShape.lineTo(0.45, 1.8);
  mainChassisShape.lineTo(0.85, 0.6);
  mainChassisShape.lineTo(0.75, -0.4);
  mainChassisShape.lineTo(0.65, -1.8);
  mainChassisShape.closePath();

  const chassisGeo = new THREE.ExtrudeGeometry(mainChassisShape, { depth: 0.35, bevelEnabled: true, bevelSegments: 5, bevelSize: 0.08, bevelThickness: 0.08 });
  chassisGeo.center();
  createMesh(chassisGeo, bodyMat, group, [0, 0.38, 0], [Math.PI / 2, 0, 0]);

  // Front Splitter
  createMesh(new THREE.BoxGeometry(1.8, 0.06, 0.6), carbonMat, group, [0, 0.16, 1.85]);
  createMesh(new THREE.BoxGeometry(1.5, 0.04, 0.12), neonMat, group, [0, 0.22, 1.96]);

  // Side Air Vents
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.25, 0.35, 2.2), carbonMat, group, [side * 0.78, 0.36, -0.1], [0, side * 0.08, 0]);
    createMesh(new THREE.BoxGeometry(0.04, 0.05, 2.4), neonMat, group, [side * 0.92, 0.34, -0.1]);
  }

  // Ergonomic Racing Cockpit Seat & Yoke
  createMesh(new THREE.BoxGeometry(0.55, 0.65, 0.45), carbonMat, group, [0, 0.45, 0.0]);
  createMesh(new THREE.TorusGeometry(0.12, 0.02, 8, 16, Math.PI), neonMat, group, [0, 0.58, 0.35], [-0.3, 0, Math.PI]);

  // Driver Mount Point
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 0.95);
    avatarObj.group.position.set(0, 0.42, 0.05);
    group.add(avatarObj.group);
  }

  // Translucent Canopy
  const canopyGeo = new THREE.SphereGeometry(0.55, 16, 16);
  canopyGeo.scale(1.0, 0.65, 2.2);
  createMesh(canopyGeo, glassMat, group, [0, 0.62, 0.1]);

  // Quad Jet Exhaust Nozzles & In-Game Style Boost Flames
  const nitroFlames = [];
  const exhaustPositions = [-0.45, -0.18, 0.18, 0.45];

  exhaustPositions.forEach((x, i) => {
    createMesh(new THREE.CylinderGeometry(0.12, 0.15, 0.55, 6), titaniumMat, group, [x, 0.42, -1.82], [Math.PI / 2, 0, 0]);
    createMesh(new THREE.TorusGeometry(0.11, 0.02, 8, 16), i % 2 === 0 ? neonMat : neonMagentaMat, group, [x, 0.42, -1.85]);
    const flame = createInGameBoostFlame(group, x, 0.42, -2.10, 0.9);
    nitroFlames.push(flame);
  });

  // Rear Cyber Wing & Swan-Neck Carbon Pylons
  createMesh(new THREE.BoxGeometry(1.9, 0.05, 0.38), bodyMat, group, [0, 0.88, -1.75]);
  createMesh(new THREE.BoxGeometry(1.94, 0.06, 0.08), neonMat, group, [0, 0.88, -1.92]);

  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.06, 0.48, 0.28), carbonMat, group, [side * 0.52, 0.65, -1.65], [0.35, 0, 0]);
    createMesh(new THREE.BoxGeometry(0.1, 0.08, 0.32), titaniumMat, group, [side * 0.52, 0.44, -1.55]);
  }

  // Wheels
  const wheels = [];
  const wPositions = [[-0.92, 0.33, 1.25], [0.92, 0.33, 1.25], [-0.96, 0.36, -1.25], [0.96, 0.36, -1.25]];

  wPositions.forEach(([wx, wy, wz]) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx);

    createMesh(new THREE.CylinderGeometry(0.35, 0.35, 0.34, 32), cyberTireMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.TorusGeometry(0.345, 0.015, 8, 32), neonMat, wGroup, [outwardSign * 0.165, 0, 0], [0, Math.PI / 2, 0]);
    createMesh(new THREE.CylinderGeometry(0.25, 0.25, 0.35, 8), carbonMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    for (let b = 0; b < 6; b++) {
      const bladeGeo = new THREE.BoxGeometry(0.04, 0.22, 0.02);
      const bladeAngle = (b * Math.PI) / 3;
      createMesh(bladeGeo, titaniumMat, wGroup, [outwardSign * 0.17, Math.sin(bladeAngle) * 0.12, Math.cos(bladeAngle) * 0.12], [bladeAngle, 0, 0]);
    }

    createMesh(new THREE.TorusGeometry(0.14, 0.025, 8, 24), neonMagentaMat, wGroup, [outwardSign * 0.175, 0, 0], [0, Math.PI / 2, 0]);
    createMesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 20), titaniumMat, wGroup, [outwardSign * 0.02, 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.BoxGeometry(0.08, 0.14, 0.12), neonMat, wGroup, [outwardSign * 0.02, 0.16, 0]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'cyber',
    name: '赛博朋克超跑 (Cyber Neon Hypercar)',
    styleTag: '华丽酷炫风格',
    description: '配备双天鹅颈碳纤维尾翼支架、四喷口钛合金排气管与游戏同款发光氮气火焰。',
    specs: {
      '风格类型': 'Futuristic Sci-Fi Speedster',
      '尾翼结构': '双天鹅颈碳纤维气动支架 (Swan-Neck Carbon Pylons)',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
      '尾喷设计': '四喷口钛合金排气管'
    },
    update(time, dt) {
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.x += dt * (nitroBoost ? 18 : 8); });
      if (avatarObj) avatarObj.update(time);
      group.position.y = 0.02 + Math.sin(time * 3) * 0.01;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 3. CHIBI SWEET RACER (Q萌糖果卡丁车) - CLEAN NO-WING SHAPE
// ============================================================================
export function buildChibiCuteRacer(primaryColor = 0xff7ebb, accentColor = 0xffe66d, avatarId = 'rabbit', showDriver = true, nitroBoost = false) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: primaryColor, roughness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.3 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.1 });
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0xff4d6d, roughness: 0.4 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x3d354a, roughness: 0.7 });
  const candyRimMat = new THREE.MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.3 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.95, roughness: 0.1 });

  // Macaron Chassis
  const bodyGeo = new THREE.SphereGeometry(0.85, 24, 24);
  bodyGeo.scale(1.15, 0.75, 1.4);
  createMesh(bodyGeo, bodyMat, group, [0, 0.55, 0]);

  // Belly Bumper
  const bellyGeo = new THREE.SphereGeometry(0.65, 20, 20);
  bellyGeo.scale(1.0, 0.5, 0.9);
  createMesh(bellyGeo, whiteMat, group, [0, 0.42, 0.5]);

  // Headlight Eyes
  for (const side of [-1, 1]) {
    createMesh(new THREE.SphereGeometry(0.22, 16, 16), whiteMat, group, [side * 0.35, 0.65, 1.05]);
    createMesh(new THREE.SphereGeometry(0.14, 12, 12), eyeMat, group, [side * 0.35, 0.65, 1.15]);
  }

  // Rosy Cheeks
  for (const side of [-1, 1]) {
    createMesh(new THREE.SphereGeometry(0.12, 12, 12), cheekMat, group, [side * 0.55, 0.48, 1.0]);
  }

  // Open Cockpit Cutout
  createMesh(new THREE.CylinderGeometry(0.48, 0.45, 0.35, 16), whiteMat, group, [0, 0.72, -0.1]);

  // Driver Mount Point
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 1.05);
    avatarObj.group.position.set(0, 0.78, -0.1);
    group.add(avatarObj.group);
  }

  // Bobbing Bear Ears on Roof
  const ears = [];
  for (const side of [-1, 1]) {
    const earGroup = new THREE.Group();
    earGroup.position.set(side * 0.42, 1.12, 0.1);
    group.add(earGroup);
    ears.push(earGroup);
    createMesh(new THREE.SphereGeometry(0.22, 16, 16), bodyMat, earGroup);
    createMesh(new THREE.SphereGeometry(0.13, 12, 12), accentMat, earGroup, [0, 0, 0.05]);
  }

  // Candy Tailpipes & In-Game Style Boost Flames
  const nitroFlames = [];
  for (const x of [-0.35, 0.35]) {
    createMesh(new THREE.CylinderGeometry(0.14, 0.16, 0.4, 16), chromeMat, group, [x, 0.55, -1.18], [Math.PI / 2, 0, 0]);
    createMesh(new THREE.TorusGeometry(0.13, 0.03, 10, 20), accentMat, group, [x, 0.55, -1.35]);
    const flame = createInGameBoostFlame(group, x, 0.55, -1.38, 0.85);
    nitroFlames.push(flame);
  }

  // Chubby Wheels
  const wheels = [];
  for (const [wx, wy, wz] of [[-0.75, 0.3, 0.75], [0.75, 0.3, 0.75], [-0.75, 0.3, -0.75], [0.75, 0.3, -0.75]]) {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx);

    createMesh(new THREE.TorusGeometry(0.24, 0.12, 12, 24), tireMat, wGroup, [0, 0, 0], [0, Math.PI / 2, 0]);
    createMesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 5), candyRimMat, wGroup, [outwardSign * 0.08, 0, 0], [0, 0, Math.PI / 2]);
    wheels.push(wGroup);
  }

  return {
    group,
    id: 'chibi',
    name: 'Q萌糖果卡丁车 (Chibi Sweet Racer)',
    styleTag: '卡通可爱风格',
    description: '无尾翼的纯粹圆滚滚马卡龙造型，配备抛光镀铬甜甜圈双排气管与游戏同款双层氮气喷射火焰。',
    specs: {
      '风格类型': 'Chibi Cartoon / Kawaii Style',
      '尾翼造型': '无尾翼 (Clean Streamlined Macaron)',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
      '尾喷设计': '抛光镀铬甜甜圈双尾喷'
    },
    update(time, dt) {
      ears[0].rotation.z = Math.sin(time * 6) * 0.12;
      ears[1].rotation.z = -Math.sin(time * 6) * 0.12;
      group.position.y = 0.05 + Math.abs(Math.sin(time * 4)) * 0.05;
      group.rotation.z = Math.sin(time * 4) * 0.04;
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.z += dt * (nitroBoost ? 14 : 6); });
      if (avatarObj) avatarObj.update(time);
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 4. FORMULA 1 REALISTIC RACER (1:1复刻真实F1赛车) - SLEEK MINIMALIST REAR WING
// ============================================================================
export function buildFormula1RealRacer(primaryColor = 0xd90429, accentColor = 0xffb703, avatarId = 'fox', showDriver = true, nitroBoost = false) {
  const group = new THREE.Group();

  const liveryMat = new THREE.MeshStandardMaterial({ color: primaryColor, roughness: 0.2, metalness: 0.7, clearcoat: 1.0 });
  const carbonWeaveMat = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.45, metalness: 0.85 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x8d99ae, metalness: 0.95, roughness: 0.15 });
  const forgedRimMat = new THREE.MeshStandardMaterial({ color: 0x2b2e3a, metalness: 0.9, roughness: 0.2 });
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.9, metalness: 0.1 });
  const brakeDiscMat = new THREE.MeshStandardMaterial({ color: 0x3a3f58, metalness: 0.95, roughness: 0.25 });
  const yellowSponsorMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });

  const SCALE = 0.9;
  const f1Group = new THREE.Group();
  f1Group.scale.set(SCALE, SCALE, SCALE);
  group.add(f1Group);

  // Monocoque Chassis
  const noseShape = new THREE.Shape();
  noseShape.moveTo(-0.24, -2.4);
  noseShape.lineTo(-0.28, -0.6);
  noseShape.lineTo(-0.45, 0.8);
  noseShape.lineTo(-0.35, 1.6);
  noseShape.lineTo(0, 2.6);
  noseShape.lineTo(0.35, 1.6);
  noseShape.lineTo(0.45, 0.8);
  noseShape.lineTo(0.28, -0.6);
  noseShape.lineTo(0.24, -2.4);
  noseShape.closePath();

  const noseGeo = new THREE.ExtrudeGeometry(noseShape, { depth: 0.4, bevelEnabled: true, bevelSegments: 4, bevelSize: 0.05, bevelThickness: 0.05 });
  noseGeo.center();
  createMesh(noseGeo, liveryMat, f1Group, [0, 0.45, 0.1], [Math.PI / 2, 0, 0]);

  // Front Wing
  createMesh(new THREE.BoxGeometry(2.3, 0.04, 0.45), carbonWeaveMat, f1Group, [0, 0.22, 2.4]);
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.04, 0.38, 0.7), liveryMat, f1Group, [side * 1.15, 0.32, 2.38]);
  }

  // Wishbone Suspension
  for (const side of [-1, 1]) {
    for (const z of [1.35, 1.75]) {
      const armGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.75);
      createMesh(armGeo, carbonWeaveMat, f1Group, [side * 0.55, 0.48, z], [0, 0, Math.PI / 2 + side * -0.2]);
    }
  }

  // Cockpit Monocoque Tub & Steering Wheel
  createMesh(new THREE.CylinderGeometry(0.32, 0.36, 0.9, 16), carbonWeaveMat, f1Group, [0, 0.55, 0.1], [Math.PI / 2, 0, 0]);
  createMesh(new THREE.BoxGeometry(0.28, 0.16, 0.04), carbonWeaveMat, f1Group, [0, 0.62, 0.3], [-0.3, 0, 0]);

  // Driver Mount Point
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 0.90);
    avatarObj.group.position.set(0, 0.52, -0.12);
    f1Group.add(avatarObj.group);
  }

  // Halo Safety Hoop
  const haloRingGeo = new THREE.TorusGeometry(0.32, 0.035, 8, 16, Math.PI * 1.2);
  createMesh(haloRingGeo, carbonWeaveMat, f1Group, [0, 0.72, 0.15], [Math.PI / 2 + 0.3, 0, Math.PI]);
  createMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35), carbonWeaveMat, f1Group, [0, 0.68, 0.42], [-0.3, 0, 0]);

  // Engine Cover
  const engineCoverGeo = new THREE.ConeGeometry(0.38, 1.4, 16);
  createMesh(engineCoverGeo, liveryMat, f1Group, [0, 0.62, -0.9], [-Math.PI / 2, 0, 0]);

  // --------------------------------------------------------------------------
  // REFERENCE IMAGE INSPIRED 2026 F1 REAR WING STRUCTURE (参考图同款弧形弯曲翼端板尾翼)
  // --------------------------------------------------------------------------
  const wingZ = -1.95;

  // 1. Upper Wide Mainplane & DRS Flap
  createMesh(new THREE.BoxGeometry(1.85, 0.05, 0.38), carbonWeaveMat, f1Group, [0, 1.05, wingZ]);
  createMesh(new THREE.BoxGeometry(1.80, 0.035, 0.20), liveryMat, f1Group, [0, 1.13, wingZ + 0.04], [-0.18, 0, 0]);

  // Central DRS Actuator Pod Module
  createMesh(new THREE.BoxGeometry(0.10, 0.12, 0.16), metalMat, f1Group, [0, 1.12, wingZ]);

  // Central Neck Pylon Pillar connecting Engine Deck to Mainplane
  createMesh(new THREE.BoxGeometry(0.05, 0.45, 0.14), carbonWeaveMat, f1Group, [0, 0.82, wingZ]);

  // Lower Beam Wing
  createMesh(new THREE.BoxGeometry(1.15, 0.03, 0.22), carbonWeaveMat, f1Group, [0, 0.58, wingZ]);

  // 2. Swept Curved Endplates (参考图同款: 顶部向外展宽、下部弧形向内弯曲收敛至底翼)
  for (const side of [-1, 1]) {
    // Upper Outer Endplate Plate
    createMesh(new THREE.BoxGeometry(0.035, 0.24, 0.44), liveryMat, f1Group, [side * 0.92, 1.05, wingZ]);

    // Sweeping Inward Curved Arch Leg (From X = +-0.92 down & inward to X = +-0.56)
    const archGeo = new THREE.BoxGeometry(0.035, 0.48, 0.18);
    createMesh(archGeo, carbonWeaveMat, f1Group, [side * 0.74, 0.76, wingZ], [0, 0, side * -0.48]);

    // Lower Beam Mount Anchor
    createMesh(new THREE.BoxGeometry(0.04, 0.08, 0.24), liveryMat, f1Group, [side * 0.56, 0.56, wingZ]);
  }

  // --------------------------------------------------------------------------
  // SHIFTED REAR EXHAUST TAILPIPES (后移至贴近车尾 Z = -2.02)
  // --------------------------------------------------------------------------
  const nitroFlames = [];

  // 4 Tailpipe Nozzles flush with the rear engine deck & diffuser edge!
  const f1Exhausts = [
    [-0.14, 0.62, -2.02], [0.14, 0.62, -2.02],
    [-0.28, 0.48, -2.02], [0.28, 0.48, -2.02],
  ];

  f1Exhausts.forEach(([x, y, z]) => {
    const pipeGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.38, 16);
    createMesh(pipeGeo, metalMat, f1Group, [x, y, z], [Math.PI / 2, 0, 0]);

    const bezelGeo = new THREE.TorusGeometry(0.085, 0.012, 8, 16);
    createMesh(bezelGeo, carbonWeaveMat, f1Group, [x, y, z - 0.19]);

    const flame = createInGameBoostFlame(f1Group, x, y, z - 0.20, 0.75);
    nitroFlames.push(flame);
  });

  // Carbon Diffuser & Red Rain Light
  createMesh(new THREE.BoxGeometry(1.2, 0.22, 0.5), carbonWeaveMat, f1Group, [0, 0.25, -1.8]);
  const rainLight = createMesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), new THREE.MeshBasicMaterial({ color: 0xff0000 }), f1Group, [0, 0.35, -2.06]);

  // Wheels
  const wheels = [];
  const f1WheelPositions = [[-1.02, 0.38, 1.55], [1.02, 0.38, 1.55], [-0.98, 0.42, -1.45], [0.98, 0.42, -1.45]];

  f1WheelPositions.forEach(([wx, wy, wz], idx) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    f1Group.add(wGroup);

    const outwardSign = Math.sign(wx);
    const isRear = idx >= 2;
    const tireRadius = isRear ? 0.42 : 0.38;
    const tireWidth = isRear ? 0.44 : 0.36;

    createMesh(new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 32), rubberMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.TorusGeometry(tireRadius * 0.78, 0.02, 8, 24), yellowSponsorMat, wGroup, [outwardSign * (tireWidth * 0.51), 0, 0], [0, Math.PI / 2, 0]);
    createMesh(new THREE.CylinderGeometry(tireRadius * 0.62, tireRadius * 0.62, tireWidth + 0.01, 16), forgedRimMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    for (let s = 0; s < 5; s++) {
      const angle = (s * Math.PI * 2) / 5;
      for (const offset of [-0.04, 0.04]) {
        const spokeGeo = new THREE.BoxGeometry(0.03, tireRadius * 0.58, 0.02);
        createMesh(spokeGeo, metalMat, wGroup, [outwardSign * (tireWidth * 0.48), Math.sin(angle + offset) * 0.12, Math.cos(angle + offset) * 0.12], [angle + offset, 0, 0]);
      }
    }

    const nutMat = new THREE.MeshStandardMaterial({ color: outwardSign > 0 ? 0xd90429 : 0x00f0ff, metalness: 0.9, roughness: 0.1 });
    createMesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 6), nutMat, wGroup, [outwardSign * (tireWidth * 0.52), 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.CylinderGeometry(tireRadius * 0.7, tireRadius * 0.7, 0.04, 24), brakeDiscMat, wGroup, [outwardSign * 0.02, 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.BoxGeometry(0.08, 0.16, 0.14), yellowSponsorMat, wGroup, [outwardSign * 0.02, tireRadius * 0.45, 0]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'f1',
    name: '1:1复刻真实F1赛车 (Formula 1 Grand Prix Bolide)',
    styleTag: '真实1:1复刻样式',
    description: '1:1比例打造的 F1 赛车。配备极简单翼气动尾翼、双直立支架与后移贴合车尾的四排气管。',
    specs: {
      '风格类型': '1:1 Formula 1 Grand Prix Racing Car',
      '尾翼结构': '极简单翼 + 双直立碳纤维支架 (Minimalist Pylon Wing)',
      '尾喷设计': '后移贴合车尾 F1 四喷口钛合金排气管',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)'
    },
    update(time, dt) {
      rainLight.visible = Math.sin(time * 12) > 0;
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.x += dt * (nitroBoost ? 22 : 10); });
      if (avatarObj) avatarObj.update(time);
      group.position.y = 0.02;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 5. QUANTUM CRYSTAL HOVER-RACER (量子晶体光轮)
// ============================================================================
export function buildQuantumHoverRacer(primaryColor = 0x00f0ff, accentColor = 0xa000ff, avatarId = 'raccoon', showDriver = true, nitroBoost = false) {
  const group = new THREE.Group();

  const crystalMat = new THREE.MeshPhysicalMaterial({
    color: primaryColor,
    transmission: 0.85,
    opacity: 0.9,
    transparent: true,
    roughness: 0.1,
    metalness: 0.2,
    ior: 1.6,
  });
  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x121520, roughness: 0.3, metalness: 0.9 });
  const quantumCoreMat = new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 5.0 });
  const cyanRingMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 4.0 });

  // Faceted Crystal Hull
  const hullGeo = new THREE.OctahedronGeometry(1.2, 2);
  hullGeo.scale(0.8, 0.35, 1.8);
  createMesh(hullGeo, crystalMat, group, [0, 0.52, 0]);

  // Carbon Fiber Aerodynamic Spine Frame
  createMesh(new THREE.BoxGeometry(0.35, 0.25, 3.2), carbonMat, group, [0, 0.42, 0]);

  // Floating Pulsing Quantum Core Orb
  const coreMesh = createMesh(new THREE.SphereGeometry(0.28, 20, 20), quantumCoreMat, group, [0, 0.58, -0.6]);

  // Driver Mount Point Inside Crystal Canopy
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 0.92);
    avatarObj.group.position.set(0, 0.50, 0.1);
    group.add(avatarObj.group);
  }

  // Rear Quantum Plasma Thruster Nozzles
  const nitroFlames = [];
  for (const side of [-1, 1]) {
    createMesh(new THREE.TorusGeometry(0.22, 0.04, 12, 24), cyanRingMat, group, [side * 0.42, 0.52, -1.65]);
    const flame = createInGameBoostFlame(group, side * 0.42, 0.52, -1.80, 0.95);
    nitroFlames.push(flame);
  }

  // Hubless Floating Ring Wheels (Torus Rings)
  const wheels = [];
  const wPositions = [[-0.88, 0.38, 1.1], [0.88, 0.38, 1.1], [-0.88, 0.38, -1.1], [0.88, 0.38, -1.1]];

  wPositions.forEach(([wx, wy, wz]) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx);
    createMesh(new THREE.TorusGeometry(0.38, 0.07, 16, 32), cyanRingMat, wGroup, [0, 0, 0], [0, Math.PI / 2, 0]);
    createMesh(new THREE.TorusGeometry(0.28, 0.03, 12, 24), quantumCoreMat, wGroup, [outwardSign * 0.02, 0, 0], [0, Math.PI / 2, 0]);
    wheels.push(wGroup);
  });

  return {
    group,
    id: 'quantum',
    name: '量子晶体光轮 (Quantum Crystal Hover-Racer)',
    styleTag: '量子晶体光流',
    description: '半透明晶体装甲与无轴悬浮光轮构成的未来量子赛车，核心配备脉冲量子能量球。',
    specs: {
      '风格类型': 'Quantum Crystal Energy Hover-Racer',
      '轮毂技术': '无轴磁悬浮发光光轮 (Hubless Glowing Ring Wheels)',
      '动力核心': '悬浮脉冲量子能量球 (Floating Quantum Core)',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)'
    },
    update(time, dt) {
      coreMesh.scale.setScalar(1 + 0.12 * Math.sin(time * 6));
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.z += dt * (nitroBoost ? 22 : 10); });
      if (avatarObj) avatarObj.update(time);
      group.position.y = 0.12 + Math.sin(time * 2.5) * 0.035;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 6. RUGGED OFF-ROAD BEAST (荒野雷霆越野装甲)
// ============================================================================
export function buildRuggedOffroadBeast(
  primaryColor = 0xd97706,
  accentColor = 0x84cc16,
  avatarId = 'bear',
  showDriver = true,
  nitroBoost = false
) {
  const group = new THREE.Group();

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    roughness: 0.65,
    metalness: 0.2,
    envMapIntensity: 1.0,
  });
  const darkMetalMat = new THREE.MeshStandardMaterial({
    color: 0x1e2430,
    roughness: 0.5,
    metalness: 0.85,
  });
  const cageMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.35,
    metalness: 0.9,
  });
  const springMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.3,
    metalness: 0.7,
    emissive: accentColor,
    emissiveIntensity: 0.3,
  });
  const tireRubberMat = new THREE.MeshStandardMaterial({
    color: 0x111318,
    roughness: 0.95,
    metalness: 0.05,
  });
  const beadlockRimMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    metalness: 0.85,
    roughness: 0.25,
  });
  const accentRimRing = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.3,
    metalness: 0.8,
  });
  const lightGlassMat = new THREE.MeshStandardMaterial({
    color: 0xffea00,
    emissive: 0xffea00,
    emissiveIntensity: 3.0,
  });

  // 1. CHASSIS FRAME & HEAVY MUDGUARDS
  createMesh(new THREE.BoxGeometry(1.2, 0.22, 3.4), darkMetalMat, group, [0, 0.38, 0]);

  // Front Steel Bull Bar Bumper Guard
  createMesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4), darkMetalMat, group, [0, 0.42, 1.85], [0, 0, Math.PI / 2]);
  createMesh(new THREE.BoxGeometry(1.2, 0.12, 0.25), darkMetalMat, group, [0, 0.30, 1.95], [-0.2, 0, 0]);

  // Dual Front Amber Off-Road Fog Lamps
  for (const side of [-1, 1]) {
    createMesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 16), darkMetalMat, group, [side * 0.4, 0.45, 1.92], [Math.PI / 2, 0, 0]);
    createMesh(new THREE.SphereGeometry(0.1, 12, 12), lightGlassMat, group, [side * 0.4, 0.45, 1.96]);
  }

  // Rugged Bonnet / Hood with Power Bulge
  const hoodShape = new THREE.Shape();
  hoodShape.moveTo(-0.55, -0.6);
  hoodShape.lineTo(-0.62, 0.6);
  hoodShape.lineTo(-0.48, 1.5);
  hoodShape.lineTo(0.48, 1.5);
  hoodShape.lineTo(0.62, 0.6);
  hoodShape.lineTo(0.55, -0.6);
  hoodShape.closePath();

  const hoodGeo = new THREE.ExtrudeGeometry(hoodShape, { depth: 0.28, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05 });
  hoodGeo.center();
  createMesh(hoodGeo, bodyMat, group, [0, 0.60, 0.85], [Math.PI / 2, 0, 0]);

  // Power Scoop Air Intake on Hood
  createMesh(new THREE.BoxGeometry(0.42, 0.12, 0.5), darkMetalMat, group, [0, 0.76, 1.0], [0.15, 0, 0]);

  // Flared Wide Wheel Arches (Fenders)
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.35, 0.18, 1.1), darkMetalMat, group, [side * 0.72, 0.60, 1.25], [0.1, 0, side * -0.1]);
    createMesh(new THREE.BoxGeometry(0.38, 0.22, 1.2), darkMetalMat, group, [side * 0.74, 0.64, -1.15], [-0.08, 0, side * 0.1]);
  }

  // 2. CLEAN OPEN SAFARI ROLL CAGE & COCKPIT (NO FRONT CROSSBAR OR FACE-SHADOWING LIGHT BAR)
  const cageRadius = 0.04;
  for (const side of [-1, 1]) {
    // Side A-Pillar (Front diagonal cage along outer sides)
    createMesh(new THREE.CylinderGeometry(cageRadius, cageRadius, 1.0), cageMat, group, [side * 0.55, 0.95, 0.35], [-0.45, 0, side * -0.15]);
    // Side B-Pillar (Rear cage vertical along outer sides)
    createMesh(new THREE.CylinderGeometry(cageRadius, cageRadius, 0.95), cageMat, group, [side * 0.55, 0.95, -0.65], [0.15, 0, side * -0.1]);
    // Side Roof Rails (Connecting A & B pillars along top of roof)
    createMesh(new THREE.CylinderGeometry(cageRadius, cageRadius, 1.2), cageMat, group, [side * 0.55, 1.32, -0.15], [Math.PI / 2, 0, 0]);
  }
  // Rear Roof Crossbar (Behind driver head only, no shadow on face)
  createMesh(new THREE.CylinderGeometry(cageRadius, cageRadius, 1.1), cageMat, group, [0, 1.32, -0.65], [0, 0, Math.PI / 2]);

  // Front Hood Dashboard Edge (Low under steering line)
  createMesh(new THREE.CylinderGeometry(cageRadius, cageRadius, 1.05), cageMat, group, [0, 0.62, 0.55], [0, 0, Math.PI / 2]);

  // Ergonomic Bucket Seat (Lowered comfortable position)
  createMesh(new THREE.BoxGeometry(0.58, 0.60, 0.48), darkMetalMat, group, [0, 0.52, -0.05]);

  // Driver Mount Point (Lowered natural seating height, face receives clean key light without shadow)
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 0.98);
    avatarObj.group.position.set(0, 0.56, 0.0);
    group.add(avatarObj.group);
  }

  // 3. REAR EQUIPMENT, SPARE TIRE & REAR DUAL EXHAUST PIPES
  const spareGroup = new THREE.Group();
  spareGroup.position.set(0, 0.82, -1.55);
  spareGroup.rotation.x = -0.25;
  group.add(spareGroup);

  createMesh(new THREE.TorusGeometry(0.38, 0.16, 12, 24), tireRubberMat, spareGroup);
  createMesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 12), beadlockRimMat, spareGroup, [0, 0, 0], [Math.PI / 2, 0, 0]);
  createMesh(new THREE.TorusGeometry(0.26, 0.03, 8, 24), accentRimRing, spareGroup, [0, 0, 0.11]);

  // Rear Equipment Mounting Rack & Steel Bumper Plate
  createMesh(new THREE.BoxGeometry(1.0, 0.08, 0.12), darkMetalMat, group, [0, 0.65, -1.55]);
  createMesh(new THREE.BoxGeometry(1.2, 0.15, 0.22), darkMetalMat, group, [0, 0.36, -1.70]);

  // Rear Heavy Dual Off-Road Exhaust Pipes & Nitro Flames
  const nitroFlames = [];
  const exhaustPos = [-0.38, 0.38];
  exhaustPos.forEach((x) => {
    // Horizontal rear exhaust nozzle extending out from lower chassis
    createMesh(new THREE.CylinderGeometry(0.11, 0.13, 0.48, 16), darkMetalMat, group, [x, 0.44, -1.72], [Math.PI / 2, 0, 0]);
    createMesh(new THREE.TorusGeometry(0.12, 0.02, 8, 16), accentRimRing, group, [x, 0.44, -1.96]);

    // Nitro Boost Flame shooting straight backward
    const flame = createInGameBoostFlame(group, x, 0.44, -1.98, 0.9);
    nitroFlames.push(flame);
  });

  // 4. HIGH-TRAVEL OFF-ROAD SUSPENSION & HEAVY KNOBBY WHEELS
  const wheels = [];
  const wheelPos = [
    [-0.92, 0.42, 1.25],
    [0.92, 0.42, 1.25],
    [-0.96, 0.45, -1.20],
    [0.96, 0.45, -1.20],
  ];

  wheelPos.forEach(([wx, wy, wz]) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx);

    // Shock Absorber Coil Spring
    const shockGroup = new THREE.Group();
    shockGroup.position.set(wx * 0.65, wy + 0.15, wz);
    shockGroup.rotation.z = outwardSign * -0.3;
    group.add(shockGroup);

    createMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.48), darkMetalMat, shockGroup);
    for (let s = -0.18; s <= 0.18; s += 0.07) {
      createMesh(new THREE.TorusGeometry(0.075, 0.025, 8, 16), springMat, shockGroup, [0, s, 0], [Math.PI / 2, 0, 0]);
    }

    // Wishbone Suspension Arm
    createMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42), darkMetalMat, group, [wx * 0.45, wy - 0.05, wz], [0, 0, Math.PI / 2 + outwardSign * -0.25]);

    // Massive Off-Road Knobby Tire
    createMesh(new THREE.CylinderGeometry(0.44, 0.44, 0.38, 24), tireRubberMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    for (let t = 0; t < 12; t++) {
      const angle = (t * Math.PI * 2) / 12;
      const treadGeo = new THREE.BoxGeometry(0.39, 0.06, 0.12);
      createMesh(treadGeo, tireRubberMat, wGroup, [0, Math.sin(angle) * 0.44, Math.cos(angle) * 0.44], [angle, 0, 0]);
    }

    // Heavy Beadlock Rim
    createMesh(new THREE.CylinderGeometry(0.28, 0.28, 0.39, 16), beadlockRimMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    createMesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), accentRimRing, wGroup, [outwardSign * 0.198, 0, 0], [0, Math.PI / 2, 0]);

    for (let b = 0; b < 6; b++) {
      const bAngle = (b * Math.PI) / 3;
      createMesh(new THREE.BoxGeometry(0.04, 0.24, 0.04), darkMetalMat, wGroup, [outwardSign * 0.19, Math.sin(bAngle) * 0.12, Math.cos(bAngle) * 0.12], [bAngle, 0, 0]);
    }

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'offroad',
    name: '荒野雷霆越野装甲 (Wild Thunder Off-Road Beast)',
    styleTag: '荒野越野风格',
    description: '专为极难恶劣地形打造的荒野越野兽，具备外露刚性防滚架、高行程独立油压避震悬挂、巨型深齿轮越野胎与车顶LED探照灯阵列。',
    specs: {
      '风格类型': 'Rugged All-Terrain Off-Road 4x4',
      '悬挂系统': '高行程独立油压双叉臂悬挂 (Heavy Duty Off-Road Shocks)',
      '车身防护': '全包裹外露钢管防滚架 & 后挂全尺寸越野备胎',
      '探照灯组': '车顶 5 连高亮度 LED 探照灯阵列',
      '尾喷设计': '车尾防撞梁下方双出硬派大口径排气管',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)'
    },
    update(time, dt) {
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.x += dt * (nitroBoost ? 18 : 8); });
      if (avatarObj) avatarObj.update(time);
      group.position.y = 0.04 + Math.sin(time * 3.5) * 0.018;
      group.rotation.x = Math.sin(time * 2.5) * 0.012;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 7. BREEZE KART (疾风微风卡丁车 - 参考 BREEZE KART 概念设计)
// ============================================================================
export function buildBreezeKart(
  primaryColor = 0x1d70f5,
  accentColor = 0x38bdf8,
  avatarId = 'cat',
  showDriver = true,
  nitroBoost = false
) {
  const group = new THREE.Group();

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    roughness: 0.3,
    metalness: 0.4,
    envMapIntensity: 1.2,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.3,
    metalness: 0.5,
  });
  const darkChassisMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.6,
    metalness: 0.3,
  });
  const seatMat = new THREE.MeshStandardMaterial({
    color: 0x242b35,
    roughness: 0.7,
    metalness: 0.1,
  });
  const metalEngineMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.85,
    roughness: 0.25,
  });
  const pipeChromeMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.95,
    roughness: 0.15,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x181a20,
    roughness: 0.9,
    metalness: 0.1,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    metalness: 0.8,
    roughness: 0.3,
  });
  const blackTubeMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.4,
    metalness: 0.8,
  });

  // 1. CHASSIS TUBE FRAME & FLOOR
  createMesh(new THREE.BoxGeometry(0.85, 0.12, 2.3), darkChassisMat, group, [0, 0.24, 0]);

  // 2. BIG FRONT BUMPER (巨型前保险杠 - 带双凹进气口)
  const bumperShape = new THREE.Shape();
  bumperShape.moveTo(-0.75, -0.22);
  bumperShape.lineTo(-0.82, 0.05);
  bumperShape.lineTo(-0.65, 0.22);
  bumperShape.lineTo(0.65, 0.22);
  bumperShape.lineTo(0.82, 0.05);
  bumperShape.lineTo(0.75, -0.22);
  bumperShape.closePath();

  const bumperGeo = new THREE.ExtrudeGeometry(bumperShape, {
    depth: 0.32,
    bevelEnabled: true,
    bevelSegments: 4,
    bevelSize: 0.06,
    bevelThickness: 0.06,
  });
  bumperGeo.center();
  createMesh(bumperGeo, bodyMat, group, [0, 0.36, 1.48], [Math.PI / 2, 0, 0]);

  // Dual Air Intake Ports Cutout in Bumper
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.26, 0.09, 0.16), darkChassisMat, group, [side * 0.34, 0.30, 1.58]);
  }

  // 3. STREAMLINED NOSE CONE HOOD (前流线型引擎盖罩)
  const hoodShape = new THREE.Shape();
  hoodShape.moveTo(-0.35, -0.65);
  hoodShape.lineTo(-0.45, 0.15);
  hoodShape.lineTo(-0.25, 0.75);
  hoodShape.lineTo(0.25, 0.75);
  hoodShape.lineTo(0.45, 0.15);
  hoodShape.lineTo(0.35, -0.65);
  hoodShape.closePath();

  const hoodGeo = new THREE.ExtrudeGeometry(hoodShape, {
    depth: 0.24,
    bevelEnabled: true,
    bevelSize: 0.04,
    bevelThickness: 0.04,
  });
  hoodGeo.center();
  createMesh(hoodGeo, bodyMat, group, [0, 0.52, 0.85], [Math.PI / 2 + 0.22, 0, 0]);

  // Subtle Center Hood Ridge
  createMesh(new THREE.BoxGeometry(0.08, 0.05, 1.1), accentMat, group, [0, 0.58, 0.85], [0.22, 0, 0]);

  // 4. SCULPTED SIDE PODS (凸起圆润侧翼气动护台)
  for (const side of [-1, 1]) {
    const sidePodGeo = new THREE.BoxGeometry(0.24, 0.34, 1.25);
    createMesh(sidePodGeo, bodyMat, group, [side * 0.68, 0.38, -0.05], [0, side * 0.04, 0]);
    createMesh(new THREE.BoxGeometry(0.26, 0.06, 1.15), darkChassisMat, group, [side * 0.68, 0.24, -0.05]);
  }

  // 5. COMFY HIGH-BACK SEAT & BLACK ROLL HOOP BAR (深色舒适高背赛车座椅与黑色钢管防滚架)
  // Seat Base & Backrest
  createMesh(new THREE.BoxGeometry(0.54, 0.16, 0.48), seatMat, group, [0, 0.34, -0.12]);
  createMesh(new THREE.BoxGeometry(0.50, 0.55, 0.14), seatMat, group, [0, 0.62, -0.32], [-0.18, 0, 0]);
  // Rounded Headrest
  const headrestGeo = new THREE.SphereGeometry(0.16, 14, 14);
  headrestGeo.scale(1.1, 0.9, 0.7);
  createMesh(headrestGeo, seatMat, group, [0, 0.92, -0.38]);

  // Black Steel Roll Hoop Arch behind seat
  for (const side of [-1, 1]) {
    createMesh(new THREE.CylinderGeometry(0.038, 0.038, 0.75), blackTubeMat, group, [side * 0.24, 0.85, -0.44], [-0.15, 0, 0]);
  }
  const topHoopGeo = new THREE.TorusGeometry(0.24, 0.038, 8, 16, Math.PI);
  createMesh(topHoopGeo, blackTubeMat, group, [0, 1.20, -0.49], [0.15, 0, Math.PI]);

  // Steering Column & 3-Spoke Karting Steering Wheel
  createMesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55), metalEngineMat, group, [0, 0.58, 0.32], [-0.6, 0, 0]);
  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(0, 0.70, 0.18);
  wheelGroup.rotation.x = -0.55;
  group.add(wheelGroup);
  createMesh(new THREE.TorusGeometry(0.14, 0.022, 8, 20), blackTubeMat, wheelGroup);
  createMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), metalEngineMat, wheelGroup, [0, 0, 0], [Math.PI / 2, 0, 0]);
  for (let s = 0; s < 3; s++) {
    const angle = (s * Math.PI * 2) / 3;
    createMesh(new THREE.BoxGeometry(0.02, 0.12, 0.015), metalEngineMat, wheelGroup, [Math.sin(angle) * 0.06, Math.cos(angle) * 0.06, 0], [0, 0, -angle]);
  }

  // Driver Mount Point
  let avatarObj = null;
  if (showDriver) {
    avatarObj = buildCartoonAvatar(avatarId, 0.96);
    avatarObj.group.position.set(0, 0.44, -0.10);
    group.add(avatarObj.group);
  }

  // 6. COMPACT REAR ENGINE & PROMINENT DUAL STAINLESS EXHAUST PIPES (紧凑型引擎与双出大排气管)
  const engineGroup = new THREE.Group();
  engineGroup.position.set(0, 0.52, -0.75);
  group.add(engineGroup);

  // Engine Block Body
  createMesh(new THREE.BoxGeometry(0.52, 0.38, 0.42), metalEngineMat, engineGroup);
  // Silver Cylinder Head & Air Filter Box
  createMesh(new THREE.BoxGeometry(0.38, 0.12, 0.28), darkChassisMat, engineGroup, [0, 0.24, 0]);
  createMesh(new THREE.CylinderGeometry(0.12, 0.12, 0.18, 14), blackTubeMat, engineGroup, [-0.22, 0.14, -0.05], [0, 0, Math.PI / 2]);

  // Dual Prominent Flared Stainless Steel Exhaust Pipes (Key Feature from Reference Image!)
  const nitroFlames = [];
  const exhaustPos = [
    [-0.24, 0.56, -1.05],
    [0.24, 0.56, -1.05],
  ];

  exhaustPos.forEach(([x, y, z]) => {
    // Angled Flared Pipe Body
    createMesh(new THREE.CylinderGeometry(0.08, 0.12, 0.52, 16), pipeChromeMat, group, [x, y, z], [Math.PI / 2 - 0.15, 0, x > 0 ? 0.15 : -0.15]);
    // Pipe Tip Bezel Ring
    createMesh(new THREE.TorusGeometry(0.115, 0.018, 8, 16), accentMat, group, [x, y, z - 0.26]);

    // Nitro Flame attachment
    const flame = createInGameBoostFlame(group, x, y, z - 0.28, 0.88);
    nitroFlames.push(flame);
  });

  // Central Large Rear Exhaust Nozzle (As shown in rear view)
  createMesh(new THREE.CylinderGeometry(0.12, 0.15, 0.32, 16), pipeChromeMat, group, [0, 0.40, -1.08], [Math.PI / 2, 0, 0]);
  createMesh(new THREE.TorusGeometry(0.14, 0.02, 8, 16), blackTubeMat, group, [0, 0.40, -1.24]);
  const centerFlame = createInGameBoostFlame(group, 0, 0.40, -1.26, 0.95);
  nitroFlames.push(centerFlame);

  // 7. HIGH REAR SPOILER WING (高耸风向矩形尾翼)
  const wingZ = -1.22;
  const wingY = 1.10;
  // Wing Mainplane
  createMesh(new THREE.BoxGeometry(1.42, 0.055, 0.34), bodyMat, group, [0, wingY, wingZ]);
  // Wing Lip Accent
  createMesh(new THREE.BoxGeometry(1.44, 0.03, 0.06), accentMat, group, [0, wingY + 0.02, wingZ - 0.15]);
  // Side Endplates
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.04, 0.26, 0.36), bodyMat, group, [side * 0.72, wingY, wingZ]);
  }
  // Upright Struts from Engine to Wing
  for (const side of [-1, 1]) {
    createMesh(new THREE.BoxGeometry(0.045, 0.52, 0.08), blackTubeMat, group, [side * 0.32, wingY - 0.25, wingZ + 0.05], [-0.2, 0, 0]);
  }

  // 8. KARTING SLICK WHEELS (宽体平滑卡丁轮毂)
  const wheels = [];
  const wheelPositions = [
    [-0.78, 0.32, 0.95],
    [0.78, 0.32, 0.95],
    [-0.84, 0.36, -0.92],
    [0.84, 0.36, -0.92],
  ];

  wheelPositions.forEach(([wx, wy, wz], idx) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx);
    const isRear = idx >= 2;
    const tireRadius = isRear ? 0.36 : 0.32;
    const tireWidth = isRear ? 0.38 : 0.30;

    // Smooth Slick Karting Rubber Tire
    createMesh(new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 28), tireMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    // Dark Metallic Rim Hub
    createMesh(new THREE.CylinderGeometry(tireRadius * 0.65, tireRadius * 0.65, tireWidth + 0.01, 16), rimMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);
    // Accent Rim Outer Ring
    createMesh(new THREE.TorusGeometry(tireRadius * 0.64, 0.018, 8, 24), accentMat, wGroup, [outwardSign * (tireWidth * 0.51), 0, 0], [0, Math.PI / 2, 0]);

    // Center Axle Cap Nut
    createMesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 6), metalEngineMat, wGroup, [outwardSign * (tireWidth * 0.52), 0, 0], [0, 0, Math.PI / 2]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'breeze',
    name: '疾风微风卡丁 (Breeze Kart)',
    styleTag: '经典卡丁样式',
    description: '参考经典 Breeze Kart 概念设计的轻量化高敏捷卡丁车。具备包覆式巨型前保险杠、双孔进气格栅、侧翼保护台、舒适高背座椅与后置紧凑引擎加长双排气管。',
    specs: {
      '风格类型': 'Light • Quick • Fun Breeze Kart',
      '前保设计': '巨型包覆式前保险杠 (Big Front Bumper)',
      '座椅防护': '高背舒适座椅 & 刚性防滚架 (Comfy Seat & Roll Bar)',
      '动力尾喷': '紧凑型发动机 & 钛合金双出大排气管',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)'
    },
    update(time, dt) {
      updateInGameBoostFlame(nitroFlames, nitroBoost, time);
      wheels.forEach((w) => { w.children[0].rotation.x += dt * (nitroBoost ? 20 : 9); });
      if (avatarObj) avatarObj.update(time);
      group.position.y = 0.03 + Math.sin(time * 3) * 0.015;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}


