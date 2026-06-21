import { addPlacedItem, eraseAt } from './game/state';
import type { GameState } from './game/types';
import type { RenderSurface } from './render/renderSurface';

type ChangeCallback = () => void;

export class InputController {
  private dragging = false;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private yaw = Math.PI * 0.18;
  private pitch = 0.86;
  private distance = 9.6;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: RenderSurface,
    private readonly state: GameState,
    private readonly onChange: ChangeCallback
  ) {
    this.applyCamera();
    canvas.addEventListener('pointerdown', this.handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', this.handlePointerMove, { passive: false });
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
  }

  getCameraOrbit(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return;
    }
    event.preventDefault();
    const world = this.renderer.screenToWorld(event.clientX, event.clientY);
    if (this.state.selectedTool !== 'observe' && world) {
      if (this.state.selectedTool === 'erase') {
        eraseAt(this.state, world.x, world.z);
      } else {
        addPlacedItem(this.state, this.state.selectedTool, world.x, world.z);
      }
      this.onChange();
      return;
    }
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragging || this.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.yaw -= dx * 0.006;
    this.pitch += dy * 0.0048;
    this.applyCamera();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.dragging = false;
    this.pointerId = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.distance += Math.sign(event.deltaY) * 0.55;
    this.applyCamera();
  };

  private applyCamera(): void {
    this.pitch = Math.max(0.45, Math.min(1.25, this.pitch));
    this.distance = Math.max(6.8, Math.min(14, this.distance));
    this.renderer.setCameraOrbit(this.yaw, this.pitch, this.distance);
  }
}
