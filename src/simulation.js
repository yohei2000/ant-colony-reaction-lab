import * as THREE from "three";

const ui = {
  world: document.querySelector("#world3d"),
  buttons: [...document.querySelectorAll(".tool-button")],
  activeToolLabel: document.querySelector("#activeToolLabel"),
  pause: document.querySelector("#pauseBtn"),
  reset: document.querySelector("#resetBtn"),
  antCount: document.querySelector("#antCount"),
  antCountValue: document.querySelector("#antCountValue"),
  intensity: document.querySelector("#intensity"),
  intensityValue: document.querySelector("#intensityValue"),
  statExplore: document.querySelector("#statExplore"),
  statAlert: document.querySelector("#statAlert"),
  statRescue: document.querySelector("#statRescue"),
  statFood: document.querySelector("#statFood"),
  inspector: document.querySelector("#inspector"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingBar: document.querySelector("#loadingBar"),
  loadingLabel: document.querySelector("#loadingLabel"),
  errorPanel: document.querySelector("#errorPanel"),
  errorMessage: document.querySelector("#errorMessage"),
  debugPanel: document.querySelector("#debugPanel"),
  debugMetrics: document.querySelector("#debugMetrics"),
  qualitySelect: document.querySelector("#qualitySelect"),
  colonyTabs: [...document.querySelectorAll(".colony-tab")],
  colonyPanels: [...document.querySelectorAll(".colony-tab-panel")],
  colonyFood: document.querySelector("#colonyFood"),
  colonyAnts: document.querySelector("#colonyAnts"),
  colonyFoodRate: document.querySelector("#colonyFoodRate"),
  colonyNestLevel: document.querySelector("#colonyNestLevel"),
  colonyTerritory: document.querySelector("#colonyTerritory"),
  colonyThreat: document.querySelector("#colonyThreat"),
  colonySoldiers: document.querySelector("#colonySoldiers"),
  colonyWounded: document.querySelector("#colonyWounded"),
  colonyWorkers: document.querySelector("#colonyWorkers"),
  colonyGrowthRate: document.querySelector("#colonyGrowthRate"),
  nestExpand: document.querySelector("#nestExpandBtn"),
  nestExpandCost: document.querySelector("#nestExpandCost"),
  upgradeButtons: [...document.querySelectorAll(".upgrade-button")],
  expeditionEnemy: document.querySelector("#expeditionEnemy"),
  expeditionSoldiers: document.querySelector("#expeditionSoldiers"),
  expeditionSoldiersValue: document.querySelector("#expeditionSoldiersValue"),
  expeditionTactic: document.querySelector("#expeditionTactic"),
  battleWinChance: document.querySelector("#battleWinChance"),
  battlePower: document.querySelector("#battlePower"),
  battleEnemyPower: document.querySelector("#battleEnemyPower"),
  battleReward: document.querySelector("#battleReward"),
  battleLoss: document.querySelector("#battleLoss"),
  battleCooldown: document.querySelector("#battleCooldown"),
  expeditionStart: document.querySelector("#expeditionStartBtn"),
  battleLog: document.querySelector("#battleLog"),
  battleToast: document.querySelector("#battleToast"),
};

const FIXED_DT = 1 / 60;
const MAX_FRAME_DELTA = 0.25;
const MAX_FIXED_STEPS = 5;
const DEBUG_QUERY = new URLSearchParams(window.location.search);
const IS_DEBUG = DEBUG_QUERY.get("debug") === "1";
const COLONY_STORAGE_KEY = "ant3d.colonyState";
const CURRENT_COLONY_VERSION = 2;
const COLONY_SAVE_INTERVAL = 5;
const OFFLINE_CAP_SECONDS = 8 * 60 * 60;

const QUALITY_PRESETS = {
  low: {
    label: "low",
    resolutionScale: 0.78,
    maxPixelRatio: 1.15,
    antialias: false,
    shadowQuality: "off",
    postprocessQuality: "off",
    effectsQuality: 0.7,
    toneMappingExposure: 0.95,
  },
  medium: {
    label: "medium",
    resolutionScale: 0.9,
    maxPixelRatio: 1.45,
    antialias: true,
    shadowQuality: "low",
    postprocessQuality: "off",
    effectsQuality: 1,
    toneMappingExposure: 1,
  },
  high: {
    label: "high",
    resolutionScale: 1,
    maxPixelRatio: 1.8,
    antialias: true,
    shadowQuality: "medium",
    postprocessQuality: "off",
    effectsQuality: 1,
    toneMappingExposure: 1.05,
  },
};

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-critical user preference persistence can fail in private or locked-down contexts.
  }
}

function chooseQualityPreset() {
  const queryQuality = DEBUG_QUERY.get("quality");
  const savedQuality = readStorage("ant3d.quality");
  const autoQuality = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 680 ? "medium" : "high";
  const qualityName = queryQuality || savedQuality || autoQuality;
  const preset = QUALITY_PRESETS[qualityName] ?? QUALITY_PRESETS.medium;
  const resolutionScale = Number(DEBUG_QUERY.get("resolutionScale"));
  const maxPixelRatio = Number(DEBUG_QUERY.get("maxPixelRatio"));
  return {
    ...preset,
    resolutionScale: Number.isFinite(resolutionScale) && resolutionScale > 0 ? clamp(resolutionScale, 0.5, 1.2) : preset.resolutionScale,
    maxPixelRatio: Number.isFinite(maxPixelRatio) && maxPixelRatio > 0 ? clamp(maxPixelRatio, 0.8, 2) : preset.maxPixelRatio,
  };
}

const ROLE_LABELS = {
  scout: "斥候",
  worker: "運搬",
  nurse: "世話",
  guard: "警戒",
};

const STATE_LABELS = {
  explore: "探索",
  return: "帰巣",
  panic: "避難",
  wet: "乾燥",
  stunned: "停止",
  rescue: "救助",
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rand = (min, max) => min + Math.random() * (max - min);
const chance = (p) => Math.random() < p;
const distance2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const normAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// Food trails model short-lived recruitment signals: successful returners reinforce them,
// and depleted sources stop reinforcement so the trail quickly evaporates.
const PHEROMONE_PARAMS = {
  foodDepositInterval: 0.46,
  foodBaseStrength: 0.64,
  foodSourceStrengthBonus: 0.34,
  foodFollowRadius: 15,
  foodFollowGain: 0.42,
  foodActiveDecay: 0.072,
  foodLowSourceExtraDecay: 0.12,
  foodDepletedDecay: 0.58,
  foodLowSourceThreshold: 0.18,
  alarmDecay: 0.32,
  rescueDecay: 0.14,
  waterDecay: 0.14,
};

const UPGRADE_DEFS = {
  foragerTrails: {
    label: "Forager Trails",
    baseCost: 24,
    growth: 1.42,
    effect: "採餌効率 +18%",
    requirement: {},
  },
  broodNursery: {
    label: "Brood Nursery",
    baseCost: 36,
    growth: 1.48,
    effect: "孵化速度 +22%",
    requirement: { minAnts: 12 },
  },
  storageChambers: {
    label: "Storage Chambers",
    baseCost: 52,
    growth: 1.52,
    effect: "収容上限 +20",
    requirement: { minAnts: 16 },
  },
  queenCare: {
    label: "Queen Care",
    baseCost: 78,
    growth: 1.58,
    effect: "産卵基礎力 +16%",
    requirement: { minAnts: 20, minLifetimeFood: 80 },
  },
  soldierTraining: {
    label: "Soldier Training",
    baseCost: 120,
    growth: 1.58,
    effect: "兵隊比率と攻撃力を上げる",
    requirement: { minAnts: 28 },
  },
  mandibleStrength: {
    label: "Mandible Strength",
    baseCost: 160,
    growth: 1.58,
    effect: "兵隊1匹あたりのダメージを上げる",
    requirement: { minAnts: 34, minTerritory: 1 },
  },
  nestGuard: {
    label: "Nest Guard",
    baseCost: 140,
    growth: 1.56,
    effect: "防御と負傷回復を上げる",
    requirement: { minAnts: 30 },
  },
  tacticalPheromone: {
    label: "Tactical Pheromone",
    baseCost: 180,
    growth: 1.6,
    effect: "指揮効率と採餌を上げる",
    requirement: { minLifetimeFood: 240 },
  },
};

const BATTLE_TACTICS = {
  careful: { label: "慎重", power: 0.9, reward: 0.85, loss: 0.55 },
  standard: { label: "標準", power: 1, reward: 1, loss: 1 },
  assault: { label: "強襲", power: 1.22, reward: 1.25, loss: 1.55 },
};

const ENEMY_COLONIES = [
  { id: "weak", name: "弱小コロニー", power: 18, defense: 10, rewardFood: 80, rewardTerritory: 1, cooldown: 45, threatIncrease: 1 },
  { id: "nearby", name: "近隣コロニー", power: 45, defense: 28, rewardFood: 180, rewardTerritory: 2, cooldown: 75, threatIncrease: 2 },
  { id: "large", name: "大型コロニー", power: 95, defense: 65, rewardFood: 420, rewardTerritory: 4, cooldown: 120, threatIncrease: 3 },
  { id: "queen", name: "女王防衛コロニー", power: 180, defense: 140, rewardFood: 1000, rewardTerritory: 8, cooldown: 180, threatIncrease: 4 },
];

function createDefaultColonyState(now = Date.now()) {
  return {
    version: CURRENT_COLONY_VERSION,
    food: 8,
    lifetimeFood: 8,
    antPopulation: 12,
    soldierAnts: 1,
    attackPower: 1,
    defensePower: 1,
    nestLevel: 1,
    territory: 0,
    enemyThreat: 1,
    woundedAnts: 0,
    battleCooldownUntil: 0,
    unlockedEnemyColonies: ["weak"],
    upgrades: {
      foragerTrails: 0,
      broodNursery: 0,
      storageChambers: 0,
      queenCare: 0,
      soldierTraining: 0,
      mandibleStrength: 0,
      nestGuard: 0,
      tacticalPheromone: 0,
    },
    battleLog: [],
    lastSavedAt: now,
  };
}

function formatNumber(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${Math.floor(value)}`;
}

function formatRate(value) {
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function formatDuration(seconds) {
  const remaining = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return minutes > 0 ? `${minutes}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

function closestPointOnSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const len = vx * vx + vz * vz || 1;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / len, 0, 1);
  return { x: ax + vx * t, z: az + vz * t, t };
}

function makeGroundTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 768;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 768, 768);
  gradient.addColorStop(0, "#c9aa67");
  gradient.addColorStop(0.48, "#a9824b");
  gradient.addColorStop(1, "#77603d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 768, 768);

  for (let i = 0; i < 3400; i += 1) {
    const x = Math.random() * 768;
    const y = Math.random() * 768;
    const r = Math.random() * 1.8 + 0.35;
    context.fillStyle = Math.random() > 0.5 ? "rgba(53,38,23,0.17)" : "rgba(255,232,170,0.12)";
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 5);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function disposeMaterial(material) {
  for (const item of getMaterialList(material)) {
    for (const value of Object.values(item)) {
      if (value && value.isTexture) value.dispose();
    }
    item.dispose();
  }
}

function disposeObject3D(root, { skipGeometries = new Set(), skipMaterials = new Set() } = {}) {
  root.traverse((object) => {
    if (object.geometry && !skipGeometries.has(object.geometry)) object.geometry.dispose();
    for (const material of getMaterialList(object.material)) {
      if (material && !skipMaterials.has(material)) disposeMaterial(material);
    }
  });
  root.parent?.remove(root);
}

class LoadingScreen {
  constructor(elements) {
    this.overlay = elements.overlay;
    this.bar = elements.bar;
    this.label = elements.label;
    this.errorPanel = elements.errorPanel;
    this.errorMessage = elements.errorMessage;
  }

  setProgress(label, loaded = 0, total = 1) {
    if (!this.overlay) return;
    const progress = total > 0 ? clamp((loaded / total) * 100, 3, 100) : 20;
    this.label.textContent = label;
    this.bar.style.width = `${progress}%`;
  }

  hide() {
    if (!this.overlay) return;
    this.overlay.classList.add("is-hidden");
    window.setTimeout(() => {
      this.overlay.hidden = true;
    }, 220);
  }

  showError(message) {
    if (this.overlay) this.overlay.hidden = true;
    if (!this.errorPanel) return;
    this.errorMessage.textContent = message;
    this.errorPanel.hidden = false;
  }
}

class AssetService {
  constructor(loadingScreen) {
    this.loadingScreen = loadingScreen;
    this.manager = new THREE.LoadingManager(
      () => this.loadingScreen.setProgress("ready", 1, 1),
      (_url, loaded, total) => this.loadingScreen.setProgress("assets", loaded, total),
      (url) => this.loadingScreen.showError(`Asset failed to load: ${url}`),
    );
    this.cache = new Map();
  }

  preloadProceduralAssets() {
    this.manager.itemStart("procedural-ground");
    const groundTexture = makeGroundTexture();
    groundTexture.anisotropy = 4;
    this.cache.set("groundTexture", groundTexture);
    this.manager.itemEnd("procedural-ground");
  }

  get(name) {
    return this.cache.get(name);
  }

  dispose() {
    for (const asset of this.cache.values()) {
      if (asset && typeof asset.dispose === "function") asset.dispose();
    }
    this.cache.clear();
  }
}

class InputManager {
  constructor(sim, element) {
    this.sim = sim;
    this.element = element;
    this.handlers = {
      pointerdown: (event) => sim.onPointerDown(event),
      pointermove: (event) => sim.onPointerMove(event),
      pointerup: (event) => sim.onPointerUp(event),
      pointercancel: (event) => sim.onPointerUp(event),
    };
    for (const [type, handler] of Object.entries(this.handlers)) {
      element.addEventListener(type, handler, { passive: false });
    }
  }

  dispose() {
    for (const [type, handler] of Object.entries(this.handlers)) {
      this.element.removeEventListener(type, handler);
    }
  }
}

class DebugPanel {
  constructor(sim) {
    this.sim = sim;
    this.enabled = IS_DEBUG;
    this.elapsed = 0;
    this.frames = 0;
    this.frameMs = 0;
    if (!this.enabled) return;
    ui.debugPanel.hidden = false;
    ui.qualitySelect.value = sim.quality.label;
    ui.qualitySelect.addEventListener("change", () => {
      writeStorage("ant3d.quality", ui.qualitySelect.value);
      window.location.reload();
    });
  }

  sample(dt) {
    if (!this.enabled) return;
    this.elapsed += dt;
    this.frames += 1;
    if (this.elapsed < 0.5) return;
    const info = this.sim.renderer.info;
    this.frameMs = (this.elapsed / this.frames) * 1000;
    ui.debugMetrics.textContent = [
      `frame ${this.frameMs.toFixed(1)}ms`,
      `fps ${(1000 / this.frameMs).toFixed(0)}`,
      `pixelRatio ${this.sim.currentPixelRatio.toFixed(2)}`,
      `calls ${info.render.calls}`,
      `triangles ${info.render.triangles}`,
      `geometries ${info.memory.geometries}`,
      `textures ${info.memory.textures}`,
      `ants ${this.sim.ants.length}`,
      `objects ${this.sim.water.length + this.sim.stones.length + this.sim.food.length + this.sim.branches.length}`,
    ].join("\n");
    this.elapsed = 0;
    this.frames = 0;
  }
}

class Ant3D {
  constructor(id, sim) {
    this.id = id;
    this.role = this.pickRole();
    const angle = rand(0, Math.PI * 2);
    const spread = rand(3, sim.nest.radius * 1.2);
    this.x = sim.nest.x + Math.cos(angle) * spread;
    this.z = sim.nest.z + Math.sin(angle) * spread;
    this.angle = rand(0, Math.PI * 2);
    this.turnBias = rand(-0.4, 0.4);
    this.baseSpeed = rand(8.5, 15.5);
    this.state = "explore";
    this.stateTime = 0;
    this.wander = rand(0, Math.PI * 2);
    this.wet = 0;
    this.stun = 0;
    this.carrying = 0;
    this.foodSourceId = null;
    this.energy = rand(0.55, 1);
    this.lastTrail = rand(0, 1);
    this.homeTimer = rand(0, 8);
    this.rescueTarget = null;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
    this.steering = { x: 0, z: 0 };
    this.sensed = {
      hazard: { x: 0, z: 0 },
      waterDepth: 0,
      alarm: 0,
      closestFood: null,
      foodDistance: Infinity,
    };
    this.traits = {
      curiosity: rand(0.18, 1),
      caution: rand(0.16, 1),
      social: rand(0.14, 1),
      persistence: rand(0.24, 1),
    };

    if (this.role === "scout") {
      this.traits.curiosity = clamp(this.traits.curiosity + 0.25, 0, 1);
      this.baseSpeed += 2.6;
    } else if (this.role === "nurse") {
      this.traits.social = clamp(this.traits.social + 0.3, 0, 1);
      this.traits.caution = clamp(this.traits.caution + 0.12, 0, 1);
    } else if (this.role === "guard") {
      this.traits.caution = clamp(this.traits.caution + 0.24, 0, 1);
      this.traits.persistence = clamp(this.traits.persistence + 0.18, 0, 1);
    }

  }

  pickRole() {
    const roll = Math.random();
    if (roll < 0.22) return "scout";
    if (roll < 0.72) return "worker";
    if (roll < 0.9) return "nurse";
    return "guard";
  }

  update(dt, sim) {
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
    this.stateTime += dt;
    this.homeTimer += dt;
    this.wet = Math.max(0, this.wet - dt * 0.11);
    this.energy = clamp(this.energy + dt * 0.012, 0, 1);
    this.lastTrail += dt;

    const sensed = this.sense(sim);
    if (sensed.waterDepth > 0.08) {
      this.wet = clamp(this.wet + sensed.waterDepth * dt * 1.8, 0, 1.8);
      if (this.state !== "rescue") {
        this.setState(sensed.waterDepth > 0.64 && chance(0.025 + this.wet * 0.02) ? "stunned" : "panic");
      }
    }

    if (sensed.alarm > 0.55 && this.state === "explore" && chance(dt * (0.55 + this.traits.caution))) {
      this.setState("panic");
    }

    if (this.stun > 0) {
      this.stun -= dt;
      this.state = "stunned";
      this.x += Math.cos(this.angle + rand(-1.5, 1.5)) * dt * 0.8;
      this.z += Math.sin(this.angle + rand(-1.5, 1.5)) * dt * 0.8;
      if (this.stun <= 0 && this.wet < 0.76) this.setState("wet");
      this.keepInWorld(sim);
      return;
    }

    if (this.state === "stunned") {
      this.stun = rand(1.1, 3);
      return;
    }

    if (this.state !== "rescue") {
      const rescueCandidate = sim.findRescueCandidate(this);
      if (rescueCandidate && this.traits.social > 0.57 && chance(dt * (0.8 + this.traits.social))) {
        this.rescueTarget = rescueCandidate;
        this.setState("rescue");
      }
    }

    const steering = this.steering;
    steering.x = 0;
    steering.z = 0;
    this.addSeparation(steering, sim);
    this.addObstacleAvoidance(steering, sim);
    steering.x += sensed.hazard.x * (1.2 + this.traits.caution);
    steering.z += sensed.hazard.z * (1.2 + this.traits.caution);

    if (this.state === "panic") this.updatePanic(dt, sim, steering, sensed);
    else if (this.state === "wet") this.updateWet(dt, sim, steering);
    else if (this.state === "return") this.updateReturn(dt, sim, steering);
    else if (this.state === "rescue") this.updateRescue(dt, sim, steering);
    else this.updateExplore(dt, sim, steering, sensed);

    this.move(dt, sim, steering);
    this.leaveTrail(sim);
  }

  setState(nextState) {
    if (this.state !== nextState) {
      this.state = nextState;
      this.stateTime = 0;
    }
  }

  sense(sim) {
    const sensed = this.sensed;
    const hazard = sensed.hazard;
    hazard.x = 0;
    hazard.z = 0;
    sensed.waterDepth = 0;
    sensed.alarm = 0;
    sensed.closestFood = null;
    sensed.foodDistance = Infinity;

    for (const patch of sim.water) {
      const d = distance2(this.x, this.z, patch.x, patch.z);
      const reach = patch.radius + 10;
      if (d < reach) {
        const strength = (1 - d / reach) * patch.power;
        hazard.x += ((this.x - patch.x) / (d || 1)) * strength * 1.7;
        hazard.z += ((this.z - patch.z) / (d || 1)) * strength * 1.7;
        if (d < patch.radius) sensed.waterDepth = Math.max(sensed.waterDepth, (1 - d / patch.radius) * patch.power);
      }
    }

    for (const stone of sim.stones) {
      const d = distance2(this.x, this.z, stone.x, stone.z);
      const reach = stone.radius + 16;
      if (d < reach) {
        const strength = 1 - d / reach;
        hazard.x += ((this.x - stone.x) / (d || 1)) * strength * 1.25;
        hazard.z += ((this.z - stone.z) / (d || 1)) * strength * 1.25;
      }
      if (stone.shock > 0 && d < stone.radius + stone.shock * 34) {
        sensed.alarm = Math.max(sensed.alarm, stone.shock * (1 - d / (stone.radius + stone.shock * 34)));
      }
    }

    for (const branch of sim.branches) {
      const p = closestPointOnSegment(this.x, this.z, branch.x1, branch.z1, branch.x2, branch.z2);
      const d = distance2(this.x, this.z, p.x, p.z);
      const reach = branch.width + 7;
      if (d < reach) {
        const strength = 1 - d / reach;
        hazard.x += ((this.x - p.x) / (d || 1)) * strength * 1.3;
        hazard.z += ((this.z - p.z) / (d || 1)) * strength * 1.3;
      }
    }

    for (const trail of sim.trails) {
      const d = distance2(this.x, this.z, trail.x, trail.z);
      if (trail.kind === "alarm" && d < 12) {
        const strength = trail.life * (1 - d / 12);
        sensed.alarm = Math.max(sensed.alarm, strength);
        hazard.x += ((this.x - trail.x) / (d || 1)) * strength * 0.7;
        hazard.z += ((this.z - trail.z) / (d || 1)) * strength * 0.7;
      }
    }

    for (const food of sim.food) {
      if (food.amount <= 0) continue;
      const d = distance2(this.x, this.z, food.x, food.z);
      if (d < sensed.foodDistance) {
        sensed.foodDistance = d;
        sensed.closestFood = food;
      }
    }

    return sensed;
  }

  updateExplore(dt, sim, steering, sensed) {
    if (sensed.closestFood && sensed.foodDistance < sensed.closestFood.radius + 1.5 && this.role !== "guard") {
      this.carrying = Math.min(1, sensed.closestFood.amount);
      this.foodSourceId = sensed.closestFood.id;
      sensed.closestFood.amount -= this.carrying * 0.72;
      sim.refreshFoodMesh(sensed.closestFood);
      this.setState("return");
      return;
    }

    if (sensed.closestFood && sensed.foodDistance < 45 + this.traits.curiosity * 26) {
      const sourceRatio = clamp(sensed.closestFood.amount / sensed.closestFood.initialAmount, 0, 1);
      const strength = (1 - sensed.foodDistance / 75) * (0.85 + this.traits.curiosity) * (0.35 + sourceRatio * 0.65);
      steering.x += ((sensed.closestFood.x - this.x) / (sensed.foodDistance || 1)) * strength;
      steering.z += ((sensed.closestFood.z - this.z) / (sensed.foodDistance || 1)) * strength;
    }

    for (const trail of sim.trails) {
      if (trail.kind !== "food") continue;
      const d = distance2(this.x, this.z, trail.x, trail.z);
      if (d < PHEROMONE_PARAMS.foodFollowRadius && trail.followStrength > 0) {
        const strength = trail.life * trail.followStrength * (1 - d / PHEROMONE_PARAMS.foodFollowRadius) * PHEROMONE_PARAMS.foodFollowGain;
        steering.x += ((trail.x - this.x) / (d || 1)) * strength;
        steering.z += ((trail.z - this.z) / (d || 1)) * strength;
      }
    }

    if (this.homeTimer > 9 + this.traits.persistence * 7 || this.energy < 0.2) {
      this.setState("return");
      this.carrying = 0;
      this.foodSourceId = null;
      this.homeTimer = 0;
      return;
    }

    this.wander += (Math.random() - 0.5) * dt * (2.3 + this.traits.curiosity * 3.2) + this.turnBias * dt;
    steering.x += Math.sin(this.wander) * (0.58 + this.traits.curiosity * 0.5);
    steering.z += Math.cos(this.wander) * (0.58 + this.traits.curiosity * 0.5);

    const homeDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z);
    if (homeDistance > sim.worldRadius * 0.72) {
      steering.x += ((sim.nest.x - this.x) / homeDistance) * 0.9;
      steering.z += ((sim.nest.z - this.z) / homeDistance) * 0.9;
    }
  }

  updateReturn(dt, sim, steering) {
    const d = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    steering.x += ((sim.nest.x - this.x) / d) * (1.55 + this.traits.persistence);
    steering.z += ((sim.nest.z - this.z) / d) * (1.55 + this.traits.persistence);
    this.energy = clamp(this.energy - dt * 0.024, 0, 1);
    if (d < sim.nest.radius * 0.7) {
      if (this.carrying > 0) sim.addColonyFood(this.carrying);
      this.carrying = 0;
      this.foodSourceId = null;
      this.energy = 1;
      this.homeTimer = 0;
      this.setState("explore");
    }
  }

  updatePanic(dt, sim, steering, sensed) {
    this.wander += (Math.random() - 0.5) * dt * 8;
    steering.x += Math.sin(this.wander) * 0.78;
    steering.z += Math.cos(this.wander) * 0.78;
    const d = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    steering.x += ((sim.nest.x - this.x) / d) * this.traits.caution * 0.28;
    steering.z += ((sim.nest.z - this.z) / d) * this.traits.caution * 0.28;
    if (this.lastTrail > 0.28) {
      sim.addTrail(this.x, this.z, "alarm", 0.9);
      this.lastTrail = 0;
    }
    if (this.stateTime > 1.15 + this.traits.caution * 2.1 && sensed.waterDepth < 0.08) {
      this.setState(this.wet > 0.35 ? "wet" : "explore");
    }
  }

  updateWet(dt, sim, steering) {
    const d = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    steering.x += ((sim.nest.x - this.x) / d) * 0.62;
    steering.z += ((sim.nest.z - this.z) / d) * 0.62;
    this.wander += (Math.random() - 0.5) * dt * 2.2;
    steering.x += Math.sin(this.wander) * 0.32;
    steering.z += Math.cos(this.wander) * 0.32;
    if (this.wet < 0.18 && this.stateTime > 1.2) this.setState("explore");
  }

  updateRescue(dt, sim, steering) {
    const target = this.rescueTarget;
    if (!target || target.stun <= 0 || target === this) {
      this.rescueTarget = null;
      this.setState("explore");
      return;
    }
    const d = distance2(this.x, this.z, target.x, target.z) || 1;
    if (d > 2.6) {
      steering.x += ((target.x - this.x) / d) * 2.2;
      steering.z += ((target.z - this.z) / d) * 2.2;
    } else {
      const homeDistance = distance2(target.x, target.z, sim.nest.x, sim.nest.z) || 1;
      const pullX = ((sim.nest.x - target.x) / homeDistance) * 5.5;
      const pullZ = ((sim.nest.z - target.z) / homeDistance) * 5.5;
      target.x += pullX * dt;
      target.z += pullZ * dt;
      target.wet = Math.max(0, target.wet - dt * 0.35);
      target.stun = Math.max(0, target.stun - dt * (0.42 + this.traits.social * 0.55));
      if (this.lastTrail > 0.38) {
        sim.addTrail(this.x, this.z, "rescue", 0.86);
        this.lastTrail = 0;
      }
    }
    if (this.stateTime > 7.5) {
      this.rescueTarget = null;
      this.setState("explore");
    }
  }

  addSeparation(steering, sim) {
    let sx = 0;
    let sz = 0;
    let count = 0;
    for (const other of sim.ants) {
      if (other === this) continue;
      const d = distance2(this.x, this.z, other.x, other.z);
      if (d > 0 && d < 2.2) {
        sx += (this.x - other.x) / d;
        sz += (this.z - other.z) / d;
        count += 1;
      }
    }
    if (count) {
      steering.x += (sx / count) * 0.52;
      steering.z += (sz / count) * 0.52;
    }
  }

  addObstacleAvoidance(steering, sim) {
    for (const stone of sim.stones) {
      const d = distance2(this.x, this.z, stone.x, stone.z);
      if (d < stone.radius + 1.1) {
        const nx = (this.x - stone.x) / (d || 1);
        const nz = (this.z - stone.z) / (d || 1);
        this.x = stone.x + nx * (stone.radius + 1.1);
        this.z = stone.z + nz * (stone.radius + 1.1);
        steering.x += nx * 1.25;
        steering.z += nz * 1.25;
      }
    }
    for (const branch of sim.branches) {
      const p = closestPointOnSegment(this.x, this.z, branch.x1, branch.z1, branch.x2, branch.z2);
      const d = distance2(this.x, this.z, p.x, p.z);
      if (d < branch.width + 0.8) {
        const nx = (this.x - p.x) / (d || 1);
        const nz = (this.z - p.z) / (d || 1);
        this.x = p.x + nx * (branch.width + 0.8);
        this.z = p.z + nz * (branch.width + 0.8);
        steering.x += nx;
        steering.z += nz;
      }
    }
  }

  move(dt, sim, steering) {
    const length = Math.hypot(steering.x, steering.z);
    if (length > 0.001) {
      const targetAngle = Math.atan2(steering.x, steering.z);
      const turnRate = (this.state === "panic" ? 8.6 : 4.6) * dt;
      this.angle += clamp(normAngle(targetAngle - this.angle), -turnRate, turnRate);
    } else {
      this.angle += (Math.random() - 0.5) * dt;
    }

    let speed = this.baseSpeed;
    if (this.state === "panic") speed *= 1.42;
    if (this.state === "return") speed *= 1.08;
    if (this.state === "rescue") speed *= 0.92;
    if (this.state === "wet") speed *= 0.56;
    if (this.carrying > 0) speed *= 0.75;
    speed *= clamp(1 - this.wet * 0.3, 0.34, 1);
    speed *= sim.timeScale;

    this.x += Math.sin(this.angle) * speed * dt;
    this.z += Math.cos(this.angle) * speed * dt;
    this.keepInWorld(sim);
  }

  keepInWorld(sim) {
    const d = Math.hypot(this.x, this.z);
    if (d > sim.worldRadius) {
      const nx = this.x / d;
      const nz = this.z / d;
      this.x = nx * sim.worldRadius;
      this.z = nz * sim.worldRadius;
      this.angle += Math.PI * 0.8;
    }
  }

  leaveTrail(sim) {
    if (this.state === "return" && this.carrying > 0 && this.lastTrail > PHEROMONE_PARAMS.foodDepositInterval) {
      const source = sim.getFoodSource(this.foodSourceId);
      if (source) {
        const sourceRatio = clamp(source.amount / source.initialAmount, 0, 1);
        const strength = PHEROMONE_PARAMS.foodBaseStrength + sourceRatio * PHEROMONE_PARAMS.foodSourceStrengthBonus;
        sim.addTrail(this.x, this.z, "food", strength, {
          sourceId: this.foodSourceId,
          sourceRatio,
        });
      }
      this.lastTrail = 0;
    } else if (this.state === "wet" && this.lastTrail > 0.6) {
      sim.addTrail(this.x, this.z, "water", 0.45);
      this.lastTrail = 0;
    }
  }

  shock(strength) {
    if (strength > 0.82 && chance(0.24 + this.traits.caution * 0.18)) {
      this.stun = rand(0.8, 2.8) * strength;
      this.setState("stunned");
    } else if (strength > 0.18) {
      this.setState("panic");
    }
  }

  renderState(sim, alpha) {
    return {
      x: this.prevX + (this.x - this.prevX) * alpha,
      z: this.prevZ + (this.z - this.prevZ) * alpha,
      angle: this.prevAngle + normAngle(this.angle - this.prevAngle) * alpha,
      y: 0.72 + Math.sin(sim.renderTime * 0.006 + this.id) * 0.03,
      scale: this.state === "stunned" ? 0.82 : 1,
      state: this.state,
      carrying: this.carrying,
    };
  }
}

