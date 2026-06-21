import * as THREE from 'three';
import { MAX_PHEROMONES, WORLD_RADIUS } from '../game/constants';
import type { GameState, PheromoneSignal, PlacedItem } from '../game/types';
import { AntInstancedRenderer } from './antMesh';
import { disposeMaterial, disposeObject3D } from './dispose';
import type { CanvasSample, RendererInfoSnapshot, RenderSurface } from './renderSurface';

const PHEROMONE_SIGNALS: PheromoneSignal[] = ['food', 'alarm', 'rescue', 'water'];

export class SceneRenderer implements RenderSurface {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(44, 1, 0.1, 80);

  private readonly antRenderer = new AntInstancedRenderer();
  private readonly itemGroup = new THREE.Group();
  private readonly pheromoneMeshes = new Map<PheromoneSignal, THREE.InstancedMesh>();
  private readonly pheromoneGeometry = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly intersection = new THREE.Vector3();
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly itemMaterials: THREE.Material[] = [];
  private readonly pixelRatioLimit = 1.6;
  private itemRevision = -1;
  private width = 1;
  private height = 1;
  private yaw = Math.PI * 0.18;
  private pitch = 0.86;
  private distance = 9.6;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setClearColor(0x172016, 1);

    this.scene.background = new THREE.Color(0x172016);
    this.scene.fog = new THREE.Fog(0x172016, 11, 18);
    this.camera.position.set(3, 6, 8);

