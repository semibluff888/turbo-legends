// Production adapter for the six shared procedural Racer bodies.
// The showroom and live race renderer consume this single normalized contract.

import * as THREE from 'three';
import {
  buildBreezeKart,
  buildChibiCuteRacer,
  buildCyberHypercar,
  buildFormula1RealRacer,
  buildQuantumHoverRacer,
  buildRuggedOffroadBeast,
} from './racer-model-builders.js';

const MODEL_CONFIG = Object.freeze({
  cyber: Object.freeze({ build: buildCyberHypercar, scale: 0.68 }),
  chibi: Object.freeze({ build: buildChibiCuteRacer, scale: 0.95 }),
  f1: Object.freeze({ build: buildFormula1RealRacer, scale: 0.66 }),
  quantum: Object.freeze({ build: buildQuantumHoverRacer, scale: 0.70 }),
  offroad: Object.freeze({ build: buildRuggedOffroadBeast, scale: 0.75 }),
  breeze: Object.freeze({ build: buildBreezeKart, scale: 0.88 }),
});

function simpleGeometryKey(geometry) {
  if (!geometry?.parameters) return geometry?.uuid || '';
  if (!['BoxGeometry', 'CylinderGeometry', 'ConeGeometry', 'SphereGeometry', 'TorusGeometry']
    .includes(geometry.type)) return geometry.uuid;
  try {
    return `${geometry.type}:${JSON.stringify(geometry.parameters)}`;
  } catch {
    return geometry.uuid;
  }
}

