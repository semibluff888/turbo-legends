import * as THREE from 'three';

import { getCharacter } from '../game/characters.js';
import { DEFAULT_ONLINE_LOADOUT, sanitizeOnlineLoadout } from '../game/appearance.js';
import { makeKartPreview } from './kartMesh.js';

const MAX_PIXEL_RATIO = 2;

function addBox(parent, material, size, position, {
  name = '', rotation = null, castShadow = false, receiveShadow = false,
} = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  parent.add(mesh);
  return mesh;
}

/** Build the fixed low-poly garage behind the rotating racer preview. */
export function buildShowroomGarage() {
  const garage = new THREE.Group();
  garage.name = 'showroom-garage';

  const materials = {
    wall: new THREE.MeshStandardMaterial({ color: 0x171a20, roughness: 0.96, metalness: 0.04 }),
    wallInset: new THREE.MeshStandardMaterial({ color: 0x0d1015, roughness: 0.9, metalness: 0.12 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x343b46, roughness: 0.55, metalness: 0.68 }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0x15191f, roughness: 0.6, metalness: 0.62 }),
    shutterA: new THREE.MeshStandardMaterial({ color: 0x3b424a, roughness: 0.62, metalness: 0.58 }),
    shutterB: new THREE.MeshStandardMaterial({ color: 0x30363e, roughness: 0.66, metalness: 0.52 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x242931, roughness: 0.78, metalness: 0.16 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xf5fbff, emissive: 0xd8f3ff, emissiveIntensity: 2.7, roughness: 0.18,
    }),
    red: new THREE.MeshStandardMaterial({ color: 0x681b2b, roughness: 0.48, metalness: 0.42 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x090a0c, roughness: 0.86, metalness: 0.05 }),
  };

  addBox(garage, materials.floor, [9.4, 0.14, 8.2], [0, -0.085, -0.25], {
    name: 'garage-floor', receiveShadow: true,
  });

  addBox(garage, materials.wall, [8.8, 4.5, 0.22], [0, 2.1, -3.38], {
    name: 'garage-back-wall', receiveShadow: true,
  });
  addBox(garage, materials.wall, [0.22, 4.5, 7.2], [-4.35, 2.1, -0.15], {
    name: 'garage-side-wall', receiveShadow: true,
  });
  addBox(garage, materials.steelDark, [8.95, 0.22, 0.32], [0, 4.04, -3.2]);
  addBox(garage, materials.steelDark, [0.24, 0.24, 7.2], [-4.17, 4.02, -0.15]);

  const shutter = new THREE.Group();
  shutter.name = 'garage-roller-door';
  shutter.position.set(-0.65, 0, -3.22);
  addBox(shutter, materials.wallInset, [4.92, 3.35, 0.16], [0, 1.68, 0]);
  for (let index = 0; index < 18; index += 1) {
    addBox(
      shutter,
      index % 2 ? materials.shutterA : materials.shutterB,
      [4.64, 0.135, 0.11],
      [0, 0.25 + index * 0.165, 0.105],
      { name: 'garage-roller-slat' },
    );
  }
  addBox(shutter, materials.steelDark, [0.18, 3.48, 0.28], [-2.43, 1.7, 0.12]);
  addBox(shutter, materials.steelDark, [0.18, 3.48, 0.28], [2.43, 1.7, 0.12]);
  addBox(shutter, materials.steel, [5.04, 0.24, 0.3], [0, 3.39, 0.12]);
  garage.add(shutter);

  const cabinet = new THREE.Group();
  cabinet.name = 'garage-tool-cabinet';
  cabinet.position.set(-3.45, 0, -3.03);
  addBox(cabinet, materials.red, [1.04, 1.14, 0.55], [0, 0.57, 0]);
  for (let index = 0; index < 4; index += 1) {
    addBox(cabinet, materials.steelDark, [0.78, 0.035, 0.035], [0, 0.28 + index * 0.23, 0.292]);
  }
  addBox(cabinet, materials.steel, [1.16, 0.09, 0.65], [0, 1.17, 0]);
  garage.add(cabinet);

  const tires = new THREE.Group();
  tires.name = 'garage-tire-stack';
  tires.position.set(-3.36, 0, -2.1);
  for (let index = 0; index < 3; index += 1) {
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.115, 10, 24), materials.rubber);
    tire.rotation.x = -Math.PI / 2;
    tire.position.y = 0.12 + index * 0.2;
    tires.add(tire);
  }
  garage.add(tires);

  for (const x of [-2.05, 1.55]) {
    addBox(garage, materials.steelDark, [2.35, 0.13, 0.3], [x, 3.55, -0.78]);
    addBox(garage, materials.lamp, [2.08, 0.045, 0.19], [x, 3.47, -0.68]);
  }

  return garage;
}

