import * as THREE from 'three';

import { getCharacter } from '../game/characters.js';
import { DEFAULT_ONLINE_LOADOUT, sanitizeOnlineLoadout } from '../game/appearance.js';
import { makeKartPreview } from './kartMesh.js';

const MAX_PIXEL_RATIO = 2;

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
      this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      this.camera.position.set(3.7, 2.45, 5.3);
      this.camera.lookAt(0, 0.72, 0);

      this.scene.add(new THREE.HemisphereLight(0xd9efff, 0x25163e, 2.1));
      const key = new THREE.DirectionalLight(0xffffff, 3.4);
      key.position.set(-3.8, 6.2, 4.5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      this.scene.add(key);
      const rim = new THREE.DirectionalLight(0xff7ac6, 2.2);
      rim.position.set(4.5, 2.8, -4.2);
      this.scene.add(rim);
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(2.25, 48),
        new THREE.MeshStandardMaterial({
          color: 0x241747, transparent: true, opacity: 0.72,
          roughness: 0.8, metalness: 0.08,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.015;
      floor.receiveShadow = true;
      this.scene.add(floor);
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
    const distance = Math.max(3.5, sphere.radius * 3.35);
    this.camera?.position.set(
      sphere.center.x + distance * 0.48,
      sphere.center.y + distance * 0.30,
      sphere.center.z + distance * 0.78,
    );
    this.camera?.lookAt(this._previewCenter);
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