/** Collapse repeated rigid sibling details (spokes, tread blocks, springs) into one draw node. */
function instanceRepeatedMeshes(parent) {
  for (const child of [...parent.children]) {
    if (child.isGroup || child.isObject3D && !child.isMesh) instanceRepeatedMeshes(child);
  }

  const groups = new Map();
  for (const child of [...parent.children]) {
    if (!child.isMesh || child.isInstancedMesh || Array.isArray(child.material)) continue;
    const key = `${simpleGeometryKey(child.geometry)}:${child.material?.uuid || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(child);
  }

  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const first = meshes[0];
    if (meshes.some((mesh) => mesh.visible !== first.visible)) continue;
    const instanced = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    instanced.name = first.name;
    instanced.visible = first.visible;
    instanced.castShadow = first.castShadow;
    instanced.receiveShadow = first.receiveShadow;
    for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes[index];
      mesh.updateMatrix();
      instanced.setMatrixAt(index, mesh.matrix);
      parent.remove(mesh);
      if (index > 0 && mesh.geometry !== first.geometry) mesh.geometry.dispose();
    }
    instanced.instanceMatrix.needsUpdate = true;
    parent.add(instanced);
  }
}

function replacePhysicalMaterials(root, paintMaterials) {
  const replacements = new Map();
  const replace = (material) => {
    if (!material?.isMeshPhysicalMaterial) return material;
    if (replacements.has(material)) return replacements.get(material);
    const glass = Number(material.transmission) > 0;
    const standard = new THREE.MeshStandardMaterial({
      color: material.color,
      emissive: material.emissive,
      emissiveIntensity: material.emissiveIntensity,
      roughness: Math.max(glass ? 0.22 : 0.16, material.roughness),
      metalness: material.metalness,
      transparent: material.transparent || glass,
      opacity: glass ? Math.min(0.58, material.opacity) : material.opacity,
      side: material.side,
      depthWrite: glass ? false : material.depthWrite,
    });
    replacements.set(material, standard);
    return standard;
  };

  root.traverse((object) => {
    if (!object.material) return;
    if (Array.isArray(object.material)) object.material = object.material.map(replace);
    else object.material = replace(object.material);
  });
  for (const material of replacements.keys()) material.dispose();
  return paintMaterials.map((material) => replacements.get(material) || material);
}

function wrapWheels(wheels) {
  const frontPivots = [];
  const spinGroups = [];
  for (const wheel of wheels) {
    const parent = wheel.parent;
    if (!parent) continue;
    const position = wheel.position.clone();
    const front = position.z > 0;
    parent.remove(wheel);
    const pivot = new THREE.Group();
    pivot.position.copy(position);
    wheel.position.set(0, 0, 0);
    pivot.add(wheel);
    parent.add(pivot);
    spinGroups.push(wheel);
    if (front) frontPivots.push(pivot);
  }
  return { frontPivots, spinGroups };
}

function addBrakeLight(root, bounds) {
  const size = bounds.getSize(new THREE.Vector3());
  const material = new THREE.MeshStandardMaterial({
    color: 0x3a0508,
    emissive: 0xff2a2a,
    emissiveIntensity: 0.15,
    roughness: 0.4,
  });
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(0.55, size.x * 0.34), 0.08, 0.055),
    material,
  );
  mesh.position.set(0, bounds.min.y + size.y * 0.34, bounds.min.z + 0.035);
  mesh.castShadow = false;
  root.add(mesh);
  return material;
}

function addDriftAnchors(root, bounds) {
  const size = bounds.getSize(new THREE.Vector3());
  const left = new THREE.Object3D();
  const right = new THREE.Object3D();
  const x = size.x * 0.48;
  const y = bounds.min.y + Math.max(0.08, size.y * 0.08);
  const z = bounds.min.z + size.z * 0.27;
  left.position.set(-x, y, z);
  right.position.set(x, y, z);
  root.add(left, right);
  return { left, right };
}

function modelMetrics(root) {
  let drawNodes = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.visible) return;
    drawNodes += 1;
    const count = object.geometry?.index?.count
      || object.geometry?.attributes?.position?.count || 0;
    triangles += Math.floor(count / 3) * (object.isInstancedMesh ? object.count : 1);
  });
  return { drawNodes, triangles };
}

/**
 * @param {object} character entry from characters.js
 * @param {object} appearance resolved paint/avatar values
 * @param {{quality?:'race'|'showroom', buildDriver?:(mount:THREE.Object3D)=>void}} options
 */
export function buildRacerModel(character, appearance, { quality = 'race', buildDriver } = {}) {
  const config = MODEL_CONFIG[character?.modelId];
  if (!config) throw new TypeError(`No production model for Racer: ${character?.id || 'unknown'}`);

  const model = config.build(
    appearance.color,
    appearance.accentColor,
    appearance.avatarId || 'cat',
    false,
    false,
  );
  const runtime = model.runtimeRefs || {};
  if (runtime.driverMount && buildDriver) buildDriver(runtime.driverMount);
  let paintMaterials = [...(runtime.paintMaterials || [])];
  if (quality === 'race') paintMaterials = replacePhysicalMaterials(model.group, paintMaterials);

  const rawBounds = new THREE.Box3().setFromObject(model.group);
  const brakeMat = addBrakeLight(model.group, rawBounds);
  const anchors = addDriftAnchors(model.group, rawBounds);
  const { frontPivots, spinGroups } = wrapWheels(runtime.wheels || []);
  instanceRepeatedMeshes(model.group);

  const group = new THREE.Group();
  model.group.scale.setScalar(config.scale);
  group.add(model.group);
  const scaledBounds = new THREE.Box3().setFromObject(group);
  model.group.position.y -= scaledBounds.min.y;
  const bounds = new THREE.Box3().setFromObject(group);

  group.traverse((object) => {
    if (!object.isMesh) return;
    const smallDetail = object.geometry?.type === 'BoxGeometry'
      && Math.max(
        object.geometry.parameters?.width || 0,
        object.geometry.parameters?.height || 0,
        object.geometry.parameters?.depth || 0,
      ) < 0.13;
    object.castShadow = !object.material?.transparent && !smallDetail;
    object.receiveShadow = !object.material?.transparent;
  });
  for (const flame of runtime.flames || []) {
    flame.visible = false;
    flame.traverse((object) => { object.castShadow = false; object.receiveShadow = false; });
  }

  return {
    group,
    modelId: character.modelId,
    appearance,
    bounds,
    badgeY: bounds.max.y + 0.52,
    refs: {
      paintMaterials,
      brakeMat,
      frontPivots,
      spinGroups,
      flames: runtime.flames || [],
      driverMount: runtime.driverMount || null,
      anchorL: anchors.left,
      anchorR: anchors.right,
    },
    metrics: modelMetrics(group),
    update(time, dt) { runtime.animate?.(time, dt); },
    dispose() { model.dispose(); },
  };
}

export const RACER_MODEL_IDS = Object.freeze(Object.keys(MODEL_CONFIG));