    this.createWorld();
    this.scene.add(this.itemGroup);
    this.scene.add(this.antRenderer.group);
    this.createPheromoneMeshes();
    this.resize();
    this.updateCamera();
  }

  render(state: GameState, alpha: number): void {
    void alpha;
    if (this.itemRevision !== state.itemRevision) {
      this.rebuildItems(state.items);
      this.itemRevision = state.itemRevision;
    } else {
      this.updateFoodVisibility(state.items);
    }
    this.antRenderer.update(state.ants);
    this.updatePheromones(state);
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const displayWidth = Math.max(1, this.canvas.clientWidth);
    const displayHeight = Math.max(1, this.canvas.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.pixelRatioLimit);
    this.renderer.setPixelRatio(pixelRatio);
    if (displayWidth !== this.width || displayHeight !== this.height) {
      this.width = displayWidth;
      this.height = displayHeight;
      this.renderer.setSize(displayWidth, displayHeight, false);
      this.camera.aspect = displayWidth / displayHeight;
      this.camera.updateProjectionMatrix();
    }
  }

  setCameraOrbit(yaw: number, pitch: number, distance: number): void {
    this.yaw = yaw;
    this.pitch = Math.min(1.25, Math.max(0.45, pitch));
    this.distance = Math.min(14, Math.max(6.8, distance));
    this.updateCamera();
  }

  getCameraOrbit(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
  }

  screenToWorld(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.intersection);
    if (!hit) {
      return null;
    }
    return {
      x: Math.max(-WORLD_RADIUS, Math.min(WORLD_RADIUS, this.intersection.x)),
      z: Math.max(-WORLD_RADIUS, Math.min(WORLD_RADIUS, this.intersection.z))
    };
  }

  getInfo(): RendererInfoSnapshot {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      textures: this.renderer.info.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
      isWebGL2: this.renderer.capabilities.isWebGL2,
      rendererMode: 'webgl'
    };
  }

  sampleCanvas(): CanvasSample {
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext();
    const width = Math.max(1, gl.drawingBufferWidth);
    const height = Math.max(1, gl.drawingBufferHeight);
    const sampleWidth = Math.min(24, width);
    const sampleHeight = Math.min(24, height);
    const buffer = new Uint8Array(sampleWidth * sampleHeight * 4);
    gl.readPixels(
      Math.floor((width - sampleWidth) / 2),
      Math.floor((height - sampleHeight) / 2),
      sampleWidth,
      sampleHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      buffer
    );
    let brightPixels = 0;
    let total = 0;
    let totalSq = 0;
    for (let index = 0; index < buffer.length; index += 4) {
      const brightness = buffer[index] + buffer[index + 1] + buffer[index + 2];
      if (brightness > 24) {
        brightPixels += 1;
      }
      total += brightness;
      totalSq += brightness * brightness;
    }
    const sampledPixels = sampleWidth * sampleHeight;
    const mean = total / sampledPixels;
    return {
      sampledPixels,
      brightPixels,
      colorVariance: totalSq / sampledPixels - mean * mean
    };
  }

  dispose(): void {
    this.antRenderer.dispose();
    this.pheromoneGeometry.dispose();
    for (const mesh of this.pheromoneMeshes.values()) {
      disposeMaterial(mesh.material as THREE.Material);
    }
    disposeObject3D(this.itemGroup);
    for (const material of this.itemMaterials) {
      disposeMaterial(material);
    }
    this.renderer.dispose();
  }

  private createWorld(): void {
    const ambient = new THREE.HemisphereLight(0xe6f2d7, 0x2a2118, 1.9);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffe5ad, 2.3);
    sun.position.set(3.5, 7.5, 4);
    this.scene.add(sun);

    const boardGeometry = new THREE.CircleGeometry(WORLD_RADIUS, 96).rotateX(-Math.PI / 2);
    const boardMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c6a3d,
      roughness: 0.93,
      metalness: 0
    });
    this.itemMaterials.push(boardMaterial);
    const board = new THREE.Mesh(boardGeometry, boardMaterial);
    board.receiveShadow = false;
    this.scene.add(board);

    const ringGeometry = new THREE.RingGeometry(WORLD_RADIUS - 0.02, WORLD_RADIUS + 0.03, 96)
      .rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xd0b164,
      transparent: true,
      opacity: 0.42
    });
    this.itemMaterials.push(ringMaterial);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.y = 0.006;
    this.scene.add(ring);

    const grid = new THREE.GridHelper(WORLD_RADIUS * 2, 16, 0xa6ad79, 0x3f4c32);
    grid.position.y = 0.008;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.18;
    this.scene.add(grid);

    const nestMaterial = new THREE.MeshStandardMaterial({
      color: 0x725439,
      roughness: 0.86
    });
    this.itemMaterials.push(nestMaterial);
    const nestGeometry = new THREE.ConeGeometry(0.58, 0.28, 28);
    const nest = new THREE.Mesh(nestGeometry, nestMaterial);
    nest.position.set(0, 0.14, 0);
    this.scene.add(nest);

    const entranceGeometry = new THREE.CircleGeometry(0.18, 20).rotateX(-Math.PI / 2);
    const entranceMaterial = new THREE.MeshBasicMaterial({ color: 0x16110c });
    this.itemMaterials.push(entranceMaterial);
    const entrance = new THREE.Mesh(entranceGeometry, entranceMaterial);
    entrance.position.set(0, 0.285, 0.12);
    this.scene.add(entrance);
  }

  private createPheromoneMeshes(): void {
    const materialBySignal: Record<PheromoneSignal, THREE.MeshBasicMaterial> = {
      food: new THREE.MeshBasicMaterial({
        color: 0xf1c85c,
        transparent: true,
        opacity: 0.16,
        depthWrite: false
      }),
      alarm: new THREE.MeshBasicMaterial({
        color: 0xd45f55,
        transparent: true,
        opacity: 0.18,
        depthWrite: false
      }),
      rescue: new THREE.MeshBasicMaterial({
        color: 0x8fd1bc,
        transparent: true,
        opacity: 0.14,
        depthWrite: false
      }),
      water: new THREE.MeshBasicMaterial({
        color: 0x77bde3,
        transparent: true,
        opacity: 0.15,
        depthWrite: false
      })
    };
    for (const signal of PHEROMONE_SIGNALS) {
      const mesh = new THREE.InstancedMesh(
        this.pheromoneGeometry,
        materialBySignal[signal],
        MAX_PHEROMONES
      );
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.pheromoneMeshes.set(signal, mesh);
      this.scene.add(mesh);
    }
  }

  private updatePheromones(state: GameState): void {
    const counts: Record<PheromoneSignal, number> = {
      food: 0,
      alarm: 0,
      rescue: 0,
      water: 0
    };
    for (const pheromone of state.pheromones) {
      const mesh = this.pheromoneMeshes.get(pheromone.signal);
      if (!mesh) {
        continue;
      }
      const index = counts[pheromone.signal]++;
      if (index >= MAX_PHEROMONES) {
        continue;
      }
      this.tempPosition.set(pheromone.x, 0.018, pheromone.z);
      this.tempQuaternion.identity();
      const scale = pheromone.radius * (0.35 + Math.max(0, pheromone.strength));
      this.tempScale.set(scale, scale, scale);
      this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
      mesh.setMatrixAt(index, this.tempMatrix);
    }
    for (const signal of PHEROMONE_SIGNALS) {
      const mesh = this.pheromoneMeshes.get(signal);
      if (mesh) {
        mesh.count = counts[signal];
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private rebuildItems(items: PlacedItem[]): void {
    disposeObject3D(this.itemGroup);
    this.itemGroup.clear();
    for (const item of items) {
      this.itemGroup.add(this.createItemMesh(item));
    }
  }

  private updateFoodVisibility(items: PlacedItem[]): void {
    for (const object of this.itemGroup.children) {
      const itemId = object.userData.itemId as number | undefined;
      if (!itemId) {
        continue;
      }
      const item = items.find((entry) => entry.id === itemId);
      if (item?.type === 'food') {
        const visibleScale = Math.max(0.25, Math.min(1, item.amount / item.initialAmount));
        object.scale.setScalar(visibleScale);
        object.visible = item.amount > 0.04;
      }
    }
  }

  private createItemMesh(item: PlacedItem): THREE.Object3D {
    if (item.type === 'water') {
      const geometry = new THREE.CircleGeometry(item.radius, 36).rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        color: 0x78bfe6,
        transparent: true,
        opacity: 0.42,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, 0.026, item.z);
      mesh.userData.itemId = item.id;
      return mesh;
    }

    if (item.type === 'object') {
      const geometry = new THREE.BoxGeometry(item.radius * 1.45, 0.3, item.radius * 1.15);
      const material = new THREE.MeshStandardMaterial({
        color: 0x8a7c6d,
        roughness: 0.9
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, 0.15, item.z);
      mesh.rotation.y = item.rotation;
      mesh.userData.itemId = item.id;
      return mesh;
    }

    if (item.type === 'branch') {
      const geometry = new THREE.CylinderGeometry(0.055, 0.08, item.radius * 2.2, 9, 1);
      const material = new THREE.MeshStandardMaterial({
        color: 0x7c5f3b,
        roughness: 0.86
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(item.x, 0.085, item.z);
      mesh.rotation.z = Math.PI / 2;
      mesh.rotation.y = item.rotation;
      mesh.userData.itemId = item.id;
      return mesh;
    }

    const group = new THREE.Group();
    group.userData.itemId = item.id;
    const material = new THREE.MeshStandardMaterial({
      color: 0xd9b34e,
      roughness: 0.82
    });
    const geometry = new THREE.SphereGeometry(0.075, 8, 6);
    for (let index = 0; index < 7; index += 1) {
      const pellet = new THREE.Mesh(geometry, material);
      const angle = index * 2.39;
      const radius = (index % 3) * 0.055;
      pellet.position.set(
        item.x + Math.cos(angle) * radius,
        0.055 + (index % 2) * 0.025,
        item.z + Math.sin(angle) * radius
      );
      group.add(pellet);
    }
    return group;
  }

  private updateCamera(): void {
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      Math.sin(this.yaw) * horizontal,
      Math.sin(this.pitch) * this.distance,
      Math.cos(this.yaw) * horizontal
    );
    this.camera.lookAt(0, 0, 0);
  }
}