const ANT_BODY_PARTS = [
  { name: "gaster", x: 0, y: 0, z: -1.78, sx: 0.48, sy: 0.29, sz: 0.72 },
  { name: "postpetiole", x: 0, y: -0.02, z: -0.82, sx: 0.18, sy: 0.16, sz: 0.19 },
  { name: "petiole", x: 0, y: -0.02, z: -0.48, sx: 0.14, sy: 0.14, sz: 0.16 },
  { name: "mesosoma", x: 0, y: 0, z: 0.18, sx: 0.36, sy: 0.25, sz: 0.58 },
  { name: "head", x: 0, y: 0, z: 1.22, sx: 0.42, sy: 0.27, sz: 0.42 },
];

const ANT_APPENDAGE_SEGMENTS = (() => {
  const segments = [];
  for (const side of [-1, 1]) {
    const legs = [
      { rootX: 0.22, rootZ: 0.52, elbowX: 0.64, elbowZ: 0.96, footX: 1.22, footZ: 1.22 },
      { rootX: 0.28, rootZ: 0.13, elbowX: 0.82, elbowZ: 0.08, footX: 1.36, footZ: -0.02 },
      { rootX: 0.22, rootZ: -0.22, elbowX: 0.64, elbowZ: -0.64, footX: 1.18, footZ: -1.08 },
    ];
    for (const leg of legs) {
      segments.push({ radius: 0.026, from: [side * leg.rootX, -0.02, leg.rootZ], to: [side * leg.elbowX, -0.13, leg.elbowZ] });
      segments.push({ radius: 0.021, from: [side * leg.elbowX, -0.13, leg.elbowZ], to: [side * leg.footX, -0.25, leg.footZ] });
    }
    segments.push({ radius: 0.021, from: [side * 0.16, 0.05, 1.54], to: [side * 0.42, 0.02, 1.96] });
    segments.push({ radius: 0.017, from: [side * 0.42, 0.02, 1.96], to: [side * 0.78, -0.06, 2.26] });
    segments.push({ radius: 0.024, from: [side * 0.12, -0.04, 1.54], to: [side * 0.34, -0.08, 1.76] });
  }
  return segments;
})();

class AntRenderSystem {
  constructor(sim, capacity) {
    this.sim = sim;
    this.capacity = capacity;
    this.bodyMeshes = new Map();
    this.bodyCounts = new Map();
    this.dummy = new THREE.Object3D();
    this.segmentStart = new THREE.Vector3();
    this.segmentEnd = new THREE.Vector3();
    this.segmentMid = new THREE.Vector3();
    this.segmentDirection = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.segmentQuaternion = new THREE.Quaternion();

    for (const [state, material] of Object.entries(sim.materials.antByState)) {
      const partMeshes = new Map();
      const partCounts = new Map();
      for (const part of ANT_BODY_PARTS) {
        const mesh = new THREE.InstancedMesh(sim.geometries.antSphere, material, capacity);
        mesh.count = 0;
        mesh.castShadow = sim.quality.shadowQuality !== "off";
        mesh.frustumCulled = false;
        sim.scene.add(mesh);
        partMeshes.set(part.name, mesh);
        partCounts.set(part.name, 0);
      }
      this.bodyMeshes.set(state, partMeshes);
      this.bodyCounts.set(state, partCounts);
    }

    this.appendageGeometry = new THREE.CylinderGeometry(1, 1, 1, 4, 1);
    this.appendageMesh = new THREE.InstancedMesh(this.appendageGeometry, sim.materials.antAppendage, capacity * ANT_APPENDAGE_SEGMENTS.length);
    this.appendageMesh.count = 0;
    this.appendageMesh.castShadow = sim.quality.shadowQuality !== "off";
    this.appendageMesh.frustumCulled = false;
    sim.scene.add(this.appendageMesh);

    this.foodMesh = new THREE.InstancedMesh(sim.geometries.foodCrumb, sim.materials.food, capacity);
    this.foodMesh.count = 0;
    this.foodMesh.castShadow = sim.quality.shadowQuality !== "off";
    this.foodMesh.frustumCulled = false;
    sim.scene.add(this.foodMesh);
  }

