import * as THREE from 'three';
import { getCharacter } from '../src/game/characters.js';
import { DEFAULT_ONLINE_LOADOUT } from '../src/game/appearance.js';
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

// ============================================================================
// 1. DEFAULT ROOM MODEL (DEFAULT KART)
// ============================================================================
export function buildDefaultKart(characterId = 'kit', loadout = DEFAULT_ONLINE_LOADOUT) {
  const character = getCharacter(characterId);
  const preview = makeKartPreview(character, loadout);
  
  return {
    group: preview.group,
    id: 'default',
    name: '默认房间赛车 (Default Arcade Kart)',
    styleTag: '经典游戏样式',
    description: '多人游戏房间 CUSTOMIZE RACER 默认使用的高亮卡丁车模型，使用方块和简易几何体拼接，充满足球卡丁风格。',
    specs: {
      '风格类型': 'Chunky Toy Kart',
      '网格组成': 'Three.js 原生基础几何体 (Box / Cylinder / Sphere)',
      '材质材质': '标准 MeshStandardMaterial',
      '悬挂结构': '固定轮轴无避震',
      '气动翼': '前包围 + 后防撞杠'
    },
    update(time, dt) {
      // Gentle floating animation
      preview.group.position.y = 0.03 + Math.sin(time * 2) * 0.015;
    },
    dispose() {
      preview.dispose();
    }
  };
}

