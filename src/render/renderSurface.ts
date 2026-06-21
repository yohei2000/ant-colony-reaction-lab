import type { GameState } from '../game/types';

export interface RendererInfoSnapshot {
  drawCalls: number;
  triangles: number;
  textures: number;
  pixelRatio: number;
  isWebGL2: boolean;
  rendererMode: 'webgl' | 'canvas2d';
}

export interface CanvasSample {
  sampledPixels: number;
  brightPixels: number;
  colorVariance: number;
}

export interface RenderSurface {
  render(state: GameState, alpha: number): void;
  resize(): void;
  setCameraOrbit(yaw: number, pitch: number, distance: number): void;
  getCameraOrbit(): { yaw: number; pitch: number; distance: number };
  screenToWorld(clientX: number, clientY: number): { x: number; z: number } | null;
  getInfo(): RendererInfoSnapshot;
  sampleCanvas(): CanvasSample;
  dispose(): void;
}