  beginFrame() {
    for (const counts of this.bodyCounts.values()) {
      for (const key of counts.keys()) counts.set(key, 0);
    }
    this.appendageCount = 0;
    this.foodCount = 0;
  }

  renderAnt(ant, renderState) {
    const meshes = this.bodyMeshes.get(renderState.state) ?? this.bodyMeshes.get("explore");
    const counts = this.bodyCounts.get(renderState.state) ?? this.bodyCounts.get("explore");
    for (const part of ANT_BODY_PARTS) {
      const index = counts.get(part.name);
      this.composeLocalMatrix(renderState, part.x, part.y, part.z, part.sx, part.sy, part.sz);
      meshes.get(part.name).setMatrixAt(index, this.dummy.matrix);
      counts.set(part.name, index + 1);
    }

    for (const segment of ANT_APPENDAGE_SEGMENTS) {
      this.composeSegmentMatrix(renderState, segment);
      this.appendageMesh.setMatrixAt(this.appendageCount, this.dummy.matrix);
      this.appendageCount += 1;
    }

    if (renderState.carrying > 0) {
      this.composeLocalMatrix(renderState, 0, 0.14, 1.9, 0.72, 0.72, 0.72);
      this.foodMesh.setMatrixAt(this.foodCount, this.dummy.matrix);
      this.foodCount += 1;
    }
  }

  composeLocalMatrix(renderState, localX, localY, localZ, scaleX, scaleY, scaleZ) {
    const sin = Math.sin(renderState.angle);
    const cos = Math.cos(renderState.angle);
    this.dummy.position.set(
      renderState.x + localX * cos + localZ * sin,
      renderState.y + localY * renderState.scale,
      renderState.z - localX * sin + localZ * cos,
    );
    this.dummy.rotation.set(0, renderState.angle, 0);
    this.dummy.scale.set(scaleX * renderState.scale, scaleY * renderState.scale, scaleZ * renderState.scale);
    this.dummy.updateMatrix();
  }

  composeSegmentMatrix(renderState, segment) {
    this.localPointToWorld(renderState, segment.from, this.segmentStart);
    this.localPointToWorld(renderState, segment.to, this.segmentEnd);
    this.segmentMid.addVectors(this.segmentStart, this.segmentEnd).multiplyScalar(0.5);
    this.segmentDirection.subVectors(this.segmentEnd, this.segmentStart);
    const length = this.segmentDirection.length();
    this.segmentDirection.normalize();
    this.segmentQuaternion.setFromUnitVectors(this.up, this.segmentDirection);
    this.dummy.position.copy(this.segmentMid);
    this.dummy.quaternion.copy(this.segmentQuaternion);
    this.dummy.scale.set(segment.radius * renderState.scale, length, segment.radius * renderState.scale);
    this.dummy.updateMatrix();
  }

  localPointToWorld(renderState, point, target) {
    const sin = Math.sin(renderState.angle);
    const cos = Math.cos(renderState.angle);
    const localX = point[0] * renderState.scale;
    const localY = point[1] * renderState.scale;
    const localZ = point[2] * renderState.scale;
    target.set(
      renderState.x + localX * cos + localZ * sin,
      renderState.y + localY,
      renderState.z - localX * sin + localZ * cos,
    );
  }

  endFrame() {
    for (const [state, meshes] of this.bodyMeshes.entries()) {
      const counts = this.bodyCounts.get(state);
      for (const [partName, mesh] of meshes.entries()) {
        mesh.count = counts.get(partName);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.appendageMesh.count = this.appendageCount;
    this.appendageMesh.instanceMatrix.needsUpdate = true;
    this.foodMesh.count = this.foodCount;
    this.foodMesh.instanceMatrix.needsUpdate = true;
  }

  render(ants, sim, alpha) {
    this.beginFrame();
    for (const ant of ants) this.renderAnt(ant, ant.renderState(sim, alpha));
    this.endFrame();
  }

  destroy() {
    for (const meshes of this.bodyMeshes.values()) {
      for (const mesh of meshes.values()) this.sim.scene.remove(mesh);
    }
    this.sim.scene.remove(this.appendageMesh);
    this.sim.scene.remove(this.foodMesh);
    this.appendageGeometry.dispose();
  }
}

class AntColony3D {
  constructor() {
    this.loadingScreen = new LoadingScreen({
      overlay: ui.loadingOverlay,
      bar: ui.loadingBar,
      label: ui.loadingLabel,
      errorPanel: ui.errorPanel,
      errorMessage: ui.errorMessage,
    });
    this.quality = chooseQualityPreset();
    this.assetService = new AssetService(this.loadingScreen);
    this.colony = this.loadColonyState();
    this.colonySaveTimer = 0;
    this.toastTimer = 0;
    this.currentPixelRatio = 1;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x181a18);
    this.scene.fog = new THREE.Fog(0x181a18, 145, 285);
    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 320);
    this.renderer = this.createRenderer();
    if (!this.renderer) return;
    ui.world.appendChild(this.renderer.domElement);

    this.frameAccumulator = 0;
    this.lastFrameTime = 0;
    this.renderTime = 0;
    this.isRunning = false;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.groundHit = new THREE.Vector3();
    this.pointerMap = new Map();
    this.pointerStart = null;
    this.branchDraft = null;
    this.branchPreview = null;
    this.pinchStart = null;
    this.dragMoved = false;

    this.tool = "inspect";
    this.paused = false;
    this.timeScale = 1;
    this.worldRadius = 82;
    this.nest = { x: -22, z: 7, radius: 12 };
    this.selectedAnt = null;
    this.collectedFood = this.colony.food;
    this.nextFoodId = 1;
    this.ants = [];
    this.water = [];
    this.stones = [];
    this.food = [];
    this.branches = [];
    this.trails = [];
    this.lastUiUpdate = 0;
    this.resizeWidth = 0;
    this.resizeHeight = 0;

    this.cameraTarget = new THREE.Vector3(this.nest.x * 0.55, 0, this.nest.z * 0.55);
    this.cameraRenderTarget = this.cameraTarget.clone();
    this.cameraYaw = -0.62;
    this.cameraPitch = 1.05;
    this.targetCameraYaw = this.cameraYaw;
    this.targetCameraPitch = this.cameraPitch;
    this.cameraDistance = window.innerWidth < 680 ? 174 : 162;
    this.targetCameraDistance = this.cameraDistance;

    this.sharedGeometries = new Set();
    this.sharedMaterials = new Set();
    this.dynamicObjects = new Set();

    this.assetService.preloadProceduralAssets();
    this.createSharedAssets();
    this.antRenderer = new AntRenderSystem(this, Number(ui.antCount.max));
    this.createWorld();
    this.bindEvents();
    this.debugPanel = new DebugPanel(this);
    this.reset();
    this.resize();
    window.__ANT_SIM = this;
    this.prewarmAndStart();
  }

  createRenderer() {
    this.loadingScreen.setProgress("renderer", 0, 1);
    const probe = document.createElement("canvas");
    const hasWebGL2 = Boolean(probe.getContext("webgl2"));
    const hasWebGL = hasWebGL2 || Boolean(probe.getContext("webgl") || probe.getContext("experimental-webgl"));
    if (!hasWebGL) {
      this.loadingScreen.showError("この端末では WebGL を開始できません。ブラウザまたはGPU設定を確認してください。");
      return null;
    }

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: this.quality.antialias,
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
    } catch (error) {
      this.loadingScreen.showError(`Renderer init failed: ${error.message}`);
      return null;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.quality.toneMappingExposure;
    renderer.shadowMap.enabled = this.quality.shadowQuality !== "off";
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = true;
    this.webglTier = hasWebGL2 ? "webgl2" : "webgl1";
    return renderer;
  }

  createSharedAssets() {
    this.geometries = {
      antSphere: new THREE.SphereGeometry(1, 12, 8),
      foodCrumb: new THREE.SphereGeometry(0.8, 10, 8),
      waterCircle: new THREE.CircleGeometry(1, 64),
      trailCircle: new THREE.CircleGeometry(1, 18),
      impactRing: new THREE.TorusGeometry(1, 0.035, 8, 72),
    };

    this.materials = {
      ground: new THREE.MeshStandardMaterial({
        map: this.assetService.get("groundTexture"),
        roughness: 0.92,
        metalness: 0,
      }),
      nest: new THREE.MeshStandardMaterial({ color: 0x6d4e2a, roughness: 0.95 }),
      nestDark: new THREE.MeshBasicMaterial({ color: 0x1d140e }),
      antDefault: new THREE.MeshStandardMaterial({ color: 0x18130f, roughness: 0.72 }),
      antAppendage: new THREE.MeshStandardMaterial({ color: 0x12100d, roughness: 0.82 }),
      food: new THREE.MeshStandardMaterial({ color: 0xd9a63f, roughness: 0.62 }),
      stone: new THREE.MeshStandardMaterial({ color: 0x777c75, roughness: 0.86 }),
      branch: new THREE.MeshStandardMaterial({ color: 0x8a6232, roughness: 0.9 }),
      water: new THREE.MeshPhysicalMaterial({
        color: 0x4aa6d9,
        transparent: true,
        opacity: 0.42,
        roughness: 0.12,
        metalness: 0,
        transmission: 0.15,
        depthWrite: false,
      }),
      waterRing: new THREE.MeshBasicMaterial({ color: 0x9ce7ff, transparent: true, opacity: 0.48 }),
      impact: new THREE.MeshBasicMaterial({ color: 0xe47f63, transparent: true, opacity: 0.42 }),
      trailFood: new THREE.MeshBasicMaterial({ color: 0xd9a63f, transparent: true, opacity: 0.2, depthWrite: false }),
      trailAlarm: new THREE.MeshBasicMaterial({ color: 0xd96f58, transparent: true, opacity: 0.24, depthWrite: false }),
      trailRescue: new THREE.MeshBasicMaterial({ color: 0x51b7a6, transparent: true, opacity: 0.22, depthWrite: false }),
      trailWater: new THREE.MeshBasicMaterial({ color: 0x55aee0, transparent: true, opacity: 0.18, depthWrite: false }),
    };

    this.materials.antByState = {
      explore: this.materials.antDefault,
      return: new THREE.MeshStandardMaterial({ color: 0x2a1b0e, roughness: 0.72 }),
      panic: new THREE.MeshStandardMaterial({ color: 0x7f241a, roughness: 0.7 }),
      wet: new THREE.MeshStandardMaterial({ color: 0x174b63, roughness: 0.64 }),
      stunned: new THREE.MeshStandardMaterial({ color: 0x5b6261, roughness: 0.82 }),
      rescue: new THREE.MeshStandardMaterial({ color: 0x17645a, roughness: 0.7 }),
    };

    for (const geometry of Object.values(this.geometries)) this.sharedGeometries.add(geometry);
    for (const material of Object.values(this.materials)) {
      if (material && material.isMaterial) this.sharedMaterials.add(material);
    }
    for (const material of Object.values(this.materials.antByState)) this.sharedMaterials.add(material);
  }