// ============================================================================
// 2. CYBER NEON HYPERCAR (赛博酷炫超跑 - 华丽酷炫风格)
// ============================================================================
export function buildCyberHypercar(primaryColor = 0x0f172a, accentColor = 0x00f0ff) {
  const group = new THREE.Group();

  // Materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    roughness: 0.15,
    metalness: 0.9,
    envMapIntensity: 1.5,
  });
  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x111625,
    roughness: 0.4,
    metalness: 0.8,
  });
  const neonMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    emissive: accentColor,
    emissiveIntensity: 3.5,
    roughness: 0.2,
    metalness: 0.5,
  });
  const neonMagentaMat = new THREE.MeshStandardMaterial({
    color: 0xff007f,
    emissive: 0xff007f,
    emissiveIntensity: 4.0,
    roughness: 0.1,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x00f0ff,
    transparent: true,
    opacity: 0.45,
    roughness: 0.05,
    transmission: 0.9,
    thickness: 0.5,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10,
    roughness: 0.85,
    metalness: 0.2,
  });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0xff3300,
    metalness: 0.9,
    roughness: 0.2,
  });

  // 1. Sleek Aerodynamic Fuselage
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

  const extrudeSettings = { depth: 0.35, bevelEnabled: true, bevelSegments: 5, steps: 2, bevelSize: 0.08, bevelThickness: 0.08 };
  const chassisGeo = new THREE.ExtrudeGeometry(mainChassisShape, extrudeSettings);
  chassisGeo.center();
  const mainChassis = createMesh(chassisGeo, bodyMat, group, [0, 0.38, 0], [Math.PI / 2, 0, 0]);

  // Front Splitter / Wing Intake
  const splitterGeo = new THREE.BoxGeometry(1.8, 0.06, 0.6);
  createMesh(splitterGeo, carbonMat, group, [0, 0.16, 1.85]);

  // Neon Front Light Bar
  const frontLightGeo = new THREE.BoxGeometry(1.5, 0.04, 0.12);
  createMesh(frontLightGeo, neonMat, group, [0, 0.22, 1.96]);

  // Side Air Channels
  for (const side of [-1, 1]) {
    const podGeo = new THREE.BoxGeometry(0.25, 0.35, 2.2);
    createMesh(podGeo, carbonMat, group, [side * 0.78, 0.36, -0.1], [0, side * 0.08, 0]);

    // Neon side strips
    const stripGeo = new THREE.BoxGeometry(0.04, 0.05, 2.4);
    createMesh(stripGeo, neonMat, group, [side * 0.92, 0.34, -0.1]);

    // Side Air Vents
    const ventGeo = new THREE.CylinderGeometry(0.08, 0.14, 0.4, 6);
    createMesh(ventGeo, neonMagentaMat, group, [side * 0.72, 0.35, 0.7], [Math.PI / 2, 0, 0]);
  }

  // Cyber Cockpit Canopy
  const canopyGeo = new THREE.SphereGeometry(0.55, 16, 16);
  canopyGeo.scale(1.0, 0.65, 2.2);
  createMesh(canopyGeo, glassMat, group, [0, 0.62, 0.1]);

  // HUD & Driver Seat interior glow
  const hudGeo = new THREE.PlaneGeometry(0.35, 0.2);
  createMesh(hudGeo, neonMat, group, [0, 0.58, 0.4], [-0.3, 0, 0]);

  // Plasma Thruster Exhaust
  const thrusters = [];
  for (const x of [-0.32, 0.32]) {
    const pipeGeo = new THREE.CylinderGeometry(0.16, 0.2, 0.6, 16);
    createMesh(pipeGeo, carbonMat, group, [x, 0.42, -1.85], [Math.PI / 2, 0, 0]);

    const plasmaGeo = new THREE.ConeGeometry(0.14, 0.7, 16);
    plasmaGeo.translate(0, -0.35, 0);
    const plasma = createMesh(plasmaGeo, neonMagentaMat, group, [x, 0.42, -2.15], [-Math.PI / 2, 0, 0]);
    thrusters.push(plasma);

    // Glowing Ring
    const ringGeo = new THREE.TorusGeometry(0.17, 0.025, 8, 24);
    createMesh(ringGeo, neonMat, group, [x, 0.42, -1.86]);
  }

  // Active Rear Cyber Wing
  const wingBladeGeo = new THREE.BoxGeometry(1.9, 0.05, 0.38);
  createMesh(wingBladeGeo, bodyMat, group, [0, 0.88, -1.75]);
  const wingEdgeGeo = new THREE.BoxGeometry(1.94, 0.06, 0.08);
  createMesh(wingEdgeGeo, neonMat, group, [0, 0.88, -1.92]);

  for (const side of [-1, 1]) {
    const pylonGeo = new THREE.BoxGeometry(0.06, 0.45, 0.25);
    createMesh(pylonGeo, carbonMat, group, [side * 0.55, 0.66, -1.7], [0.3, 0, 0]);
  }

  // Photon Wheels with Glowing Halo Rims & Calipers
  const wheels = [];
  const wheelPositions = [
    [-0.92, 0.33, 1.25],
    [0.92, 0.33, 1.25],
    [-0.96, 0.36, -1.25],
    [0.96, 0.36, -1.25],
  ];

  for (const [wx, wy, wz] of wheelPositions) {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    // Tire
    const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.32, 24);
    createMesh(tireGeo, tireMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // Glowing Photon Ring inside Wheel
    const haloGeo = new THREE.TorusGeometry(0.24, 0.03, 8, 24);
    createMesh(haloGeo, neonMat, wGroup, [wx > 0 ? -0.02 : 0.02, 0, 0], [0, Math.PI / 2, 0]);

    // Brake Disc & Caliper
    const discGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.04, 16);
    createMesh(discGeo, carbonMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    const caliperGeo = new THREE.BoxGeometry(0.08, 0.14, 0.12);
    createMesh(caliperGeo, brakeMat, wGroup, [0, 0.15, 0]);

    wheels.push(wGroup);
  }

  return {
    group,
    id: 'cyber',
    name: '赛博朋克超跑 (Cyber Neon Hypercar)',
    styleTag: '华丽酷炫风格',
    description: '采用流线型低矮车身、悬浮光子轮毂与强力双等离子喷气发动机。车身贯穿高亮霓虹光轨，展现未来感与极致速度。',
    specs: {
      '风格类型': 'Futuristic Sci-Fi Speedster',
      '动力系统': '双等离子脉冲喷气引擎 (Dual Plasma Jet)',
      '光轨材质': '高阶自发光 HDR Emissive Neon',
      '座舱设计': '全景透光光子玻璃风挡',
      '轮毂技术': '磁悬浮光轮 + 红外煞车卡钳'
    },
    update(time, dt) {
      // Thruster pulse effect
      const pulse = 1 + Math.sin(time * 20) * 0.15;
      thrusters.forEach((t) => t.scale.set(pulse, 0.7 + pulse * 0.4, pulse));
      // Wheel spinning animation
      wheels.forEach((w) => {
        w.children[0].rotation.x += dt * 8;
      });
      group.position.y = 0.02 + Math.sin(time * 3) * 0.01;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 3. CHIBI SWEET RACER (Q萌糖果卡丁车 - 卡通可爱风格)
// ============================================================================
export function buildChibiCuteRacer(primaryColor = 0xff7ebb, accentColor = 0xffe66d) {
  const group = new THREE.Group();

  // Pastel Materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    roughness: 0.25,
    metalness: 0.1,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.3,
    metalness: 0.1,
  });
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x222233,
    roughness: 0.1,
  });
  const cheekMat = new THREE.MeshStandardMaterial({
    color: 0xff4d6d,
    roughness: 0.4,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x3d354a,
    roughness: 0.7,
  });
  const candyRimMat = new THREE.MeshStandardMaterial({
    color: 0x4cc9f0,
    roughness: 0.3,
  });

  // 1. Chibi Macaron Body (Round & Chubby)
  const bodyGeo = new THREE.SphereGeometry(0.85, 24, 24);
  bodyGeo.scale(1.15, 0.75, 1.4);
  createMesh(bodyGeo, bodyMat, group, [0, 0.55, 0]);

  // Cute Belly / Front Bumper
  const bellyGeo = new THREE.SphereGeometry(0.65, 20, 20);
  bellyGeo.scale(1.0, 0.5, 0.9);
  createMesh(bellyGeo, whiteMat, group, [0, 0.42, 0.5]);

  // 2. Oversized Cute Eye Headlights (with highlights!)
  const leftEyeGroup = new THREE.Group();
  leftEyeGroup.position.set(-0.35, 0.65, 1.05);
  group.add(leftEyeGroup);

  const rightEyeGroup = new THREE.Group();
  rightEyeGroup.position.set(0.35, 0.65, 1.05);
  group.add(rightEyeGroup);

  for (const eGroup of [leftEyeGroup, rightEyeGroup]) {
    // White eye socket
    const socketGeo = new THREE.SphereGeometry(0.22, 16, 16);
    socketGeo.scale(1, 1.1, 0.6);
    createMesh(socketGeo, whiteMat, eGroup);

    // Pupil
    const pupilGeo = new THREE.SphereGeometry(0.14, 12, 12);
    pupilGeo.scale(1, 1, 0.5);
    createMesh(pupilGeo, eyeMat, eGroup, [0, 0, 0.1]);

    // Cute Glint Stars
    const glint1 = new THREE.SphereGeometry(0.05, 8, 8);
    createMesh(glint1, whiteMat, eGroup, [0.04, 0.05, 0.16]);
    const glint2 = new THREE.SphereGeometry(0.025, 8, 8);
    createMesh(glint2, whiteMat, eGroup, [-0.04, -0.04, 0.16]);
  }

  // Rosy Cheeks
  for (const side of [-1, 1]) {
    const cheekGeo = new THREE.SphereGeometry(0.12, 12, 12);
    cheekGeo.scale(1.2, 0.6, 0.4);
    createMesh(cheekGeo, cheekMat, group, [side * 0.55, 0.48, 1.0]);
  }

  // Cute Bobbing Bear Ears on Roof
  const ears = [];
  for (const side of [-1, 1]) {
    const earGroup = new THREE.Group();
    earGroup.position.set(side * 0.42, 1.12, 0.1);
    group.add(earGroup);
    ears.push(earGroup);

    const outerEarGeo = new THREE.SphereGeometry(0.22, 16, 16);
    outerEarGeo.scale(1, 1, 0.6);
    createMesh(outerEarGeo, bodyMat, earGroup);

    const innerEarGeo = new THREE.SphereGeometry(0.13, 12, 12);
    innerEarGeo.scale(1, 1, 0.5);
    createMesh(innerEarGeo, accentMat, earGroup, [0, 0, 0.05]);
  }

  // Cockpit Cutout & Cute Pilot Bear
  const cockpitGeo = new THREE.CylinderGeometry(0.48, 0.45, 0.35, 16);
  createMesh(cockpitGeo, whiteMat, group, [0, 0.85, -0.1]);

  // Cute Pilot Head
  const pilotHeadGeo = new THREE.SphereGeometry(0.28, 16, 16);
  createMesh(pilotHeadGeo, accentMat, group, [0, 1.05, -0.1]);

  // Goggles on Pilot
  const goggleGeo = new THREE.TorusGeometry(0.1, 0.03, 8, 16);
  createMesh(goggleGeo, eyeMat, group, [-0.1, 1.08, 0.14], [0, 0, 0]);
  createMesh(goggleGeo, eyeMat, group, [0.1, 1.08, 0.14], [0, 0, 0]);

  // Donut Bubble Exhaust Pipes
  for (const x of [-0.3, 0.3]) {
    const pipeGeo = new THREE.TorusGeometry(0.12, 0.05, 10, 16);
    createMesh(pipeGeo, accentMat, group, [x, 0.55, -1.2], [Math.PI / 2, 0, 0]);
  }

  // Heart-Shaped Rear Spoiler
  const spoilerGroup = new THREE.Group();
  spoilerGroup.position.set(0, 1.1, -1.0);
  group.add(spoilerGroup);

  const wingGeo = new THREE.BoxGeometry(1.1, 0.08, 0.3);
  createMesh(wingGeo, accentMat, spoilerGroup);

  for (const side of [-1, 1]) {
    const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.4);
    createMesh(postGeo, whiteMat, spoilerGroup, [side * 0.35, -0.2, 0]);
  }

  // Chubby Candy Wheels
  const wheels = [];
  const wPositions = [
    [-0.75, 0.3, 0.75],
    [0.75, 0.3, 0.75],
    [-0.75, 0.3, -0.75],
    [0.75, 0.3, -0.75],
  ];

  for (const [wx, wy, wz] of wPositions) {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    group.add(wGroup);

    // Thick Donut Tire
    const tireGeo = new THREE.TorusGeometry(0.24, 0.12, 12, 24);
    createMesh(tireGeo, tireMat, wGroup, [0, 0, 0], [0, Math.PI / 2, 0]);

    // Star Hubcap
    const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.06, 5);
    createMesh(hubGeo, candyRimMat, wGroup, [wx > 0 ? 0.08 : -0.08, 0, 0], [0, 0, Math.PI / 2]);

    wheels.push(wGroup);
  }

  return {
    group,
    id: 'chibi',
    name: 'Q萌糖果卡丁车 (Chibi Sweet Racer)',
    styleTag: '卡通可爱风格',
    description: '圆滚滚马卡龙造型的超级可爱卡丁车，拥有萌动大眼睛、摇晃的熊耳朵与甜心泡泡排气管，充满了童趣与欢快气息。',
    specs: {
      '风格类型': 'Chibi Cartoon / Kawaii Style',
      '车身造型': '圆润马卡龙膨胀机舱',
      '车灯设计': '双层高光萌动闪亮眼灯',
      '动态细节': '风中摇晃的耳朵与心形尾翼',
      '轮胎风格': '糖果甜甜圈厚轮胎'
    },
    update(time, dt) {
      // Wobbly ear bounce
      ears[0].rotation.z = Math.sin(time * 6) * 0.12;
      ears[1].rotation.z = -Math.sin(time * 6) * 0.12;
      // Playful bobbing animation
      group.position.y = 0.05 + Math.abs(Math.sin(time * 4)) * 0.05;
      group.rotation.z = Math.sin(time * 4) * 0.04;
      // Wheel spin
      wheels.forEach((w) => {
        w.children[0].rotation.z += dt * 6;
      });
    },
    dispose() {
      disposeGroup(group);
    }
  };
}