/** One lightweight WebGL showroom shared by the Room card and loadout dialog. */
export class KartShowroom {
  constructor({ document = globalThis.document, window = globalThis.window } = {}) {
    this.document = document;
    this.window = window;
    this.canvas = document?.createElement?.('canvas') || null;
    if (this.canvas) {
      this.canvas.className = 'online-loadout-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.preview = null;
    this.host = null;
    this.failed = false;
    this.loadout = { ...DEFAULT_ONLINE_LOADOUT };
    this.rotation = -0.55;
    this._autoPause = 0;
    this._dragging = false;
    this._dragDistance = 0;
    this._lastPointerX = 0;
    this._width = 0;
    this._height = 0;
    this._previewCenter = new THREE.Vector3(0, 0.72, 0);
    this._previewDistance = 4;
    this._cameraOffset = new THREE.Vector3(0.48, 0.30, 0.78);
    this._reducedMotion = Boolean(window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    this._wirePointer();
  }

  _wirePointer() {
    if (!this.canvas) return;
    this.canvas.addEventListener('pointerdown', (event) => {
      if (this.failed) return;
      this._dragging = true;
      this._dragDistance = 0;
      this._lastPointerX = event.clientX;
      this._autoPause = 2;
      this.canvas.setPointerCapture?.(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this._dragging) return;
      const dx = event.clientX - this._lastPointerX;
      this._lastPointerX = event.clientX;
      this._dragDistance += Math.abs(dx);
      this.rotation += dx * 0.012;
    });
    const stopDrag = (event) => {
      if (!this._dragging) return;
      this._dragging = false;
      this.canvas.releasePointerCapture?.(event.pointerId);
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
    this.canvas.addEventListener('click', (event) => {
      if (this._dragDistance <= 6) return;
      event.preventDefault();
      event.stopPropagation();
      this._dragDistance = 0;
    }, true);
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._setFailed();
    });
  }

  _ensureRenderer() {
    if (this.renderer || this.failed || !this.canvas) return Boolean(this.renderer);
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.setClearColor(0x000000, 0);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0b0d12);
      this.scene.fog = new THREE.Fog(0x0b0d12, 7.2, 14.5);
      this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      this.camera.position.set(3.7, 2.45, 5.3);
      this.camera.lookAt(0, 0.72, 0);

      this.scene.add(buildShowroomGarage());
      this.scene.add(new THREE.HemisphereLight(0xd9efff, 0x171015, 1.7));
      const key = new THREE.DirectionalLight(0xffffff, 3.4);
      key.position.set(-3.8, 6.2, 4.5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -4.5;
      key.shadow.camera.right = 4.5;
      key.shadow.camera.top = 4.5;
      key.shadow.camera.bottom = -4.5;
      this.scene.add(key);
      const rim = new THREE.DirectionalLight(0xff7ac6, 2.2);
      rim.position.set(4.5, 2.8, -4.2);
      this.scene.add(rim);
      const garageFill = new THREE.PointLight(0x7fe3ff, 7.5, 8, 2);
      garageFill.position.set(-2.2, 3.15, 0.8);
      this.scene.add(garageFill);
      this._rebuildPreview();
      return true;
    } catch {
      this._setFailed();
      return false;
    }
  }

  _setFailed() {
    this.failed = true;
    this.host?.classList?.add('is-fallback');
    if (this.canvas) this.canvas.hidden = true;
  }

  _rebuildPreview() {
    if (!this.scene) return;
    if (this.preview) {
      this.scene.remove(this.preview.group);
      this.preview.dispose?.();
    }
    const character = getCharacter(this.loadout.characterId);
    this.preview = makeKartPreview(character, this.loadout);
    this.preview.group.rotation.y = this.rotation;
    this.preview.group.position.y = 0.03;
    this.scene.add(this.preview.group);
    const bounds = new THREE.Box3().setFromObject(this.preview.group);
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    this._previewCenter.copy(sphere.center);
    this._previewDistance = Math.max(3.5, sphere.radius * 3.35);
    this._fitCamera();
  }

  _fitCamera(aspect = this.camera?.aspect || 1) {
    if (!this.camera) return;
    // The dialog preview is tall and narrow. Pull back only there so the full
    // racer remains visible while the wider Room card keeps its hero framing.
    const narrowFit = Math.max(1, 1.05 / Math.max(0.5, aspect));
    this.camera.position.copy(this._previewCenter)
      .addScaledVector(this._cameraOffset, this._previewDistance * narrowFit);
    this.camera.lookAt(this._previewCenter);
  }

  attach(host) {
    if (!host || !this.canvas) return false;
    this.host?.classList?.remove('has-showroom', 'is-fallback');
    this.host = host;
    host.classList?.add('has-showroom');
    host.appendChild(this.canvas);
    this.canvas.hidden = false;
    if (!this._ensureRenderer()) {
      this._setFailed();
      return false;
    }
    this._width = 0;
    this._height = 0;
    return true;
  }

  detach() {
    this.host?.classList?.remove('has-showroom', 'is-fallback');
    this.canvas?.remove();
    this.host = null;
  }

  setLoadout(loadout) {
    const next = sanitizeOnlineLoadout(loadout);
    if (next.characterId === this.loadout.characterId
      && next.paintId === this.loadout.paintId
      && next.avatarId === this.loadout.avatarId) return false;
    this.loadout = next;
    this._rebuildPreview();
    return true;
  }

  update(dt) {
    if (!this.renderer || !this.scene || !this.camera || !this.preview || !this.host?.isConnected) return;
    const width = Math.max(1, Math.round(this.host.clientWidth || 1));
    const height = Math.max(1, Math.round(this.host.clientHeight || 1));
    if (width !== this._width || height !== this._height) {
      this._width = width;
      this._height = height;
      this.renderer.setPixelRatio(Math.min(this.window?.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this._fitCamera(this.camera.aspect);
    }
    this._autoPause = Math.max(0, this._autoPause - dt);
    if (!this._dragging && !this._reducedMotion && this._autoPause <= 0) {
      this.rotation += dt * 0.48;
    }
    this.preview.update?.(performance.now() * 0.001, dt);
    this.preview.group.rotation.y = this.rotation;
    this.preview.group.position.y = 0.03 + Math.sin(performance.now() * 0.0018) * 0.025;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.detach();
    if (this.preview) {
      this.scene?.remove(this.preview.group);
      this.preview.dispose?.();
      this.preview = null;
    }
    this.scene?.traverse((object) => {
      if (object.geometry && object !== this.preview?.group) object.geometry.dispose?.();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose?.();
      }
    });
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
