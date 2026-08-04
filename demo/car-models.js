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
      // Pointed ears with inner pink
      for (const side of [-1, 1]) {
        const earGeo = new THREE.ConeGeometry(0.1, 0.22, 4);
        const ear = createMesh(earGeo, headMat, headGroup, [side * 0.16, 0.26, 0], [0, Math.PI / 4, side * -0.15]);
        const innerEarGeo = new THREE.ConeGeometry(0.06, 0.16, 4);
        createMesh(innerEarGeo, pinkMat, ear, [0, -0.01, 0.02]);
      }
      // Cute Whiskers
      for (const side of [-1, 1]) {
        for (const y of [-0.03, -0.07]) {
          const whiskerGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.16);
          createMesh(whiskerGeo, detailMat, headGroup, [side * 0.18, y, 0.22], [0, 0, Math.PI / 2 + side * 0.1]);
        }
      }
      break;
    }

    case 'dog': {
      // Floppy folded ears
      for (const side of [-1, 1]) {
        const earGeo = new THREE.SphereGeometry(0.12, 12, 12);
        earGeo.scale(0.6, 1.4, 0.6);
        createMesh(earGeo, detailMat, headGroup, [side * 0.24, 0.08, 0.02], [0, 0, side * 0.3]);
      }
      // Happy tongue tip out
      const tongueGeo = new THREE.SphereGeometry(0.035, 10, 10);
      tongueGeo.scale(1, 0.5, 1.2);
      createMesh(tongueGeo, pinkMat, headGroup, [0, -0.08, 0.28]);
      break;
    }

    case 'rabbit': {
      // Long tall ears with pink interior
      for (const side of [-1, 1]) {
        const earGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.45, 12);
        const ear = createMesh(earGeo, headMat, headGroup, [side * 0.12, 0.42, -0.02], [0.1, 0, side * -0.12]);
        const innerGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.38, 12);
        createMesh(innerGeo, pinkMat, ear, [0, 0, 0.02]);
      }
      break;
    }

    case 'fox': {
      // 🦊 BRAND NEW REDESIGNED FOX
      const foxRedMat = new THREE.MeshStandardMaterial({ color: 0xeb6123, roughness: 0.55 });
      const foxWhiteMat = new THREE.MeshStandardMaterial({ color: 0xfff8f0, roughness: 0.6 });
      const foxDarkMat = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.4 });

      // White Fluffy Cheek Patches
      for (const side of [-1, 1]) {
        const cheekPatchGeo = new THREE.SphereGeometry(0.15, 12, 12);
        cheekPatchGeo.scale(0.8, 0.7, 0.8);
        createMesh(cheekPatchGeo, foxWhiteMat, headGroup, [side * 0.18, -0.06, 0.16]);
      }

      // Elegant Tapered White Muzzle Chin
      const foxMuzzleGeo = new THREE.ConeGeometry(0.13, 0.28, 12);
      createMesh(foxMuzzleGeo, foxWhiteMat, headGroup, [0, -0.06, 0.28], [Math.PI / 2 + 0.1, 0, 0]);

      // Cute Shiny Dark Nose Tip
      const foxNoseGeo = new THREE.SphereGeometry(0.038, 10, 10);
      createMesh(foxNoseGeo, foxDarkMat, headGroup, [0, -0.01, 0.39]);

      // Large Fluffy Fox Ears
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
// 2. CYBER NEON HYPERCAR (赛博酷炫超跑) - BOTH SIDES OUTWARD RIMS & IN-GAME BOOST FLAMES
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

  // --------------------------------------------------------------------------
  // QUAD JET EXHAUST NOZZLES & IN-GAME STYLE BOOST FLAMES
  // --------------------------------------------------------------------------
  const nitroFlames = [];
  const exhaustPositions = [-0.45, -0.18, 0.18, 0.45];

  exhaustPositions.forEach((x, i) => {
    // Hexagonal Outer Titanium Heat Shield Nozzle
    const pipeGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.55, 6);
    createMesh(pipeGeo, titaniumMat, group, [x, 0.42, -1.82], [Math.PI / 2, 0, 0]);

    // Inner Glowing Energy Ring Nozzle
    const ringGeo = new THREE.TorusGeometry(0.11, 0.02, 8, 16);
    createMesh(ringGeo, i % 2 === 0 ? neonMat : neonMagentaMat, group, [x, 0.42, -1.85]);

    // In-game style dual cone boost flame directly at exhaust pipe mouth!
    const flame = createInGameBoostFlame(group, x, 0.42, -2.10, 0.9);
    nitroFlames.push(flame);
  });

  // Rear Cyber Wing
  createMesh(new THREE.BoxGeometry(1.9, 0.05, 0.38), bodyMat, group, [0, 0.88, -1.75]);
  createMesh(new THREE.BoxGeometry(1.94, 0.06, 0.08), neonMat, group, [0, 0.88, -1.92]);

  // --------------------------------------------------------------------------
  // OPTIMIZED WHEELS: FULL OUTWARD & INWARD 3D RIMS ON ALL WHEELS
  // --------------------------------------------------------------------------
  const wheels = [];
  const wPositions = [[-0.92, 0.33, 1.25], [0.92, 0.33, 1.25], [-0.96, 0.36, -1.25], [0.96, 0.36, -1.25]];

  wPositions.forEach(([wx, wy, wz]) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    const outwardSign = Math.sign(wx); // +1 for Right, -1 for Left

    // Cyber Tire with Tread Grooves
    const tireGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.34, 32);
    createMesh(tireGeo, cyberTireMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // Outer Neon Sidewall Ring (On OUTWARD side!)
    const treadRingGeo = new THREE.TorusGeometry(0.345, 0.015, 8, 32);
    createMesh(treadRingGeo, neonMat, wGroup, [outwardSign * 0.165, 0, 0], [0, Math.PI / 2, 0]);

    // Cyber Turbine Multi-Blade Rim (On OUTWARD side!)
    const rimCoreGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.35, 8);
    createMesh(rimCoreGeo, carbonMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    for (let b = 0; b < 6; b++) {
      const bladeGeo = new THREE.BoxGeometry(0.04, 0.22, 0.02);
      const bladeAngle = (b * Math.PI) / 3;
      createMesh(bladeGeo, titaniumMat, wGroup, [outwardSign * 0.17, Math.sin(bladeAngle) * 0.12, Math.cos(bladeAngle) * 0.12], [bladeAngle, 0, 0]);
    }

    // Glowing Energy Rim Core (On OUTWARD side!)
    const haloGeo = new THREE.TorusGeometry(0.14, 0.025, 8, 24);
    createMesh(haloGeo, neonMagentaMat, wGroup, [outwardSign * 0.175, 0, 0], [0, Math.PI / 2, 0]);

    // Titanium Cross-Drilled Disc Brake & Neon Caliper
    const discGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.03, 20);
    createMesh(discGeo, titaniumMat, wGroup, [outwardSign * 0.02, 0, 0], [0, 0, Math.PI / 2]);

    const caliperGeo = new THREE.BoxGeometry(0.08, 0.14, 0.12);
    createMesh(caliperGeo, neonMat, wGroup, [outwardSign * 0.02, 0.16, 0]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'cyber',
    name: '赛博朋克超跑 (Cyber Neon Hypercar)',
    styleTag: '华丽酷炫风格',
    description: '搭载四喷口钛合金排气管、游戏同款氮气尾焰与双侧面向外完全重构的赛博光子轮毂。',
    specs: {
      '风格类型': 'Futuristic Sci-Fi Speedster',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
      '轮毂技术': '双侧外向 3D 赛博轮毂 + 钛合金打孔刹车盘',
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
// 3. CHIBI SWEET RACER (Q萌糖果卡丁车) - IN-GAME STYLE BOOST FLAMES
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

  // --------------------------------------------------------------------------
  // CANDY TAILPIPES & IN-GAME STYLE BOOST FLAMES
  // --------------------------------------------------------------------------
  const nitroFlames = [];

  for (const x of [-0.35, 0.35]) {
    // Chrome Outer Shield Pipe
    const outerPipe = new THREE.CylinderGeometry(0.14, 0.16, 0.4, 16);
    createMesh(outerPipe, chromeMat, group, [x, 0.55, -1.18], [Math.PI / 2, 0, 0]);

    // Pastel Candy Ring Glow Tip
    const tipRing = new THREE.TorusGeometry(0.13, 0.03, 10, 20);
    createMesh(tipRing, accentMat, group, [x, 0.55, -1.35]);

    // In-game style dual cone boost flame directly at exhaust pipe mouth!
    const flame = createInGameBoostFlame(group, x, 0.55, -1.38, 0.85);
    nitroFlames.push(flame);
  }

  // Heart-Shaped Spoiler
  createMesh(new THREE.BoxGeometry(1.1, 0.08, 0.3), accentMat, group, [0, 1.1, -1.0]);

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
    description: '圆滚滚马卡龙造型，配备抛光镀铬甜甜圈双排气管与游戏同款双层氮气喷射火焰。',
    specs: {
      '风格类型': 'Chibi Cartoon / Kawaii Style',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
      '尾喷设计': '抛光镀铬甜甜圈双尾喷',
      '车体造型': '马卡龙敞篷座舱'
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
// 4. FORMULA 1 REALISTIC RACER (1:1复刻真实F1赛车) - 4 TITANIUM TAILPIPES & BOTH SIDES OUTWARD RIMS
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

  // Engine Cover & Rear Wing
  const engineCoverGeo = new THREE.ConeGeometry(0.38, 1.4, 16);
  createMesh(engineCoverGeo, liveryMat, f1Group, [0, 0.62, -0.9], [-Math.PI / 2, 0, 0]);
  createMesh(new THREE.BoxGeometry(1.8, 0.06, 0.42), carbonWeaveMat, f1Group, [0, 1.15, -1.9]);

  // --------------------------------------------------------------------------
  // OPTIMIZED EXHAUST: F1 QUAD TITANIUM EXHAUST CLUSTER & IN-GAME BOOST FLAMES
  // --------------------------------------------------------------------------
  const nitroFlames = [];

  // 4 Rear Exhaust Tailpipe Nozzles (Upper Main Twin + Lower Wastegate Twin)
  const f1Exhausts = [
    [-0.14, 0.62, -1.72], [0.14, 0.62, -1.72],
    [-0.28, 0.48, -1.75], [0.28, 0.48, -1.75],
  ];

  f1Exhausts.forEach(([x, y, z]) => {
    // Titanium Tube Nozzle
    const pipeGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.42, 16);
    createMesh(pipeGeo, metalMat, f1Group, [x, y, z], [Math.PI / 2, 0, 0]);

    // Heat Bezel Tip
    const bezelGeo = new THREE.TorusGeometry(0.085, 0.012, 8, 16);
    createMesh(bezelGeo, carbonWeaveMat, f1Group, [x, y, z - 0.21]);

    // In-game style dual cone boost flame directly at exhaust pipe mouth!
    const flame = createInGameBoostFlame(f1Group, x, y, z - 0.22, 0.75);
    nitroFlames.push(flame);
  });

  // Rain Light
  const rainLight = createMesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), new THREE.MeshBasicMaterial({ color: 0xff0000 }), f1Group, [0, 0.35, -2.06]);

  // --------------------------------------------------------------------------
  // OPTIMIZED WHEELS: FULL OUTWARD & INWARD 3D FORGED RIMS ON ALL WHEELS
  // --------------------------------------------------------------------------
  const wheels = [];
  const f1WheelPositions = [[-1.02, 0.38, 1.55], [1.02, 0.38, 1.55], [-0.98, 0.42, -1.45], [0.98, 0.42, -1.45]];

  f1WheelPositions.forEach(([wx, wy, wz], idx) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    f1Group.add(wGroup);

    const outwardSign = Math.sign(wx); // +1 for Right, -1 for Left
    const isRear = idx >= 2;
    const tireRadius = isRear ? 0.42 : 0.38;
    const tireWidth = isRear ? 0.44 : 0.36;

    // Competition Slick Tire
    const tireGeo = new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 32);
    createMesh(tireGeo, rubberMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // Pirelli Yellow Sidewall Ring (On OUTWARD side!)
    const sidewallGeo = new THREE.TorusGeometry(tireRadius * 0.78, 0.02, 8, 24);
    createMesh(sidewallGeo, yellowSponsorMat, wGroup, [outwardSign * (tireWidth * 0.51), 0, 0], [0, Math.PI / 2, 0]);

    // Forged 5-Double-Spoke Alloy Rim Barrel
    const rimBarrel = new THREE.CylinderGeometry(tireRadius * 0.62, tireRadius * 0.62, tireWidth + 0.01, 16);
    createMesh(rimBarrel, forgedRimMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // 5 Double Spokes (On OUTWARD side!)
    for (let s = 0; s < 5; s++) {
      const angle = (s * Math.PI * 2) / 5;
      for (const offset of [-0.04, 0.04]) {
        const spokeGeo = new THREE.BoxGeometry(0.03, tireRadius * 0.58, 0.02);
        createMesh(spokeGeo, metalMat, wGroup, [outwardSign * (tireWidth * 0.48), Math.sin(angle + offset) * 0.12, Math.cos(angle + offset) * 0.12], [angle + offset, 0, 0]);
      }
    }

    // Center Lock Nut (Red on Right / Blue on Left, on OUTWARD side!)
    const nutMat = new THREE.MeshStandardMaterial({ color: outwardSign > 0 ? 0xd90429 : 0x00f0ff, metalness: 0.9, roughness: 0.1 });
    const nutGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.1, 6);
    createMesh(nutGeo, nutMat, wGroup, [outwardSign * (tireWidth * 0.52), 0, 0], [0, 0, Math.PI / 2]);

    // Carbon-Ceramic Ventilated Disc & Brembo Caliper
    const brakeDiscGeo = new THREE.CylinderGeometry(tireRadius * 0.7, tireRadius * 0.7, 0.04, 24);
    createMesh(brakeDiscGeo, brakeDiscMat, wGroup, [outwardSign * 0.02, 0, 0], [0, 0, Math.PI / 2]);

    const caliperGeo = new THREE.BoxGeometry(0.08, 0.16, 0.14);
    createMesh(caliperGeo, yellowSponsorMat, wGroup, [outwardSign * 0.02, tireRadius * 0.45, 0]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'f1',
    name: '1:1复刻真实F1赛车 (Formula 1 Grand Prix Bolide)',
    styleTag: '真实1:1复刻样式',
    description: '1:1比例打造的现代F1方程式赛车。配备4喷口钛合金排气管、双侧面向外完全重构的5双辐锻造轮毂与游戏同款双层氮气喷射。',
    specs: {
      '风格类型': '1:1 Formula 1 Grand Prix Racing Car',
      '氮气特效': nitroBoost ? '🚀 游戏同款双层火焰 (In-Game Boost Active)' : '待机关闭 (Off)',
      '轮毂技术': '双侧外向 3D 锻造轮毂 + 阳极防松螺母',
      '尾喷设计': 'F1 四喷口钛合金排气管'
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
