import * as THREE from 'three';
import { MAX_RENDERED_ANTS } from '../game/constants';
import type { AntAgent } from '../game/types';
import { disposeMaterial } from './dispose';

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class AntInstancedRenderer {
  readonly group = new THREE.Group();

  private readonly headMesh: THREE.InstancedMesh;
  private readonly thoraxMesh: THREE.InstancedMesh;
  private readonly abdomenMesh: THREE.InstancedMesh;
  private readonly waistMesh: THREE.InstancedMesh;
  private readonly legMesh: THREE.InstancedMesh;
  private readonly antennaMesh: THREE.InstancedMesh;
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly waistGeometry: THREE.SphereGeometry;
  private readonly cylinderGeometry: THREE.CylinderGeometry;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;
  private readonly headMaterial: THREE.MeshStandardMaterial;
  private readonly limbMaterial: THREE.MeshStandardMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly segment = new THREE.Vector3();

  constructor(maxAnts = MAX_RENDERED_ANTS) {
    this.sphereGeometry = new THREE.SphereGeometry(1, 10, 7);
    this.waistGeometry = new THREE.SphereGeometry(1, 8, 5);
    this.cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x332017,
      roughness: 0.72,
      metalness: 0.05
    });
    this.headMaterial = new THREE.MeshStandardMaterial({
      color: 0x251712,
      roughness: 0.78,
      metalness: 0.02
    });
    this.limbMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b130f,
      roughness: 0.82,
      metalness: 0
    });

    this.headMesh = new THREE.InstancedMesh(this.sphereGeometry, this.headMaterial, maxAnts);
    this.thoraxMesh = new THREE.InstancedMesh(this.sphereGeometry, this.bodyMaterial, maxAnts);
    this.abdomenMesh = new THREE.InstancedMesh(this.sphereGeometry, this.bodyMaterial, maxAnts);
    this.waistMesh = new THREE.InstancedMesh(this.waistGeometry, this.limbMaterial, maxAnts);
    this.legMesh = new THREE.InstancedMesh(this.cylinderGeometry, this.limbMaterial, maxAnts * 6);
    this.antennaMesh = new THREE.InstancedMesh(this.cylinderGeometry, this.limbMaterial, maxAnts * 2);

    for (const mesh of [
      this.abdomenMesh,
      this.thoraxMesh,
      this.waistMesh,
      this.headMesh,
      this.legMesh,
      this.antennaMesh
    ]) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
    }
  }

  update(ants: AntAgent[]): void {
    const count = ants.length;
    this.headMesh.count = count;
    this.thoraxMesh.count = count;
    this.abdomenMesh.count = count;
    this.waistMesh.count = count;
    this.legMesh.count = count * 6;
    this.antennaMesh.count = count * 2;

    let legIndex = 0;
    let antennaIndex = 0;
    for (let index = 0; index < count; index += 1) {
      const ant = ants[index];
      const lift = ant.role === 'panic' ? 0.018 : 0;
      this.setBodyPart(this.headMesh, index, ant, 0, 0.155, 0.065 + lift, 0.052, 0.038, 0.062);
      this.setBodyPart(this.thoraxMesh, index, ant, 0, 0.02, 0.06 + lift, 0.064, 0.044, 0.082);
      this.setBodyPart(this.waistMesh, index, ant, 0, -0.066, 0.057 + lift, 0.032, 0.026, 0.034);
      this.setBodyPart(this.abdomenMesh, index, ant, 0, -0.176, 0.062 + lift, 0.087, 0.056, 0.126);

      legIndex = this.setLegs(ant, legIndex, lift);
      antennaIndex = this.setAntennae(ant, antennaIndex, lift);
    }

    this.headMesh.instanceMatrix.needsUpdate = true;
    this.thoraxMesh.instanceMatrix.needsUpdate = true;
    this.abdomenMesh.instanceMatrix.needsUpdate = true;
    this.waistMesh.instanceMatrix.needsUpdate = true;
    this.legMesh.instanceMatrix.needsUpdate = true;
    this.antennaMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.sphereGeometry.dispose();
    this.waistGeometry.dispose();
    this.cylinderGeometry.dispose();
    disposeMaterial(this.bodyMaterial);
    disposeMaterial(this.headMaterial);
    disposeMaterial(this.limbMaterial);
  }

  private setBodyPart(
    mesh: THREE.InstancedMesh,
    index: number,
    ant: AntAgent,
    localX: number,
    localZ: number,
    y: number,
    sx: number,
    sy: number,
    sz: number
  ): void {
    this.localToWorld(ant, localX, localZ, y, this.position);
    this.quaternion.setFromAxisAngle(Y_AXIS, ant.dir);
    this.scale.set(sx, sy, sz);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    mesh.setMatrixAt(index, this.matrix);
  }

  private setLegs(ant: AntAgent, startIndex: number, lift: number): number {
    const phase = Math.sin((ant.x * 8 + ant.z * 5 + ant.id) * 1.7);
    const baseY = 0.046 + lift;
    const footY = 0.012;
    const anchors = [
      [0.058, 0.075, 0.19, 0.12 + phase * 0.012],
      [0.07, 0.005, 0.22, -0.01 - phase * 0.01],
      [0.062, -0.085, 0.19, -0.15 + phase * 0.012]
    ];
    let index = startIndex;
    for (const [anchorX, anchorZ, footX, footZ] of anchors) {
      this.setLimb(this.legMesh, index++, ant, anchorX, anchorZ, baseY, footX, footZ, footY, 0.012);
      this.setLimb(this.legMesh, index++, ant, -anchorX, anchorZ, baseY, -footX, footZ, footY, 0.012);
    }
    return index;
  }

  private setAntennae(ant: AntAgent, startIndex: number, lift: number): number {
    let index = startIndex;
    const wave = Math.sin(ant.id + ant.x * 4 + ant.z * 3) * 0.025;
    this.setLimb(
      this.antennaMesh,
      index++,
      ant,
      0.026,
      0.195,
      0.086 + lift,
      0.102,
      0.318 + wave,
      0.083,
      0.008
    );
    this.setLimb(
      this.antennaMesh,
      index++,
      ant,
      -0.026,
      0.195,
      0.086 + lift,
      -0.102,
      0.318 - wave,
      0.083,
      0.008
    );
    return index;
  }

  private setLimb(
    mesh: THREE.InstancedMesh,
    index: number,
    ant: AntAgent,
    startX: number,
    startZ: number,
    startY: number,
    endX: number,
    endZ: number,
    endY: number,
    radius: number
  ): void {
    this.localToWorld(ant, startX, startZ, startY, this.start);
    this.localToWorld(ant, endX, endZ, endY, this.end);
    this.segment.subVectors(this.end, this.start);
    const length = Math.max(0.0001, this.segment.length());
    this.midpoint.addVectors(this.start, this.end).multiplyScalar(0.5);
    this.segment.multiplyScalar(1 / length);
    this.quaternion.setFromUnitVectors(Y_AXIS, this.segment);
    this.scale.set(radius, length, radius);
    this.matrix.compose(this.midpoint, this.quaternion, this.scale);
    mesh.setMatrixAt(index, this.matrix);
  }

  private localToWorld(
    ant: AntAgent,
    localX: number,
    localZ: number,
    y: number,
    target: THREE.Vector3
  ): void {
    const sin = Math.sin(ant.dir);
    const cos = Math.cos(ant.dir);
    target.set(ant.x + cos * localX + sin * localZ, y, ant.z - sin * localX + cos * localZ);
  }
}
