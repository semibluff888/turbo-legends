import * as THREE from 'three';
import {
  buildDefaultKart,
  buildCyberHypercar,
  buildChibiCuteRacer,
  buildFormula1RealRacer,
  buildQuantumHoverRacer,
  buildRuggedOffroadBeast,
  buildBreezeKart,
  disposeGroup,
} from './car-models.js';

export class ShowroomApp {
  constructor(container) {
    this.container = container;
    this.canvas = container.querySelector('#showroom-canvas');

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this.models = [];
    this.activeModelIndex = 0;
    this.viewMode = 'single'; // 'single' | 'grid'

    // Driver & Nitro Boost State
    this.activeAvatarId = 'cat';
    this.showDriver = true;
    this.nitroBoost = false;

    // Controls & State
    this.isAutoRotate = true;
    this.isWireframe = false;
    this.isAnimationPlaying = true;
    this.currentEnv = 'cyber';

    this.currentColor = 0x00f0ff;
    this.currentAccent = 0xff007f;

    // Pointer Dragging
    this.isDragging = false;
    this.previousPointerPosition = { x: 0, y: 0 };
    this.rotationY = -0.5;
    this.rotationX = 0.2;
    this.cameraDistance = 5.2;

    this.clock = new THREE.Clock();

    this.initWebGL();
    this.initLights();
    this.initStage();
    this.loadModels();
    this.bindEvents();

    this.animate();
  }