  createWorld() {
    const hemi = new THREE.HemisphereLight(0xf8ead2, 0x21352e, 1.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffedc8, 2.2);
    sun.position.set(-48, 88, 42);
    sun.castShadow = this.quality.shadowQuality !== "off";
    if (sun.castShadow) {
      const mapSize = this.quality.shadowQuality === "medium" ? 1024 : 512;
      sun.shadow.mapSize.set(mapSize, mapSize);
      sun.shadow.camera.left = -70;
      sun.shadow.camera.right = 70;
      sun.shadow.camera.top = 70;
      sun.shadow.camera.bottom = -70;
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 180;
      sun.shadow.bias = -0.00015;
    }
    this.scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(this.worldRadius + 12, 144), this.materials.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(ground);
    this.sharedGeometries.add(ground.geometry);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(this.worldRadius + 2, 0.26, 8, 160),
      new THREE.MeshBasicMaterial({ color: 0x51412b, transparent: true, opacity: 0.46 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.02;
    this.scene.add(rim);
    this.sharedGeometries.add(rim.geometry);
    this.sharedMaterials.add(rim.material);

    this.createNest();
  }

  createNest() {
    const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.materials.nest);
    mound.position.set(this.nest.x, 1.25, this.nest.z);
    mound.scale.set(this.nest.radius * 1.15, 2.1, this.nest.radius * 0.82);
    mound.castShadow = this.quality.shadowQuality !== "off";
    mound.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(mound);
    this.sharedGeometries.add(mound.geometry);

    for (let i = 0; i < 5; i += 1) {
      const angle = i * 1.25 + 0.4;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(1, 22), this.materials.nestDark);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(
        this.nest.x + Math.cos(angle) * this.nest.radius * rand(0.08, 0.45),
        2.72,
        this.nest.z + Math.sin(angle) * this.nest.radius * rand(0.08, 0.35),
      );
      hole.scale.set(rand(1.0, 1.8), rand(0.55, 0.95), 1);
      this.scene.add(hole);
      this.sharedGeometries.add(hole.geometry);
    }
  }

  bindEvents() {
    this.boundResize = () => this.resize();
    this.boundPageHide = () => this.dispose();
    window.addEventListener("resize", this.boundResize);
    window.addEventListener("pagehide", this.boundPageHide, { once: true });

    ui.buttons.forEach((button) => {
      button.addEventListener("click", () => {
        this.tool = button.dataset.tool;
        ui.activeToolLabel.textContent = button.dataset.label;
        ui.buttons.forEach((item) => item.classList.toggle("active", item === button));
      });
    });

    ui.pause.addEventListener("click", () => {
      this.paused = !this.paused;
      ui.pause.classList.toggle("is-paused", this.paused);
      ui.pause.title = this.paused ? "再開" : "一時停止";
      ui.pause.setAttribute("aria-label", ui.pause.title);
    });

    ui.reset.addEventListener("click", () => this.reset());
    ui.antCount.addEventListener("input", () => {
      ui.antCountValue.value = ui.antCount.value;
      this.syncVisibleAnts();
      this.updateColonyUi();
    });
    ui.intensity.addEventListener("input", () => {
      ui.intensityValue.value = ui.intensity.value;
    });

    ui.colonyTabs.forEach((button) => {
      button.addEventListener("click", () => this.setColonyTab(button.dataset.colonyTab));
    });
    ui.upgradeButtons.forEach((button) => {
      button.addEventListener("click", () => this.buyUpgrade(button.dataset.upgrade));
    });
    ui.nestExpand.addEventListener("click", () => this.expandNest());
    ui.expeditionEnemy.addEventListener("change", () => this.updateExpeditionUi());
    ui.expeditionTactic.addEventListener("change", () => this.updateExpeditionUi());
    ui.expeditionSoldiers.addEventListener("input", () => this.updateExpeditionUi());
    ui.expeditionStart.addEventListener("click", () => {
      const result = this.runExpedition(ui.expeditionEnemy.value, Number(ui.expeditionSoldiers.value), ui.expeditionTactic.value);
      if (result.ok) this.showBattleToast(result.message);
      else this.showBattleToast(result.message, "error");
    });

    const canvas = this.renderer.domElement;
    this.input = new InputManager(this, canvas);
  }

  reset() {
    for (const list of [this.water, this.stones, this.food, this.branches, this.trails]) {
      for (const item of list) this.disposeDynamicItem(item);
    }
    this.dynamicObjects.clear();
    this.ants = [];
    this.water = [];
    this.stones = [];
    this.food = [];
    this.branches = [];
    this.trails = [];
    this.antRenderer?.beginFrame();
    this.antRenderer?.endFrame();
    this.collectedFood = this.colony.food;
    this.nextFoodId = 1;
    this.selectedAnt = null;
    const count = this.getVisibleAntTarget();
    for (let i = 0; i < count; i += 1) this.ants.push(new Ant3D(i + 1, this));
    this.updateStats();
    this.updateColonyUi();
    this.updateInspector();
  }

  disposeDynamicItem(item) {
    if (item.group) {
      disposeObject3D(item.group, {
        skipGeometries: this.sharedGeometries,
        skipMaterials: this.sharedMaterials,
      });
      this.dynamicObjects.delete(item.group);
    }
    if (item.mesh) {
      disposeObject3D(item.mesh, {
        skipGeometries: this.sharedGeometries,
        skipMaterials: this.sharedMaterials,
      });
      this.dynamicObjects.delete(item.mesh);
    }
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width === this.resizeWidth && height === this.resizeHeight) return;
    this.resizeWidth = width;
    this.resizeHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.currentPixelRatio = Math.min((window.devicePixelRatio || 1) * this.quality.resolutionScale, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(width, height, false);
    this.cameraDistance = width < 680 ? 174 : 162;
    this.targetCameraDistance = this.cameraDistance;
    this.updateCamera();
  }

  updateCamera() {
    this.cameraYaw += (this.targetCameraYaw - this.cameraYaw) * 0.16;
    this.cameraPitch += (this.targetCameraPitch - this.cameraPitch) * 0.16;
    this.cameraDistance += (this.targetCameraDistance - this.cameraDistance) * 0.16;
    this.cameraRenderTarget.lerp(this.cameraTarget, 0.14);
    const horizontal = Math.cos(this.cameraPitch) * this.cameraDistance;
    const y = Math.sin(this.cameraPitch) * this.cameraDistance;
    this.camera.position.set(
      this.cameraRenderTarget.x + Math.sin(this.cameraYaw) * horizontal,
      y,
      this.cameraRenderTarget.z + Math.cos(this.cameraYaw) * horizontal,
    );
    this.camera.lookAt(this.cameraRenderTarget);
  }

  async prewarmAndStart() {
    this.loadingScreen.setProgress("compile", 0.75, 1);
    try {
      if (typeof this.renderer.compileAsync === "function") {
        await this.renderer.compileAsync(this.scene, this.camera);
      } else {
        this.renderer.compile(this.scene, this.camera);
      }
    } catch (error) {
      this.loadingScreen.showError(`Shader compile failed: ${error.message}`);
      return;
    }
    this.loadingScreen.hide();
    this.startLoop();
  }

  startLoop() {
    this.isRunning = true;
    this.lastFrameTime = 0;
    this.frameAccumulator = 0;
    this.renderer.setAnimationLoop((time) => this.tick(time));
  }

  tick(timeMs) {
    if (!this.isRunning) return;
    const time = timeMs / 1000;
    const frameDelta = this.lastFrameTime === 0 ? FIXED_DT : clamp(time - this.lastFrameTime, 0, MAX_FRAME_DELTA);
    this.lastFrameTime = time;
    this.renderTime = timeMs;
    this.debugPanel.sample(frameDelta);

    if (!this.paused) {
      this.frameAccumulator += frameDelta;
      let steps = 0;
      while (this.frameAccumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
        this.updateGame(FIXED_DT);
        this.frameAccumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps === MAX_FIXED_STEPS) this.frameAccumulator = 0;
    }

    const alpha = this.paused ? 1 : clamp(this.frameAccumulator / FIXED_DT, 0, 1);
    this.renderGame(alpha);
  }

  updateGame(dt) {
    this.updateColonyProgress(dt);
    this.syncVisibleAnts();

    for (const patch of this.water) {
      patch.age += dt;
      patch.power = Math.max(0.08, patch.power - dt * 0.014);
      patch.group.scale.setScalar(1 + Math.sin(patch.age * 2.5) * 0.015);
      patch.ring.material.opacity = Math.max(0.1, patch.power * 0.44);
      patch.ring.scale.setScalar(1 + (patch.age % 1) * 0.05);
    }
    this.water = this.water.filter((patch) => {
      if (patch.power > 0.09 && patch.age < 85) return true;
      this.disposeDynamicItem(patch);
      return false;
    });

    for (const stone of this.stones) {
      stone.shock = Math.max(0, stone.shock - dt * 0.7);
      stone.ring.visible = stone.shock > 0.02;
      if (stone.ring.visible) {
        stone.ring.scale.setScalar(1 + (1 - stone.shock) * 7);
        stone.ring.material.opacity = stone.shock * 0.45;
      }
    }

    for (const trail of this.trails) {
      this.updateTrailPheromone(trail, dt);
      const followVisibility = trail.kind === "food" ? trail.followStrength : 1;
      trail.mesh.material.opacity = Math.max(0, trail.life * trail.baseOpacity * followVisibility);
      trail.mesh.scale.setScalar(trail.scale * (1 + (1 - trail.life) * 0.2));
    }
    this.trails = this.trails.filter((trail) => {
      if (trail.life > 0.02) return true;
      this.disposeDynamicItem(trail);
      return false;
    });

    for (const ant of this.ants) ant.update(dt, this);
    this.updateBattleToast(dt);
    this.colonySaveTimer += dt;
    if (this.colonySaveTimer > COLONY_SAVE_INTERVAL) {
      this.saveColonyState();
      this.colonySaveTimer = 0;
    }
    this.lastUiUpdate += dt;
    if (this.lastUiUpdate > 0.15) {
      this.updateStats();
      this.updateColonyUi();
      this.updateInspector();
      this.lastUiUpdate = 0;
    }
  }

  updateTrailPheromone(trail, dt) {
    if (trail.kind !== "food") {
      trail.life -= dt * trail.decay;
      return;
    }

    const source = this.getFoodSource(trail.sourceId);
    if (!source || source.amount <= 0.05) {
      trail.followStrength = 0;
      trail.life -= dt * PHEROMONE_PARAMS.foodDepletedDecay;
      return;
    }

    const sourceRatio = clamp(source.amount / source.initialAmount, 0, 1);
    const lowSourceFactor = 1 - clamp(sourceRatio / PHEROMONE_PARAMS.foodLowSourceThreshold, 0, 1);
    trail.followStrength = clamp(sourceRatio * trail.sourceRatio, 0.08, 1);
    trail.life -= dt * (PHEROMONE_PARAMS.foodActiveDecay + lowSourceFactor * PHEROMONE_PARAMS.foodLowSourceExtraDecay);
  }

  loadColonyState() {
    const now = Date.now();
    const stored = readStorage(COLONY_STORAGE_KEY);
    let parsed = null;
    try {
      parsed = stored ? JSON.parse(stored) : null;
    } catch {
      parsed = null;
    }
    const state = this.normalizeColonyState(parsed, now);
    const elapsedSeconds = clamp((now - state.lastSavedAt) / 1000, 0, OFFLINE_CAP_SECONDS);
    this.applyOfflineColonyProgress(state, elapsedSeconds);
    state.lastSavedAt = now;
    return state;
  }

