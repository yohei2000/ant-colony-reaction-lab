import { WORLD_RADIUS } from '../game/constants';
import type { AntAgent, GameState, Pheromone, PlacedItem } from '../game/types';
import type { CanvasSample, RenderSurface, RendererInfoSnapshot } from './renderSurface';

export class Canvas2DRenderer implements RenderSurface {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pixelRatioLimit = 1.6;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private yaw = Math.PI * 0.18;
  private pitch = 0.86;
  private distance = 9.6;
  private drawCalls = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Canvas2D context is not available.');
    }
    this.ctx = context;
    this.resize();
  }

  render(state: GameState, alpha: number): void {
    void alpha;
    this.resize();
    this.drawCalls = 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#172016';
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawBoard();
    this.drawPheromones(state.pheromones);
    this.drawItems(state.items);
    this.drawNest();
    this.drawAnts(state.ants);
    ctx.restore();
  }

  resize(): void {
    const displayWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const displayHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.pixelRatioLimit);
    if (displayWidth !== this.width || displayHeight !== this.height) {
      this.width = displayWidth;
      this.height = displayHeight;
      this.canvas.width = Math.floor(displayWidth * this.pixelRatio);
      this.canvas.height = Math.floor(displayHeight * this.pixelRatio);
    }
  }

  setCameraOrbit(yaw: number, pitch: number, distance: number): void {
    this.yaw = yaw;
    this.pitch = Math.min(1.25, Math.max(0.45, pitch));
    this.distance = Math.min(14, Math.max(6.8, distance));
  }

  getCameraOrbit(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
  }

  screenToWorld(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const scale = this.getScale();
    const centerX = this.width * 0.5;
    const centerY = this.height * 0.48;
    const rx = (sx - centerX) / scale;
    const rz = (sy - centerY) / scale;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const x = cos * rx - sin * rz;
    const z = sin * rx + cos * rz;
    if (Math.hypot(x, z) > WORLD_RADIUS * 1.05) {
      return null;
    }
    return {
      x: Math.max(-WORLD_RADIUS, Math.min(WORLD_RADIUS, x)),
      z: Math.max(-WORLD_RADIUS, Math.min(WORLD_RADIUS, z))
    };
  }

  getInfo(): RendererInfoSnapshot {
    return {
      drawCalls: this.drawCalls,
      triangles: 0,
      textures: 0,
      pixelRatio: this.pixelRatio,
      isWebGL2: false,
      rendererMode: 'canvas2d'
    };
  }

  sampleCanvas(): CanvasSample {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const sampleWidth = Math.min(24, this.canvas.width);
    const sampleHeight = Math.min(24, this.canvas.height);
    const image = this.ctx.getImageData(
      Math.floor((this.canvas.width - sampleWidth) / 2),
      Math.floor((this.canvas.height - sampleHeight) / 2),
      sampleWidth,
      sampleHeight
    );
    this.ctx.restore();
    let brightPixels = 0;
    let total = 0;
    let totalSq = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      const brightness = image.data[index] + image.data[index + 1] + image.data[index + 2];
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
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawBoard(): void {
    const ctx = this.ctx;
    const center = this.worldToScreen(0, 0);
    const radius = WORLD_RADIUS * this.getScale();
    ctx.save();
    ctx.fillStyle = '#5c6a3d';
    ctx.strokeStyle = 'rgba(208, 177, 100, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(166, 173, 121, 0.18)';
    ctx.lineWidth = 1;
    for (let index = -6; index <= 6; index += 1) {
      this.drawWorldLine(index, -WORLD_RADIUS, index, WORLD_RADIUS);
      this.drawWorldLine(-WORLD_RADIUS, index, WORLD_RADIUS, index);
    }
    ctx.restore();
    this.drawCalls += 1;
  }

  private drawPheromones(pheromones: Pheromone[]): void {
    const colorBySignal = {
      food: 'rgba(241, 200, 92, 0.16)',
      alarm: 'rgba(212, 95, 85, 0.18)',
      rescue: 'rgba(143, 209, 188, 0.14)',
      water: 'rgba(119, 189, 227, 0.15)'
    };
    for (const pheromone of pheromones) {
      const point = this.worldToScreen(pheromone.x, pheromone.z);
      const radius = pheromone.radius * (0.35 + Math.max(0, pheromone.strength)) * this.getScale();
      this.ctx.fillStyle = colorBySignal[pheromone.signal];
      this.ctx.beginPath();
      this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.drawCalls += 1;
    }
  }

  private drawItems(items: PlacedItem[]): void {
    for (const item of items) {
      const point = this.worldToScreen(item.x, item.z);
      const radius = item.radius * this.getScale();
      if (item.type === 'water') {
        this.ctx.fillStyle = 'rgba(120, 191, 230, 0.48)';
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        this.ctx.fill();
      } else if (item.type === 'object') {
        this.ctx.save();
        this.ctx.translate(point.x, point.y);
        this.ctx.rotate(item.rotation - this.yaw);
        this.ctx.fillStyle = '#8a7c6d';
        this.ctx.fillRect(-radius * 0.72, -radius * 0.58, radius * 1.44, radius * 1.16);
        this.ctx.restore();
      } else if (item.type === 'branch') {
        this.ctx.save();
        this.ctx.translate(point.x, point.y);
        this.ctx.rotate(item.rotation - this.yaw);
        this.ctx.strokeStyle = '#7c5f3b';
        this.ctx.lineWidth = Math.max(4, radius * 0.13);
        this.ctx.lineCap = 'round';
        this.ctx.beginPath();
        this.ctx.moveTo(-radius, 0);
        this.ctx.lineTo(radius, 0);
        this.ctx.stroke();
        this.ctx.restore();
      } else if (item.amount > 0.04) {
        this.ctx.fillStyle = '#d9b34e';
        const visible = Math.max(0.28, Math.min(1, item.amount / item.initialAmount));
        for (let index = 0; index < 7; index += 1) {
          const angle = index * 2.39;
          const pelletRadius = Math.max(2, radius * 0.18 * visible);
          this.ctx.beginPath();
          this.ctx.arc(
            point.x + Math.cos(angle) * radius * 0.2,
            point.y + Math.sin(angle) * radius * 0.2,
            pelletRadius,
            0,
            Math.PI * 2
          );
          this.ctx.fill();
        }
      }
      this.drawCalls += 1;
    }
  }

  private drawNest(): void {
    const point = this.worldToScreen(0, 0);
    const scale = this.getScale();
    this.ctx.fillStyle = '#725439';
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, scale * 0.58, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.fillStyle = '#16110c';
    this.ctx.beginPath();
    this.ctx.ellipse(point.x, point.y + scale * 0.14, scale * 0.18, scale * 0.11, 0, 0, Math.PI * 2);
    this.ctx.fill();
    this.drawCalls += 1;
  }

  private drawAnts(ants: AntAgent[]): void {
    for (const ant of ants) {
      this.drawAnt(ant);
    }
  }

  private drawAnt(ant: AntAgent): void {
    const point = this.worldToScreen(ant.x, ant.z);
    const scale = this.getScale();
    const dir = ant.dir - this.yaw;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(dir);
    ctx.strokeStyle = '#1b130f';
    ctx.lineWidth = Math.max(1, scale * 0.018);
    ctx.lineCap = 'round';
    const legs = [
      [0.05, 0.08, 0.18, 0.14],
      [0.07, 0.0, 0.22, -0.01],
      [0.06, -0.09, 0.18, -0.16]
    ];
    for (const [ax, az, fx, fz] of legs) {
      this.drawLocalLine(ax, az, fx, fz, scale);
      this.drawLocalLine(-ax, az, -fx, fz, scale);
    }
    this.drawLocalLine(0.03, 0.19, 0.11, 0.32, scale);
    this.drawLocalLine(-0.03, 0.19, -0.11, 0.32, scale);
    ctx.fillStyle = '#332017';
    this.drawBodyEllipse(0, -0.18, 0.09, 0.13, scale);
    ctx.fillStyle = '#1b130f';
    this.drawBodyEllipse(0, -0.07, 0.03, 0.035, scale);
    ctx.fillStyle = '#332017';
    this.drawBodyEllipse(0, 0.02, 0.065, 0.085, scale);
    ctx.fillStyle = '#251712';
    this.drawBodyEllipse(0, 0.16, 0.055, 0.065, scale);
    ctx.restore();
    this.drawCalls += 1;
  }

  private drawLocalLine(ax: number, az: number, bx: number, bz: number, scale: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(ax * scale, -az * scale);
    this.ctx.lineTo(bx * scale, -bz * scale);
    this.ctx.stroke();
  }

  private drawBodyEllipse(x: number, z: number, rx: number, rz: number, scale: number): void {
    this.ctx.beginPath();
    this.ctx.ellipse(x * scale, -z * scale, rx * scale, rz * scale, 0, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private drawWorldLine(ax: number, az: number, bx: number, bz: number): void {
    const a = this.worldToScreen(ax, az);
    const b = this.worldToScreen(bx, bz);
    this.ctx.beginPath();
    this.ctx.moveTo(a.x, a.y);
    this.ctx.lineTo(b.x, b.y);
    this.ctx.stroke();
  }

  private worldToScreen(x: number, z: number): { x: number; y: number } {
    const scale = this.getScale();
    const cos = Math.cos(-this.yaw);
    const sin = Math.sin(-this.yaw);
    const rx = cos * x - sin * z;
    const rz = sin * x + cos * z;
    return {
      x: this.width * 0.5 + rx * scale,
      y: this.height * 0.48 + rz * scale
    };
  }

  private getScale(): number {
    return (Math.min(this.width, this.height) * 0.42) / WORLD_RADIUS;
  }
}