// ============================================================================
// 4. FORMULA 1 REALISTIC RACER (1:1复刻真实F1赛车 - 真实1:1复刻样式)
// ============================================================================
export function buildFormula1RealRacer(primaryColor = 0xd90429, accentColor = 0xffb703) {
  const group = new THREE.Group();

  // Authentic Motorsport Materials
  const liveryMat = new THREE.MeshStandardMaterial({
    color: primaryColor,
    roughness: 0.2,
    metalness: 0.7,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.25,
    metalness: 0.6,
  });
  const carbonWeaveMat = new THREE.MeshStandardMaterial({
    color: 0x14171c,
    roughness: 0.45,
    metalness: 0.85,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x8d99ae,
    metalness: 0.95,
    roughness: 0.15,
  });
  const rubberMat = new THREE.MeshStandardMaterial({
    color: 0x16181d,
    roughness: 0.9,
    metalness: 0.1,
  });
  const brakeDiscMat = new THREE.MeshStandardMaterial({
    color: 0x4a4e69,
    metalness: 0.9,
    roughness: 0.3,
  });
  const yellowSponsorMat = new THREE.MeshBasicMaterial({
    color: 0xffd166,
  });

  // Scale factor to strictly match 1:1 professional race car proportions
  const SCALE = 0.9;
  const f1Group = new THREE.Group();
  f1Group.scale.set(SCALE, SCALE, SCALE);
  group.add(f1Group);

  // 1. Long Aerodynamic Monocoque & Nose Cone
  const noseShape = new THREE.Shape();
  noseShape.moveTo(-0.24, -2.4);
  noseShape.lineTo(-0.28, -0.6);
  noseShape.lineTo(-0.45, 0.8);
  noseShape.lineTo(-0.35, 1.6);
  noseShape.lineTo(0, 2.6); // Sharp Front Tip
  noseShape.lineTo(0.35, 1.6);
  noseShape.lineTo(0.45, 0.8);
  noseShape.lineTo(0.28, -0.6);
  noseShape.lineTo(0.24, -2.4);
  noseShape.closePath();

  const noseExtrude = { depth: 0.4, bevelEnabled: true, bevelSegments: 4, bevelSize: 0.05, bevelThickness: 0.05 };
  const noseGeo = new THREE.ExtrudeGeometry(noseShape, noseExtrude);
  noseGeo.center();
  createMesh(noseGeo, liveryMat, f1Group, [0, 0.45, 0.1], [Math.PI / 2, 0, 0]);

  // Yellow Livery Center Stripe
  const stripeGeo = new THREE.BoxGeometry(0.12, 0.02, 3.8);
  createMesh(stripeGeo, accentMat, f1Group, [0, 0.68, 0.1]);

  // 2. Complex Multi-Element F1 Front Wing & Endplates
  const fwMainGeo = new THREE.BoxGeometry(2.3, 0.04, 0.45);
  createMesh(fwMainGeo, carbonWeaveMat, f1Group, [0, 0.22, 2.4]);

  const fwFlapGeo = new THREE.BoxGeometry(2.2, 0.03, 0.22);
  createMesh(fwFlapGeo, liveryMat, f1Group, [0, 0.28, 2.3], [0.15, 0, 0]);

  for (const side of [-1, 1]) {
    // Endplates
    const epGeo = new THREE.BoxGeometry(0.04, 0.38, 0.7);
    createMesh(epGeo, liveryMat, f1Group, [side * 1.15, 0.32, 2.38]);

    // Front Wing Vortex Generators
    const vgGeo = new THREE.BoxGeometry(0.02, 0.12, 0.25);
    createMesh(vgGeo, carbonWeaveMat, f1Group, [side * 1.12, 0.48, 2.35], [0, 0, side * -0.2]);
  }

  // 3. Exposed Double-Wishbone Suspension & Pushrods
  for (const side of [-1, 1]) {
    for (const z of [1.35, 1.75]) {
      // Upper Wishbone
      const armGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.75);
      createMesh(armGeo, carbonWeaveMat, f1Group, [side * 0.55, 0.48, z], [0, 0, Math.PI / 2 + side * -0.2]);
      // Lower Wishbone
      createMesh(armGeo, carbonWeaveMat, f1Group, [side * 0.55, 0.28, z], [0, 0, Math.PI / 2 + side * 0.1]);
    }
    // Diagonal Pushrod Strut
    const rodGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.85);
    createMesh(rodGeo, metalMat, f1Group, [side * 0.52, 0.42, 1.55], [0, 0, side * 0.65]);
  }

  // 4. Sidepod Air Intakes & Radiator Ducts
  for (const side of [-1, 1]) {
    const podGeo = new THREE.BoxGeometry(0.48, 0.42, 1.8);
    createMesh(podGeo, liveryMat, f1Group, [side * 0.62, 0.44, -0.3], [0, side * -0.06, 0]);

    // Radiator Intake Opening
    const intakeGeo = new THREE.BoxGeometry(0.38, 0.32, 0.1);
    createMesh(intakeGeo, carbonWeaveMat, f1Group, [side * 0.62, 0.46, 0.58]);

    // Sponsor Decal Plate
    const decalGeo = new THREE.PlaneGeometry(0.8, 0.18);
    createMesh(decalGeo, yellowSponsorMat, f1Group, [side * 0.87, 0.46, -0.3], [0, side * (Math.PI / 2), 0]);
  }

  // 5. Cockpit Monocoque Tub & Halo Safety Structure
  const cockpitGeo = new THREE.CylinderGeometry(0.32, 0.36, 0.9, 16);
  createMesh(cockpitGeo, carbonWeaveMat, f1Group, [0, 0.55, 0.1], [Math.PI / 2, 0, 0]);

  // F1 Steering Wheel with Digital Dash
  const wheelGeo = new THREE.BoxGeometry(0.28, 0.16, 0.04);
  createMesh(wheelGeo, carbonWeaveMat, f1Group, [0, 0.62, 0.3], [-0.3, 0, 0]);

  // Driver Helmet with Mirror Visor
  const driverGeo = new THREE.SphereGeometry(0.18, 16, 16);
  createMesh(driverGeo, accentMat, f1Group, [0, 0.68, -0.15]);
  const visorGeo = new THREE.BoxGeometry(0.24, 0.08, 0.12);
  createMesh(visorGeo, metalMat, f1Group, [0, 0.7, -0.08]);

  // Halo Safety Hoop
  const haloRingGeo = new THREE.TorusGeometry(0.32, 0.035, 8, 16, Math.PI * 1.2);
  createMesh(haloRingGeo, carbonWeaveMat, f1Group, [0, 0.72, 0.15], [Math.PI / 2 + 0.3, 0, Math.PI]);
  const haloPylon = new THREE.CylinderGeometry(0.03, 0.03, 0.35);
  createMesh(haloPylon, carbonWeaveMat, f1Group, [0, 0.68, 0.42], [-0.3, 0, 0]);

  // 6. Rear Engine Cover, Shark Fin & DRS Rear Wing
  const engineCoverGeo = new THREE.ConeGeometry(0.38, 1.4, 16);
  createMesh(engineCoverGeo, liveryMat, f1Group, [0, 0.62, -0.9], [-Math.PI / 2, 0, 0]);

  // Dorsal Shark Fin
  const sharkFinShape = new THREE.Shape();
  sharkFinShape.moveTo(0, 0);
  sharkFinShape.lineTo(0, 0.45);
  sharkFinShape.lineTo(-1.2, 0.55);
  sharkFinShape.lineTo(-1.2, 0);
  sharkFinShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(sharkFinShape, { depth: 0.03, bevelEnabled: false });
  finGeo.center();
  createMesh(finGeo, liveryMat, f1Group, [0, 0.95, -1.0], [0, Math.PI / 2, 0]);

  // Rear GT / F1 Wing with DRS Actuator
  const rwMainGeo = new THREE.BoxGeometry(1.8, 0.06, 0.42);
  createMesh(rwMainGeo, carbonWeaveMat, f1Group, [0, 1.15, -1.9]);

  const rwFlapGeo = new THREE.BoxGeometry(1.76, 0.04, 0.22);
  createMesh(rwFlapGeo, liveryMat, f1Group, [0, 1.24, -1.86], [-0.2, 0, 0]);

  // DRS Actuator Beam
  const drsGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.2);
  createMesh(drsGeo, metalMat, f1Group, [0, 1.2, -1.88]);

  for (const side of [-1, 1]) {
    const rwEndplateGeo = new THREE.BoxGeometry(0.04, 0.65, 0.75);
    createMesh(rwEndplateGeo, liveryMat, f1Group, [side * 0.92, 1.05, -1.9]);
  }

  // Diffuser & LED Rain Light
  const diffuserGeo = new THREE.BoxGeometry(1.2, 0.22, 0.5);
  createMesh(diffuserGeo, carbonWeaveMat, f1Group, [0, 0.25, -1.8]);

  const rainLightGeo = new THREE.BoxGeometry(0.12, 0.12, 0.06);
  const rainLightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const rainLight = createMesh(rainLightGeo, rainLightMat, f1Group, [0, 0.35, -2.06]);

  // 7. Realistic Wide Slick Racing Tires & Brake Assemblies
  const wheels = [];
  const f1WheelPositions = [
    [-1.02, 0.38, 1.55],  // Front Left
    [1.02, 0.38, 1.55],   // Front Right
    [-0.98, 0.42, -1.45],  // Rear Left (Wider)
    [0.98, 0.42, -1.45],   // Rear Right (Wider)
  ];

  f1WheelPositions.forEach(([wx, wy, wz], idx) => {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wy, wz);
    f1Group.add(wGroup);

    const isRear = idx >= 2;
    const tireRadius = isRear ? 0.42 : 0.38;
    const tireWidth = isRear ? 0.44 : 0.36;

    // Slick Tire
    const tireGeo = new THREE.CylinderGeometry(tireRadius, tireRadius, tireWidth, 32);
    createMesh(tireGeo, rubberMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // Yellow Pirelli-style Sidewall Ring
    const sidewallGeo = new THREE.TorusGeometry(tireRadius * 0.75, 0.02, 8, 24);
    createMesh(sidewallGeo, yellowSponsorMat, wGroup, [wx > 0 ? -tireWidth * 0.52 : tireWidth * 0.52, 0, 0], [0, Math.PI / 2, 0]);

    // Forged Center-Lock Rim
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, tireWidth + 0.02, 10);
    createMesh(rimGeo, metalMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    // Carbon-Ceramic Ventilated Brake Disc
    const brakeDiscGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.05, 20);
    createMesh(brakeDiscGeo, brakeDiscMat, wGroup, [0, 0, 0], [0, 0, Math.PI / 2]);

    wheels.push(wGroup);
  });

  return {
    group,
    id: 'f1',
    name: '1:1复刻真实F1赛车 (Formula 1 Grand Prix Bolide)',
    styleTag: '真实1:1复刻样式',
    description: '严格按照现代F1方程式赛车1:1比例打造，具备多段式前翼、双叉臂悬挂系统、Halo安全环、碳纤维侧箱吸气口与DRS可变后翼。',
    specs: {
      '风格类型': '1:1 Formula 1 Grand Prix Racing Car',
      '空气动力': '多级组合前翼 + 涡流发生器 + DRS后翼',
      '悬挂结构': '独立推杆式双叉臂悬挂 (Wishbone Suspension)',
      '安全装备': '碳纤维单体壳 (Monocoque) + Halo 保护环',
      '轮胎规格': '全热熔 Slick 竞赛轮胎 + 碳陶煞车盘'
    },
    update(time, dt) {
      // Rain light blinking
      rainLight.visible = Math.sin(time * 12) > 0;
      // Wheel spin
      wheels.forEach((w) => {
        w.children[0].rotation.x += dt * 10;
      });
      group.position.y = 0.02;
    },
    dispose() {
      disposeGroup(group);
    }
  };
}