  normalizeColonyState(raw, now = Date.now()) {
    const base = createDefaultColonyState(now);
    const source = raw && typeof raw === "object" ? raw : {};
    const migratedSource = this.migrateColonyState(source, base);
    const state = {
      ...base,
      ...migratedSource,
      upgrades: { ...base.upgrades, ...(migratedSource.upgrades ?? {}) },
      unlockedEnemyColonies: Array.isArray(migratedSource.unlockedEnemyColonies) ? migratedSource.unlockedEnemyColonies : base.unlockedEnemyColonies,
      battleLog: Array.isArray(migratedSource.battleLog)
        ? migratedSource.battleLog.slice(0, 5).map((entry) => ({
          message: String(entry?.message ?? "").slice(0, 120),
          type: entry?.type === "win" || entry?.type === "loss" ? entry.type : "info",
          time: String(entry?.time ?? "").slice(0, 8),
        }))
        : [],
    };
    state.food = Math.max(0, Number(state.food) || 0);
    state.lifetimeFood = Math.max(state.food, Number(state.lifetimeFood) || 0);
    state.antPopulation = clamp(Number(state.antPopulation) || base.antPopulation, 1, 100000);
    state.nestLevel = clamp(Math.floor(Number(state.nestLevel) || 1), 1, 999);
    state.territory = Math.max(0, Math.floor(Number(state.territory) || 0));
    state.enemyThreat = clamp(Number(state.enemyThreat) || 0, 0, 100);
    state.woundedAnts = clamp(Number(state.woundedAnts) || 0, 0, state.antPopulation);
    state.battleCooldownUntil = Math.max(0, Number(state.battleCooldownUntil) || 0);
    state.lastSavedAt = Math.max(0, Number(state.lastSavedAt) || now);
    for (const key of Object.keys(UPGRADE_DEFS)) {
      state.upgrades[key] = Math.max(0, Math.floor(Number(state.upgrades[key]) || 0));
    }
    state.version = CURRENT_COLONY_VERSION;
    state.antPopulation = clamp(state.antPopulation, 1, this.getPopulationCap(state));
    state.woundedAnts = clamp(state.woundedAnts, 0, state.antPopulation);
    state.unlockedEnemyColonies = state.unlockedEnemyColonies.filter((id) => ENEMY_COLONIES.some((enemy) => enemy.id === id));
    if (!state.unlockedEnemyColonies.length) state.unlockedEnemyColonies = ["weak"];
    return this.refreshColonyDerivedStats(state);
  }

  migrateColonyState(source, base) {
    if (!source || typeof source !== "object") return source;
    const version = Number(source.version) || 1;
    if (version >= CURRENT_COLONY_VERSION) return source;

    const legacyFood = Math.max(0, Number(source.food) || 0);
    const legacyLifetimeFood = Math.max(legacyFood, Number(source.lifetimeFood) || 0);
    const progressAntBonus = Math.min(18, Math.floor(legacyLifetimeFood / 120));
    const preservedNestLevel = clamp(Math.floor(Number(source.nestLevel) || 1), 1, 2);
    return {
      ...source,
      version: CURRENT_COLONY_VERSION,
      food: Math.max(base.food, Math.min(legacyFood, 140)),
      lifetimeFood: Math.max(base.lifetimeFood, Math.min(legacyLifetimeFood, 320)),
      antPopulation: base.antPopulation + progressAntBonus + (preservedNestLevel - 1) * 6,
      nestLevel: preservedNestLevel,
      enemyThreat: Math.min(Number(source.enemyThreat) || base.enemyThreat, 8),
      woundedAnts: 0,
      battleCooldownUntil: 0,
      upgrades: {
        ...base.upgrades,
        ...(source.upgrades ?? {}),
      },
    };
  }

  applyOfflineColonyProgress(state, seconds) {
    if (seconds <= 0) return;
    const foodGain = this.computeFoodPerSecond(state) * seconds;
    state.food += foodGain;
    state.lifetimeFood += foodGain;
    state.enemyThreat = clamp(state.enemyThreat + seconds * 0.0012, 0, 100);
    state.woundedAnts = Math.max(0, state.woundedAnts - this.computeRecoveryRate(state) * seconds);
    state.antPopulation = Math.min(this.getPopulationCap(state), state.antPopulation + this.computeGrowthRate(state) * seconds);
    this.refreshColonyDerivedStats(state);
  }

  saveColonyState() {
    this.refreshColonyDerivedStats();
    this.colony.lastSavedAt = Date.now();
    writeStorage(COLONY_STORAGE_KEY, JSON.stringify(this.colony));
  }

  refreshColonyDerivedStats(state = this.colony) {
    state.soldierAnts = this.getSoldierAnts(state);
    state.attackPower = this.computeAttackPower(state);
    state.defensePower = this.computeDefensePower(state);
    return state;
  }

  getPopulationCap(state = this.colony) {
    return 24 + state.nestLevel * 18 + state.upgrades.storageChambers * 20 + state.upgrades.queenCare * 6 + state.territory * 6;
  }

  getRoleCounts(state = this.colony) {
    const total = Math.floor(state.antPopulation);
    const soldierRatio = clamp(0.07 + state.upgrades.soldierTraining * 0.018 + state.upgrades.nestGuard * 0.006, 0.07, 0.34);
    const guardBase = Math.floor(total * soldierRatio + state.upgrades.nestGuard * 1.5);
    const guard = Math.min(total, Math.max(total >= 10 ? 1 : 0, guardBase));
    const nurseRatio = clamp(0.16 + state.upgrades.broodNursery * 0.01 + state.upgrades.queenCare * 0.008, 0.16, 0.3);
    const scoutRatio = clamp(0.18 + state.upgrades.foragerTrails * 0.006, 0.18, 0.28);
    const nurse = Math.min(total - guard, Math.floor(total * nurseRatio));
    const scout = Math.min(total - guard - nurse, Math.floor(total * scoutRatio));
    const worker = Math.max(0, total - guard - nurse - scout);
    return { scout, worker, nurse, guard };
  }

  getSoldierAnts(state = this.colony) {
    return this.getRoleCounts(state).guard;
  }

  getAvailableSoldiers(state = this.colony) {
    return Math.max(0, this.getSoldierAnts(state) - Math.ceil(state.woundedAnts));
  }

  computeAttackPower(state = this.colony) {
    return 1 + state.upgrades.soldierTraining * 0.18 + state.upgrades.mandibleStrength * 0.14;
  }

  computeDefensePower(state = this.colony) {
    return 1 + state.upgrades.nestGuard * 0.2;
  }

  computeFoodPerSecond(state = this.colony) {
    const roles = this.getRoleCounts(state);
    const activeRatio = clamp((state.antPopulation - state.woundedAnts) / state.antPopulation, 0, 1);
    const activeWorkers = roles.worker * activeRatio;
    const activeScouts = roles.scout * activeRatio;
    const territoryMultiplier = 1 + state.territory * 0.04;
    const threatPenalty = 1 - Math.min(state.enemyThreat * 0.01, 0.25);
    const foragerMultiplier = 1 + state.upgrades.foragerTrails * 0.18 + state.upgrades.tacticalPheromone * 0.05;
    const storageMultiplier = 1 + state.upgrades.storageChambers * 0.025;
    return (activeWorkers * 0.018 + activeScouts * 0.006) * territoryMultiplier * threatPenalty * foragerMultiplier * storageMultiplier;
  }

  computeRecoveryRate(state = this.colony) {
    const nurses = this.getRoleCounts(state).nurse;
    return nurses * (0.0035 + state.upgrades.broodNursery * 0.0005 + state.upgrades.nestGuard * 0.0004);
  }

  computeGrowthRate(state = this.colony) {
    const roles = this.getRoleCounts(state);
    const cap = this.getPopulationCap(state);
    const openSpaceRatio = clamp((cap - state.antPopulation) / Math.max(1, cap), 0, 1);
    if (openSpaceRatio <= 0) return 0;
    const foodSupport = clamp(0.55 + state.food / 90, 0.55, 1.45);
    const nurseryMultiplier = 1 + state.upgrades.broodNursery * 0.22 + state.upgrades.queenCare * 0.16;
    const baseEggRate = 0.006 + state.nestLevel * 0.002 + state.upgrades.queenCare * 0.0018;
    const nurseCare = roles.nurse * (0.0018 + state.upgrades.broodNursery * 0.00035);
    return (baseEggRate + nurseCare) * foodSupport * nurseryMultiplier * clamp(openSpaceRatio * 1.7, 0.12, 1);
  }

  updateColonyProgress(dt) {
    const foodGain = this.computeFoodPerSecond() * dt;
    this.addColonyFood(foodGain, { silent: true });
    this.colony.enemyThreat = clamp(this.colony.enemyThreat + dt * 0.0012, 0, 100);
    this.colony.woundedAnts = Math.max(0, this.colony.woundedAnts - this.computeRecoveryRate() * dt);
    this.colony.antPopulation = Math.min(this.getPopulationCap(), this.colony.antPopulation + this.computeGrowthRate() * dt);
    this.refreshColonyDerivedStats();
    this.collectedFood = this.colony.food;
  }