  initWebGL() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      35,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      100
    );
    this.camera.position.set(0, 2.2, 5.2);
    this.camera.lookAt(0, 0.5, 0);
  }

  initLights() {
    this.lightGroup = new THREE.Group();
    this.scene.add(this.lightGroup);

    this.hemiLight = new THREE.HemisphereLight(0x0f172a, 0x1e293b, 1.8);
    this.lightGroup.add(this.hemiLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.keyLight.position.set(-4, 7, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.width = 2048;
    this.keyLight.shadow.mapSize.height = 2048;
    this.lightGroup.add(this.keyLight);

    this.rimLight1 = new THREE.DirectionalLight(0x00f0ff, 2.5);
    this.rimLight1.position.set(5, 3, -4);
    this.lightGroup.add(this.rimLight1);

    this.rimLight2 = new THREE.DirectionalLight(0xff007f, 2.0);
    this.rimLight2.position.set(-5, 2, -4);
    this.lightGroup.add(this.rimLight2);
  }

  initStage() {
    this.stageGroup = new THREE.Group();
    this.scene.add(this.stageGroup);

    const stageGeo = new THREE.CylinderGeometry(2.4, 2.6, 0.15, 64);
    const stageMat = new THREE.MeshStandardMaterial({
      color: 0x0b0f19,
      roughness: 0.2,
      metalness: 0.85,
    });
    const stageMesh = new THREE.Mesh(stageGeo, stageMat);
    stageMesh.position.y = -0.075;
    stageMesh.receiveShadow = true;
    this.stageGroup.add(stageMesh);

    const ringGeo = new THREE.TorusGeometry(2.38, 0.03, 16, 64);
    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x00f0ff,
      emissiveIntensity: 3.0,
    });
    const ringMesh = new THREE.Mesh(ringGeo, this.ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = 0.001;
    this.stageGroup.add(ringMesh);

    const gridHelper = new THREE.GridHelper(20, 20, 0x00f0ff, 0x1e293b);
    gridHelper.position.y = -0.08;
    this.stageGroup.add(gridHelper);
  }

  loadModels() {
    this.models.forEach((m) => {
      this.scene.remove(m.wrapper);
      m.dispose();
    });
    this.models = [];

    // Instantiate 7 Models with Driver Avatar & Nitro Boost settings
    const modelDefs = [
      buildDefaultKart('kit', undefined, this.nitroBoost),
      buildCyberHypercar(this.currentColor, this.currentAccent, this.activeAvatarId, this.showDriver, this.nitroBoost),
      buildChibiCuteRacer(0xff7ebb, 0xffe66d, this.activeAvatarId, this.showDriver, this.nitroBoost),
      buildFormula1RealRacer(0xd90429, 0xffb703, this.activeAvatarId, this.showDriver, this.nitroBoost),
      buildQuantumHoverRacer(0x00f0ff, 0xa000ff, this.activeAvatarId, this.showDriver, this.nitroBoost),
      buildRuggedOffroadBeast(0xd97706, 0x84cc16, this.activeAvatarId, this.showDriver, this.nitroBoost),
      buildBreezeKart(this.currentColor || 0x1d70f5, this.currentAccent || 0x38bdf8, this.activeAvatarId, this.showDriver, this.nitroBoost),
    ];

    modelDefs.forEach((mod, idx) => {
      const wrapper = new THREE.Group();
      wrapper.add(mod.group);
      this.scene.add(wrapper);

      this.models.push({
        ...mod,
        wrapper,
        index: idx,
      });
    });

    if (this.activeModelIndex >= this.models.length) {
      this.activeModelIndex = 0;
    }

    if (this.isWireframe) {
      this.toggleWireframe(true);
    }

    this.updateLayout();
  }

  updateLayout() {
    const isGrid = this.viewMode === 'grid';
    const total = this.models.length;

    this.models.forEach((mod, idx) => {
      if (isGrid) {
        const spacing = 3.6;
        const xPos = (idx - (total - 1) / 2) * spacing;
        mod.wrapper.position.set(xPos, 0, 0);
        mod.wrapper.visible = true;
        mod.wrapper.scale.setScalar(0.85);
      } else {
        mod.wrapper.position.set(0, 0, 0);
        mod.wrapper.visible = idx === this.activeModelIndex;
        mod.wrapper.scale.setScalar(1.0);
      }
    });

    if (isGrid) {
      this.camera.position.set(0, 5.2, 15.0);
      this.camera.lookAt(0, 0.5, 0);
    } else {
      this.updateCameraTransform();
    }
  }

  setActiveModel(index) {
    this.activeModelIndex = index;
    if (this.viewMode === 'single') {
      this.updateLayout();
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.updateLayout();
  }

  setAvatar(avatarId) {
    this.activeAvatarId = avatarId;
    this.loadModels();
  }

  setShowDriver(enabled) {
    this.showDriver = enabled;
    this.loadModels();
  }

  setNitroBoost(enabled) {
    this.nitroBoost = enabled;
    this.loadModels();
  }

  setEnv(envType) {
    this.currentEnv = envType;
    if (envType === 'cyber') {
      this.hemiLight.color.setHex(0x0f172a);
      this.hemiLight.groundColor.setHex(0x1e293b);
      this.keyLight.color.setHex(0xffffff);
      this.keyLight.intensity = 3.2;
      this.rimLight1.color.setHex(0x00f0ff);
      this.rimLight2.color.setHex(0xff007f);
      this.ringMat.color.setHex(0x00f0ff);
      this.ringMat.emissive.setHex(0x00f0ff);
    } else if (envType === 'sunset') {
      this.hemiLight.color.setHex(0xff7e5f);
      this.hemiLight.groundColor.setHex(0xfeb47b);
      this.keyLight.color.setHex(0xffdda1);
      this.keyLight.intensity = 3.8;
      this.rimLight1.color.setHex(0xff4e50);
      this.rimLight2.color.setHex(0xf9d423);
      this.ringMat.color.setHex(0xff7e5f);
      this.ringMat.emissive.setHex(0xff7e5f);
    } else if (envType === 'spotlight') {
      this.hemiLight.color.setHex(0x111111);
      this.hemiLight.groundColor.setHex(0x050505);
      this.keyLight.color.setHex(0xffffff);
      this.keyLight.intensity = 4.0;
      this.rimLight1.color.setHex(0xffffff);
      this.rimLight2.color.setHex(0x888888);
      this.ringMat.color.setHex(0xffffff);
      this.ringMat.emissive.setHex(0xffffff);
    }
  }

  setColors(primaryHex, accentHex) {
    this.currentColor = primaryHex;
    this.currentAccent = accentHex;
    this.loadModels();
  }

  toggleWireframe(enabled) {
    this.isWireframe = enabled;
    this.scene.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => (m.wireframe = enabled));
        } else {
          obj.material.wireframe = enabled;
        }
      }
    });
  }

  bindEvents() {
    window.addEventListener('resize', () => this.onResize());

    this.canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.previousPointerPosition = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;

      const deltaX = e.clientX - this.previousPointerPosition.x;
      const deltaY = e.clientY - this.previousPointerPosition.y;

      this.rotationY += deltaX * 0.008;
      this.rotationX = Math.max(-0.2, Math.min(0.8, this.rotationX + deltaY * 0.008));

      this.previousPointerPosition = { x: e.clientX, y: e.clientY };

      if (this.viewMode === 'single') {
        this.updateCameraTransform();
      }
    });

    window.addEventListener('pointerup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      if (this.viewMode !== 'single') return;
      e.preventDefault();
      this.cameraDistance = Math.max(2.8, Math.min(9.0, this.cameraDistance + e.deltaY * 0.004));
      this.updateCameraTransform();
    }, { passive: false });
  }

  updateCameraTransform() {
    const cosX = Math.cos(this.rotationX);
    const sinX = Math.sin(this.rotationX);
    const cosY = Math.cos(this.rotationY);
    const sinY = Math.sin(this.rotationY);

    this.camera.position.x = this.cameraDistance * cosX * sinY;
    this.camera.position.y = 0.5 + this.cameraDistance * sinX;
    this.camera.position.z = this.cameraDistance * cosX * cosY;

    this.camera.lookAt(0, 0.5, 0);
  }

  onResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const dt = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    if (this.isAutoRotate && !this.isDragging) {
      if (this.viewMode === 'single') {
        this.rotationY += dt * 0.45;
        this.updateCameraTransform();
      } else {
        this.models.forEach((m) => {
          m.wrapper.rotation.y += dt * 0.45;
        });
      }
    }

    if (this.isAnimationPlaying) {
      this.models.forEach((m) => {
        if (m.update) m.update(time, dt);
      });
    }

    this.renderer.render(this.scene, this.camera);
  }
}
