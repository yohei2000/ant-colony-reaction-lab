import './styles.css';
import { FIXED_DT, MAX_FIXED_STEPS, MAX_FRAME_DELTA } from './game/constants';
import { loadColonyState, saveColonyState } from './game/persistence';
import { createGameState, syncRenderedAnts } from './game/state';
import { applyOfflineProgress, updateGame } from './game/simulation';
import { installDebugApi } from './debug';
import { InputController } from './input';
import { SceneRenderer } from './render/scene';
import { UIController } from './ui';

const loadingScreen = document.querySelector<HTMLElement>('#loading-screen');
const progressText = document.querySelector<HTMLElement>('#loading-progress');
const progressBar = document.querySelector<HTMLElement>('#loading-bar-fill');
const errorScreen = document.querySelector<HTMLElement>('#error-screen');
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
const statsGrid = document.querySelector<HTMLElement>('#stats-grid');
const toolbar = document.querySelector<HTMLElement>('#tool-bar');
const tabContent = document.querySelector<HTMLElement>('#tab-content');
const uiRoot = document.querySelector<HTMLElement>('#app-ui');

if (!canvas || !statsGrid || !toolbar || !tabContent || !uiRoot) {
  throw new Error('Required DOM nodes were not found.');
}

const gameCanvas = canvas;
const statsElement = statsGrid;
const toolbarElement = toolbar;
const tabContentElement = tabContent;
const uiRootElement = uiRoot;

let renderer: SceneRenderer | null = null;
let input: InputController | null = null;
let ui: UIController | null = null;
let animationId = 0;
let running = true;
let accumulator = 0;
let lastFrame = performance.now();
let lastSave = Date.now();

start();

function start(): void {
  setLoadingProgress(16);
  if (!supportsWebGL2()) {
    showWebGLError();
    return;
  }

  setLoadingProgress(38);
  const colony = loadColonyState();
  const state = createGameState(colony);
  setLoadingProgress(56);

  renderer = new SceneRenderer(gameCanvas);
  input = new InputController(gameCanvas, renderer, state, () => {
    ui?.render(true);
    saveColonyState(state.colony);
  });
  ui = new UIController(
    state,
    () => syncRenderedAnts(state),
    statsElement,
    toolbarElement,
    tabContentElement,
    uiRootElement
  );
  installDebugApi(state, renderer);
  setLoadingProgress(86);

  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('beforeunload', () => cleanup(state));
  document.addEventListener('visibilitychange', () => handleVisibilityChange(state));
  renderer.render(state, 0);
  hideLoading();
  animationId = window.requestAnimationFrame((time) => frame(time, state));
}

function frame(now: number, state: ReturnType<typeof createGameState>): void {
  if (!running || !renderer) {
    return;
  }
  const rawDelta = (now - lastFrame) / 1000;
  lastFrame = now;
  const delta = Math.min(MAX_FRAME_DELTA, Math.max(0, rawDelta));
  accumulator += delta;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
    updateGame(state, FIXED_DT);
    accumulator -= FIXED_DT;
    steps += 1;
  }
  if (steps >= MAX_FIXED_STEPS) {
    accumulator = 0;
  }

  renderer.resize();
  renderer.render(state, accumulator / FIXED_DT);
  ui?.render();

  const nowMs = Date.now();
  if (nowMs - lastSave > 5000) {
    saveColonyState(state.colony, nowMs);
    lastSave = nowMs;
  }
  animationId = window.requestAnimationFrame((time) => frame(time, state));
}

function handleResize(): void {
  renderer?.resize();
}

function handleVisibilityChange(state: ReturnType<typeof createGameState>): void {
  if (document.hidden) {
    state.paused = true;
    saveColonyState(state.colony);
    return;
  }
  applyOfflineProgress(state.colony, Date.now());
  syncRenderedAnts(state);
  state.paused = false;
  lastFrame = performance.now();
  accumulator = 0;
  ui?.render(true);
}

function cleanup(state: ReturnType<typeof createGameState>): void {
  running = false;
  window.cancelAnimationFrame(animationId);
  saveColonyState(state.colony);
  input?.dispose();
  renderer?.dispose();
}

function supportsWebGL2(): boolean {
  try {
    const testCanvas = document.createElement('canvas');
    return Boolean(testCanvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

function showWebGLError(): void {
  loadingScreen?.classList.add('is-hidden');
  if (errorScreen) {
    errorScreen.hidden = false;
  }
}

function setLoadingProgress(value: number): void {
  if (progressText) {
    progressText.textContent = `${value}%`;
  }
  if (progressBar) {
    progressBar.style.width = `${value}%`;
  }
}

function hideLoading(): void {
  setLoadingProgress(100);
  window.setTimeout(() => {
    loadingScreen?.classList.add('is-hidden');
  }, 120);
}