  addColonyFood(amount, { silent = false } = {}) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.colony.food += amount;
    this.colony.lifetimeFood += amount;
    this.collectedFood = this.colony.food;
    if (!silent) {
      this.saveColonyState();
      this.updateColonyUi();
    }
  }

  spendColonyFood(cost) {
    if (this.colony.food < cost) return false;
    this.colony.food -= cost;
    this.collectedFood = this.colony.food;
    return true;
  }

  getVisibleAntTarget() {
    return Math.min(Math.floor(this.colony.antPopulation), Number(ui.antCount.value), this.antRenderer.capacity);
  }

  syncVisibleAnts() {
    const target = this.getVisibleAntTarget();
    while (this.ants.length < target) this.ants.push(new Ant3D(this.ants.length + 1, this));
    if (this.ants.length > target) {
      this.ants.length = target;
      if (this.selectedAnt && !this.ants.includes(this.selectedAnt)) this.selectedAnt = null;
    }
  }

  getUpgradeCost(key) {
    const upgrade = UPGRADE_DEFS[key];
    if (!upgrade) return Infinity;
    return Math.floor(upgrade.baseCost * upgrade.growth ** this.colony.upgrades[key]);
  }

  isUpgradeUnlocked(key, state = this.colony) {
    const requirement = UPGRADE_DEFS[key]?.requirement ?? {};
    if (requirement.minAnts && Math.floor(state.antPopulation) < requirement.minAnts) return false;
    if (requirement.minNestLevel && state.nestLevel < requirement.minNestLevel) return false;
    if (requirement.minTerritory && state.territory < requirement.minTerritory) return false;
    if (requirement.minLifetimeFood && state.lifetimeFood < requirement.minLifetimeFood) return false;
    return true;
  }

  getUpgradeRequirementText(key, state = this.colony) {
    const requirement = UPGRADE_DEFS[key]?.requirement ?? {};
    const missing = [];
    if (requirement.minAnts && Math.floor(state.antPopulation) < requirement.minAnts) missing.push(`蟻 ${Math.floor(state.antPopulation)}/${requirement.minAnts}`);
    if (requirement.minNestLevel && state.nestLevel < requirement.minNestLevel) missing.push(`巣Lv ${state.nestLevel}/${requirement.minNestLevel}`);
    if (requirement.minTerritory && state.territory < requirement.minTerritory) missing.push(`領土 ${state.territory}/${requirement.minTerritory}`);
    if (requirement.minLifetimeFood && state.lifetimeFood < requirement.minLifetimeFood) missing.push(`累計食料 ${formatNumber(state.lifetimeFood)}/${formatNumber(requirement.minLifetimeFood)}`);
    return missing.join(" / ");
  }

  buyUpgrade(key) {
    if (!UPGRADE_DEFS[key]) return false;
    if (!this.isUpgradeUnlocked(key)) {
      this.showBattleToast(`条件未達: ${this.getUpgradeRequirementText(key)}`, "error");
      return false;
    }
    const cost = this.getUpgradeCost(key);
    if (!this.spendColonyFood(cost)) {
      this.showBattleToast("食料が足りません", "error");
      return false;
    }
    this.colony.upgrades[key] += 1;
    this.saveColonyState();
    this.updateColonyUi();
    this.showBattleToast(`${UPGRADE_DEFS[key].label} Lv${this.colony.upgrades[key]}`);
    return true;
  }

  getNestExpansionCost() {
    return Math.floor(70 * 1.62 ** (this.colony.nestLevel - 1));
  }

  expandNest() {
    const cost = this.getNestExpansionCost();
    if (!this.spendColonyFood(cost)) {
      this.showBattleToast("巣の拡張に必要な食料が足りません", "error");
      return false;
    }
    this.colony.nestLevel += 1;
    this.nest.radius = 12 + this.colony.nestLevel * 0.8;
    this.saveColonyState();
    this.updateColonyUi();
    this.showBattleToast(`巣Lv ${this.colony.nestLevel}`);
    return true;
  }

  getEnemy(enemyId) {
    return ENEMY_COLONIES.find((enemy) => enemy.id === enemyId) ?? ENEMY_COLONIES[0];
  }

  getTactic(tacticId) {
    return BATTLE_TACTICS[tacticId] ?? BATTLE_TACTICS.standard;
  }

  getBattleEstimate(enemyId, soldierCount, tacticId) {
    const enemy = this.getEnemy(enemyId);
    const tactic = this.getTactic(tacticId);
    const assigned = Math.max(0, Math.floor(Number(soldierCount) || 0));
    const commandMultiplier = 1 + this.colony.upgrades.tacticalPheromone * 0.06;
    const defensePower = this.computeDefensePower();
    const lossMitigation = 1 / defensePower;
    const playerPower = assigned * this.computeAttackPower() * tactic.power * commandMultiplier;
    const enemyPower = enemy.power + enemy.defense * 0.35 + this.colony.enemyThreat * 1.2;
    const winChance = clamp(playerPower / ((playerPower + enemyPower) || 1), 0.08, 0.92);
    const pressure = enemyPower / ((playerPower + enemyPower) || 1);
    const rewardFood = Math.floor(enemy.rewardFood * tactic.reward * (1 + this.colony.territory * 0.02));
    const rewardTerritory = enemy.rewardTerritory;
    const woundsOnWin = Math.ceil(assigned * 0.04 * tactic.loss * (0.65 + pressure) * lossMitigation);
    const woundsOnLoss = Math.ceil(assigned * clamp(0.18 * tactic.loss + pressure * 0.25, 0.12, 0.55) * lossMitigation);
    const expectedWounds = Math.round(woundsOnWin * winChance + woundsOnLoss * (1 - winChance));
    const foodLoss = Math.min(this.colony.food, Math.floor(enemy.rewardFood * 0.35 * tactic.loss * lossMitigation));
    return { enemy, tactic, assigned, playerPower, enemyPower, defensePower, winChance, rewardFood, rewardTerritory, woundsOnWin, woundsOnLoss, expectedWounds, foodLoss };
  }

  runExpedition(enemyId, soldierCount, tacticId, options = {}) {
    const now = Date.now();
    const enemy = this.getEnemy(enemyId);
    if (!this.colony.unlockedEnemyColonies.includes(enemy.id)) return { ok: false, message: "未解放の敵です" };
    if (!options.ignoreCooldown && this.colony.battleCooldownUntil > now) return { ok: false, message: "遠征隊の再編成中です" };
    const assigned = Math.floor(Number(soldierCount) || 0);
    const available = this.getAvailableSoldiers();
    if (assigned < 1) return { ok: false, message: "出撃する兵隊が必要です" };
    if (assigned > available) return { ok: false, message: "出撃数が兵隊数を超えています" };

    const estimate = this.getBattleEstimate(enemy.id, assigned, tacticId);
    const roll = options.forcedRoll ?? Math.random();
    const enemyVariance = options.enemyVariance ?? rand(0.88, 1.14);
    const adjustedChance = clamp(estimate.playerPower / ((estimate.playerPower + estimate.enemyPower * enemyVariance) || 1), 0.08, 0.92);
    const won = roll < adjustedChance;
    this.colony.battleCooldownUntil = now + enemy.cooldown * 1000;

    if (won) {
      this.addColonyFood(estimate.rewardFood, { silent: true });
      this.colony.territory += estimate.rewardTerritory;
      this.colony.enemyThreat = Math.max(0, this.colony.enemyThreat - (2 + estimate.rewardTerritory));
      this.colony.woundedAnts = clamp(this.colony.woundedAnts + estimate.woundsOnWin, 0, this.colony.antPopulation);
      this.unlockNextEnemy(enemy.id);
      const message = `遠征成功 +${estimate.rewardFood} food / 領土 +${estimate.rewardTerritory}`;
      this.addBattleLog(message, "win");
      this.saveColonyState();
      this.updateColonyUi();
      return { ok: true, won: true, message, estimate };
    }

    this.colony.food = Math.max(0, this.colony.food - estimate.foodLoss);
    this.collectedFood = this.colony.food;
    this.colony.woundedAnts = clamp(this.colony.woundedAnts + estimate.woundsOnLoss, 0, this.colony.antPopulation);
    this.colony.enemyThreat = clamp(this.colony.enemyThreat + enemy.threatIncrease, 0, 100);
    const message = `敗北 ${estimate.woundsOnLoss}匹負傷 / -${estimate.foodLoss} food`;
    this.addBattleLog(message, "loss");
    this.saveColonyState();
    this.updateColonyUi();
    return { ok: true, won: false, message, estimate };
  }

  unlockNextEnemy(enemyId) {
    const index = ENEMY_COLONIES.findIndex((enemy) => enemy.id === enemyId);
    const next = ENEMY_COLONIES[index + 1];
    if (next && !this.colony.unlockedEnemyColonies.includes(next.id)) this.colony.unlockedEnemyColonies.push(next.id);
  }

  addBattleLog(message, type) {
    const time = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    this.colony.battleLog.unshift({ message, type, time });
    this.colony.battleLog = this.colony.battleLog.slice(0, 5);
  }

  setColonyTab(tab) {
    ui.colonyTabs.forEach((button) => button.classList.toggle("active", button.dataset.colonyTab === tab));
    ui.colonyPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `colonyTab-${tab}`));
  }

  updateEnemyOptions() {
    const unlocked = ENEMY_COLONIES.filter((enemy) => this.colony.unlockedEnemyColonies.includes(enemy.id));
    const ids = unlocked.map((enemy) => enemy.id).join(",");
    if (ui.expeditionEnemy.dataset.ids !== ids) {
      const current = ui.expeditionEnemy.value;
      ui.expeditionEnemy.innerHTML = unlocked.map((enemy) => `<option value="${enemy.id}">${enemy.name}</option>`).join("");
      ui.expeditionEnemy.dataset.ids = ids;
      ui.expeditionEnemy.value = unlocked.some((enemy) => enemy.id === current) ? current : unlocked[0]?.id;
    }
  }

  updateColonyUi() {
    this.updateEnemyOptions();
    const roles = this.getRoleCounts();
    ui.colonyFood.textContent = formatNumber(this.colony.food);
    ui.colonyAnts.textContent = `${Math.floor(this.colony.antPopulation)}/${this.getPopulationCap()}`;
    ui.colonyFoodRate.textContent = formatRate(this.computeFoodPerSecond());
    ui.colonyNestLevel.textContent = this.colony.nestLevel;
    ui.colonyTerritory.textContent = this.colony.territory;
    ui.colonyThreat.textContent = Math.floor(this.colony.enemyThreat);
    ui.colonySoldiers.textContent = `${this.getAvailableSoldiers()}/${this.getSoldierAnts()}`;
    ui.colonyWounded.textContent = Math.ceil(this.colony.woundedAnts);
    ui.colonyWorkers.textContent = roles.worker;
    ui.colonyGrowthRate.textContent = formatRate(this.computeGrowthRate() * 60);
    const nestCost = this.getNestExpansionCost();
    ui.nestExpand.disabled = this.colony.food < nestCost;
    ui.nestExpandCost.textContent = `cost ${formatNumber(nestCost)} / cap ${this.getPopulationCap()}`;
    for (const button of ui.upgradeButtons) {
      const key = button.dataset.upgrade;
      const level = this.colony.upgrades[key];
      const cost = this.getUpgradeCost(key);
      const unlocked = this.isUpgradeUnlocked(key);
      button.classList.toggle("locked", !unlocked);
      button.disabled = !unlocked || this.colony.food < cost;
      button.querySelector("span").textContent = unlocked
        ? `Lv${level} / cost ${formatNumber(cost)} / ${UPGRADE_DEFS[key].effect}`
        : `ロック: ${this.getUpgradeRequirementText(key)}`;
    }
    ui.battleLog.replaceChildren(...this.colony.battleLog.map((entry) => {
      const item = document.createElement("li");
      item.className = entry.type;
      item.textContent = `${entry.time} ${entry.message}`;
      return item;
    }));
    this.updateExpeditionUi(roles);
  }

  updateExpeditionUi() {
    const available = this.getAvailableSoldiers();
    ui.expeditionSoldiers.min = available > 0 ? "1" : "0";
    ui.expeditionSoldiers.max = `${Math.max(available, 0)}`;
    ui.expeditionSoldiers.value = `${clamp(Number(ui.expeditionSoldiers.value) || 0, available > 0 ? 1 : 0, Math.max(available, 0))}`;
    ui.expeditionSoldiersValue.textContent = ui.expeditionSoldiers.value;

    const estimate = this.getBattleEstimate(ui.expeditionEnemy.value, Number(ui.expeditionSoldiers.value), ui.expeditionTactic.value);
    const cooldown = Math.max(0, (this.colony.battleCooldownUntil - Date.now()) / 1000);
    ui.battleWinChance.textContent = `${Math.round(estimate.winChance * 100)}%`;
    ui.battlePower.textContent = Math.round(estimate.playerPower);
    ui.battleEnemyPower.textContent = Math.round(estimate.enemyPower);
    ui.battleReward.textContent = `${formatNumber(estimate.rewardFood)} / +${estimate.rewardTerritory}`;
    ui.battleLoss.textContent = `${estimate.expectedWounds}匹`;
    ui.battleCooldown.textContent = cooldown > 0 ? formatDuration(cooldown) : "ready";
    ui.expeditionStart.disabled = available < 1 || cooldown > 0;
  }

  showBattleToast(message, type = "ok") {
    ui.battleToast.textContent = message;
    ui.battleToast.dataset.type = type;
    ui.battleToast.hidden = false;
    this.toastTimer = 2.8;
  }

  updateBattleToast(dt) {
    if (this.toastTimer <= 0) return;
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) ui.battleToast.hidden = true;
  }

  renderGame(alpha) {
    this.updateCamera();
    this.antRenderer.render(this.ants, this, alpha);
    this.renderer.render(this.scene, this.camera);
    window.__ANT_SIM_READY = true;
  }

  dispose() {
    if (!this.renderer) return;
    this.isRunning = false;
    this.renderer.setAnimationLoop(null);
    this.input?.dispose();
    window.removeEventListener("resize", this.boundResize);
    window.removeEventListener("pagehide", this.boundPageHide);
    this.saveColonyState();
    this.clearBranchPreview();
    this.antRenderer?.destroy();
    for (const list of [this.water, this.stones, this.food, this.branches, this.trails]) {
      for (const item of list) this.disposeDynamicItem(item);
    }
    this.assetService.dispose();
    for (const geometry of this.sharedGeometries) geometry.dispose();
    for (const material of this.sharedMaterials) disposeMaterial(material);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.renderer = null;
    if (window.__ANT_SIM === this) window.__ANT_SIM = null;
  }

  onPointerDown(event) {
    event.preventDefault();
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.dragMoved = false;
    if (this.pointerMap.size === 2) {
      const points = [...this.pointerMap.values()];
      this.pinchStart = {
        distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
        cameraDistance: this.targetCameraDistance,
      };
      return;
    }

    const point = this.screenToGround(event.clientX, event.clientY);
    if (!point) return;
    this.pointerStart = { screenX: event.clientX, screenY: event.clientY, ...point };
    if (this.tool === "water") this.addWater(point.x, point.z, 1);
    else if (this.tool === "stone") this.addStone(point.x, point.z);
    else if (this.tool === "food") this.addFood(point.x, point.z);
    else if (this.tool === "branch") this.branchDraft = { x1: point.x, z1: point.z, x2: point.x, z2: point.z };
    else if (this.tool === "erase") this.eraseAt(point.x, point.z);
  }

  onPointerMove(event) {
    const previous = this.pointerMap.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    this.pointerMap.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointerMap.size === 2 && this.pinchStart) {
      const points = [...this.pointerMap.values()];
      const current = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      this.targetCameraDistance = clamp(this.pinchStart.cameraDistance * (this.pinchStart.distance / (current || 1)), 96, 230);
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;

    if (this.tool === "inspect") {
      this.targetCameraYaw -= dx * 0.006;
      this.targetCameraPitch = clamp(this.targetCameraPitch + dy * 0.004, 0.62, 1.28);
      return;
    }

    const point = this.screenToGround(event.clientX, event.clientY);
    if (!point) return;
    if (this.tool === "water") {
      const last = this.pointerStart;
      if (!last || distance2(point.x, point.z, last.x, last.z) > 4.2) {
        this.addWater(point.x, point.z, 0.72);
        this.pointerStart = { screenX: event.clientX, screenY: event.clientY, ...point };
      }
    } else if (this.tool === "branch" && this.branchDraft) {
      this.branchDraft.x2 = point.x;
      this.branchDraft.z2 = point.z;
      this.updateBranchPreview();
    } else if (this.tool === "erase") {
      this.eraseAt(point.x, point.z);
    }
  }

  onPointerUp(event) {
    event.preventDefault();
    const point = this.screenToGround(event.clientX, event.clientY);
    if (this.tool === "inspect" && point && !this.dragMoved) this.selectNearestAnt(point.x, point.z);
    if (this.tool === "branch" && this.branchDraft && point) {
      this.branchDraft.x2 = point.x;
      this.branchDraft.z2 = point.z;
      if (distance2(this.branchDraft.x1, this.branchDraft.z1, this.branchDraft.x2, this.branchDraft.z2) > 7) {
        this.addBranch(this.branchDraft);
      }
      this.clearBranchPreview();
      this.branchDraft = null;
    }
    this.pointerMap.delete(event.pointerId);
    if (this.pointerMap.size < 2) this.pinchStart = null;
  }

  screenToGround(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.groundHit);
    if (!hit) return null;
    const d = Math.hypot(hit.x, hit.z);
    if (d > this.worldRadius + 7) return null;
    return { x: hit.x, z: hit.z };
  }

  addWater(x, z, scale = 1) {
    const intensity = Number(ui.intensity.value);
    const radius = 5.5 + intensity * 1.6 * scale + rand(-0.4, 0.8);
    const group = new THREE.Group();
    const pool = new THREE.Mesh(this.geometries.waterCircle, this.materials.water.clone());
    pool.rotation.x = -Math.PI / 2;
    pool.scale.set(radius * 1.18, radius * 0.82, 1);
    pool.position.y = 0.035;
    group.add(pool);
    const ring = new THREE.Mesh(this.geometries.impactRing, this.materials.waterRing.clone());
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(radius * 0.85, radius * 0.85, radius * 0.85);
    ring.position.y = 0.08;
    group.add(ring);
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.water.push({ x, z, radius, power: clamp(0.45 + intensity * 0.13 * scale, 0.35, 1.08), age: 0, group, ring });
  }

  addStone(x, z) {
    const intensity = Number(ui.intensity.value);
    const radius = 3.1 + intensity * 0.85 + rand(-0.2, 0.4);
    const group = new THREE.Group();
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 0), this.materials.stone);
    stone.position.y = radius * 0.46;
    stone.scale.y = 0.58;
    stone.rotation.set(rand(-0.4, 0.4), rand(0, Math.PI), rand(-0.3, 0.3));
    stone.castShadow = this.quality.shadowQuality !== "off";
    stone.receiveShadow = this.quality.shadowQuality !== "off";
    group.add(stone);
    const ring = new THREE.Mesh(this.geometries.impactRing, this.materials.impact.clone());
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(radius * 1.1, radius * 1.1, radius * 1.1);
    ring.position.y = 0.12;
    group.add(ring);
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.dynamicObjects.add(group);

    const item = { x, z, radius, shock: 1, group, ring };
    this.stones.push(item);
    for (const ant of this.ants) {
      const d = distance2(ant.x, ant.z, x, z);
      if (d < radius + 28) ant.shock((1 - d / (radius + 28)) * (0.78 + intensity * 0.13));
    }
  }

  addFood(x, z) {
    const intensity = Number(ui.intensity.value);
    const amount = 7 + intensity * 4;
    const group = new THREE.Group();
    const item = { id: this.nextFoodId, x, z, radius: 4.5 + intensity * 0.7, amount, initialAmount: amount, group, crumbs: [] };
    this.nextFoodId += 1;
    for (let i = 0; i < 18; i += 1) {
      const crumb = new THREE.Mesh(this.geometries.foodCrumb, this.materials.food);
      const a = rand(0, Math.PI * 2);
      const r = rand(0, item.radius);
      crumb.position.set(Math.cos(a) * r, 0.52 + rand(0, 0.45), Math.sin(a) * r);
      crumb.scale.setScalar(rand(0.26, 0.58));
      crumb.castShadow = this.quality.shadowQuality !== "off";
      group.add(crumb);
      item.crumbs.push(crumb);
    }
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.food.push(item);
  }

  getFoodSource(sourceId) {
    if (sourceId == null) return null;
    return this.food.find((item) => item.id === sourceId && item.amount > 0.05) ?? null;
  }

  refreshFoodMesh(food) {
    const ratio = clamp(food.amount / food.initialAmount, 0, 1);
    food.crumbs.forEach((crumb, index) => {
      crumb.visible = index / food.crumbs.length < ratio;
    });
    if (food.amount <= 0.05) {
      this.fadeFoodTrails(food.id);
      this.disposeDynamicItem(food);
      this.food = this.food.filter((item) => item !== food);
    }
  }

  fadeFoodTrails(sourceId) {
    for (const trail of this.trails) {
      if (trail.kind !== "food" || trail.sourceId !== sourceId) continue;
      trail.followStrength = 0;
      trail.life = Math.min(trail.life, 0.18);
      trail.decay = PHEROMONE_PARAMS.foodDepletedDecay;
    }
  }

  addBranch(branch) {
    const dx = branch.x2 - branch.x1;
    const dz = branch.z2 - branch.z1;
    const length = Math.hypot(dx, dz);
    const width = 1.35 + Number(ui.intensity.value) * 0.18;
    const geometry = new THREE.CylinderGeometry(width, width * 0.75, length, 10);
    const mesh = new THREE.Mesh(geometry, this.materials.branch);
    mesh.position.set((branch.x1 + branch.x2) / 2, width * 0.95, (branch.z1 + branch.z2) / 2);
    const direction = new THREE.Vector3(dx, 0, dz).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    mesh.castShadow = this.quality.shadowQuality !== "off";
    mesh.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(mesh);
    this.dynamicObjects.add(mesh);
    this.branches.push({ ...branch, width: width * 1.45, group: mesh });
  }

  updateBranchPreview() {
    this.clearBranchPreview();
    if (!this.branchDraft) return;
    const dx = this.branchDraft.x2 - this.branchDraft.x1;
    const dz = this.branchDraft.z2 - this.branchDraft.z1;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) return;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.6, length, 8),
      new THREE.MeshBasicMaterial({ color: 0x51b7a6, transparent: true, opacity: 0.58 }),
    );
    mesh.position.set((this.branchDraft.x1 + this.branchDraft.x2) / 2, 0.7, (this.branchDraft.z1 + this.branchDraft.z2) / 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dz).normalize());
    this.branchPreview = mesh;
    this.scene.add(mesh);
  }

  clearBranchPreview() {
    if (this.branchPreview) {
      disposeObject3D(this.branchPreview);
      this.branchPreview = null;
    }
  }

  eraseAt(x, z) {
    const radius = 7;
    const removeFrom = (list, predicate, onRemove = () => {}) => {
      for (const item of [...list]) {
        if (predicate(item)) {
          onRemove(item);
          this.disposeDynamicItem(item);
          const index = list.indexOf(item);
          if (index >= 0) list.splice(index, 1);
        }
      }
    };
    removeFrom(this.water, (item) => distance2(item.x, item.z, x, z) < radius + item.radius * 0.45);
    removeFrom(this.stones, (item) => distance2(item.x, item.z, x, z) < radius + item.radius * 0.45);
    removeFrom(
      this.food,
      (item) => distance2(item.x, item.z, x, z) < radius + item.radius * 0.45,
      (item) => this.fadeFoodTrails(item.id),
    );
    removeFrom(this.branches, (item) => {
      const p = closestPointOnSegment(x, z, item.x1, item.z1, item.x2, item.z2);
      return distance2(x, z, p.x, p.z) < radius + item.width;
    });
  }

  addTrail(x, z, kind, strength, options = {}) {
    const material =
      kind === "food"
        ? this.materials.trailFood.clone()
        : kind === "alarm"
          ? this.materials.trailAlarm.clone()
          : kind === "rescue"
            ? this.materials.trailRescue.clone()
            : this.materials.trailWater.clone();
    const mesh = new THREE.Mesh(this.geometries.trailCircle, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.045, z);
    const scale = kind === "alarm" ? 1.3 : 0.85;
    mesh.scale.setScalar(scale);
    this.scene.add(mesh);
    this.dynamicObjects.add(mesh);
    this.trails.push({
      x,
      z,
      kind,
      life: strength,
      decay:
        kind === "food"
          ? PHEROMONE_PARAMS.foodActiveDecay
          : kind === "alarm"
            ? PHEROMONE_PARAMS.alarmDecay
            : kind === "rescue"
              ? PHEROMONE_PARAMS.rescueDecay
              : PHEROMONE_PARAMS.waterDecay,
      sourceId: options.sourceId ?? null,
      sourceRatio: options.sourceRatio ?? 1,
      followStrength: kind === "food" ? clamp(options.sourceRatio ?? 1, 0, 1) : 1,
      mesh,
      scale,
      baseOpacity: material.opacity,
    });
    if (this.trails.length > 520) {
      const old = this.trails.shift();
      this.disposeDynamicItem(old);
    }
  }

  findRescueCandidate(helper) {
    let best = null;
    let bestDistance = Infinity;
    for (const ant of this.ants) {
      if (ant === helper || ant.stun <= 0) continue;
      const d = distance2(helper.x, helper.z, ant.x, ant.z);
      if (d < bestDistance && d < 22) {
        best = ant;
        bestDistance = d;
      }
    }
    return best;
  }

  selectNearestAnt(x, z) {
    let best = null;
    let bestDistance = 5;
    for (const ant of this.ants) {
      const d = distance2(x, z, ant.x, ant.z);
      if (d < bestDistance) {
        best = ant;
        bestDistance = d;
      }
    }
    this.selectedAnt = best;
    this.updateInspector();
  }

  updateStats() {
    let explore = 0;
    let alert = 0;
    let rescue = 0;
    for (const ant of this.ants) {
      if (ant.state === "panic" || ant.state === "wet" || ant.state === "stunned") alert += 1;
      else if (ant.state === "rescue") rescue += 1;
      else explore += 1;
    }
    ui.statExplore.textContent = explore;
    ui.statAlert.textContent = alert;
    ui.statRescue.textContent = rescue;
    ui.statFood.textContent = Math.floor(this.collectedFood);
  }

  updateInspector() {
    const ant = this.selectedAnt;
    if (!ant) {
      ui.inspector.innerHTML = '<span class="muted">個体未選択</span>';
      return;
    }
    ui.inspector.innerHTML = `
      <strong>個体 ${ant.id} / ${ROLE_LABELS[ant.role]} / ${STATE_LABELS[ant.state]}</strong>
      <div class="trait-grid">
        <span>好奇心 ${Math.round(ant.traits.curiosity * 100)}</span>
        <span>警戒心 ${Math.round(ant.traits.caution * 100)}</span>
        <span>協調性 ${Math.round(ant.traits.social * 100)}</span>
        <span>粘り ${Math.round(ant.traits.persistence * 100)}</span>
      </div>
    `;
  }
}

new AntColony3D();
