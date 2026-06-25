import * as THREE from "three";

const ui = {
  world: document.querySelector("#world3d"),
  buttons: [...document.querySelectorAll(".tool-button")],
  activeToolLabel: document.querySelector("#activeToolLabel"),
  appShell: document.querySelector(".app-shell"),
  uiToggle: document.querySelector("#uiToggleBtn"),
  pause: document.querySelector("#pauseBtn"),
  reset: document.querySelector("#resetBtn"),
  pheromone: document.querySelector("#pheromoneBtn"),
  antCount: document.querySelector("#antCount"),
  antCountValue: document.querySelector("#antCountValue"),
  intensity: document.querySelector("#intensity"),
  intensityValue: document.querySelector("#intensityValue"),
  foodTypeSelect: document.querySelector("#foodTypeSelect"),
  foodTypeHint: document.querySelector("#foodTypeHint"),
  naturalFoodToggle: document.querySelector("#naturalFoodToggle"),
  naturalFoodRate: document.querySelector("#naturalFoodRate"),
  terrainEffectsToggle: document.querySelector("#terrainEffectsToggle"),
  terrainComplexity: document.querySelector("#terrainComplexity"),
  terrainRegenerate: document.querySelector("#terrainRegenerateBtn"),
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
};

const FIXED_DT = 1 / 60;
const MAX_FRAME_DELTA = 0.25;
const MAX_FIXED_STEPS = 5;
const DEBUG_QUERY = new URLSearchParams(window.location.search);
const IS_DEBUG = DEBUG_QUERY.get("debug") === "1";

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
  harvest: "採取",
  return: "帰巣",
  searchNest: "巣探し",
  insideNest: "巣内",
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

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeSeededRandom(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

const HOMING_PARAMS = {
  pathAngularNoise: 0.018,
  pathDistanceNoise: 0.035,
  pathErrorGain: 0.0025,
  pathErrorMax: 24,
  pathResetRadiusMultiplier: 0.8,
  returnGain: 1.05,
  returnSearchDistance: 2.5,
  nestOdorRadiusMultiplier: 2.8,
  nestSearchOdorRadiusMultiplier: 3.2,
  nestArriveRadiusMultiplier: 0.75,
  searchFallbackDelay: 8,
  searchGiveUpDelay: 18,
  exploreReturnBaseDelay: 34,
  exploreReturnPersistenceDelay: 22,
  exploreReturnCuriosityDelay: 10,
};

const NEST_TRAFFIC_PARAMS = {
  dwellSeconds: 10,
  holeRadiusScale: 0.16,
  entryRadiusScale: 0.26,
  queueRadiusScale: 0.68,
  exitRadiusScale: 0.31,
  entryRate: 2.15,
  exitRate: 1.45,
  maxEntryTokens: 1,
  maxExitTokens: 1,
};

const ANT_FORMATION_PARAMS = {
  hardRadius: 0.78,
  personalRadius: 1.82,
  sameDirectionRadius: 6.2,
  laneWidth: 0.72,
  sideBySideForwardRange: 2.65,
  followGap: 3.65,
  laneMergeGain: 0.2,
  queueOrderGain: 0.48,
};

const PROP_CONTACT_PARAMS = {
  branchClimbRadiusMax: 1.05,
  branchApproachLookAhead: 4.8,
  surfaceHeightLerp: 0.18,
  surfaceTiltLerp: 0.2,
  maxPitch: 0.28,
  maxRoll: 0.22,
};

const TERRAIN_TYPES = {
  soil: {
    id: "soil",
    label: "土",
    index: 0,
    color: 0x765934,
    movement: 1,
    detection: 1,
    roughness: 0.22,
    pheromoneDecay: 1,
    pheromoneDiffusion: 1,
    blocked: false,
    foodAffinity: { sugar: 1, fruit: 1, starch: 1, fat: 1, seed: 1.15, protein: 0.95, mixed: 1 },
  },
  grass: {
    id: "grass",
    label: "芝",
    index: 1,
    color: 0x4f753f,
    movement: 0.78,
    detection: 0.9,
    roughness: 0.48,
    pheromoneDecay: 0.88,
    pheromoneDiffusion: 1.08,
    blocked: false,
    foodAffinity: { sugar: 1.08, fruit: 1.05, starch: 0.8, fat: 0.8, seed: 0.95, protein: 1.2, mixed: 0.85 },
  },
  path: {
    id: "path",
    label: "踏み跡",
    index: 2,
    color: 0x927447,
    movement: 1.18,
    detection: 1.05,
    roughness: 0.12,
    pheromoneDecay: 0.72,
    pheromoneDiffusion: 0.92,
    blocked: false,
    foodAffinity: { sugar: 1.3, fruit: 1.35, starch: 1.38, fat: 1.18, seed: 1.15, protein: 0.85, mixed: 1.25 },
  },
  gravel: {
    id: "gravel",
    label: "砂利",
    index: 3,
    color: 0x77786e,
    movement: 0.7,
    detection: 0.88,
    roughness: 0.62,
    pheromoneDecay: 1.35,
    pheromoneDiffusion: 0.72,
    blocked: false,
    foodAffinity: { sugar: 0.75, fruit: 0.76, starch: 0.86, fat: 0.8, seed: 0.72, protein: 0.7, mixed: 0.78 },
  },
  sand: {
    id: "sand",
    label: "砂地",
    index: 4,
    color: 0xa99158,
    movement: 0.9,
    detection: 0.95,
    roughness: 0.38,
    pheromoneDecay: 1.42,
    pheromoneDiffusion: 0.82,
    blocked: false,
    foodAffinity: { sugar: 0.86, fruit: 0.88, starch: 0.9, fat: 0.82, seed: 0.9, protein: 0.72, mixed: 0.85 },
  },
  leafLitter: {
    id: "leafLitter",
    label: "落ち葉",
    index: 5,
    color: 0x704421,
    movement: 0.76,
    detection: 0.82,
    roughness: 0.72,
    pheromoneDecay: 0.95,
    pheromoneDiffusion: 1.02,
    blocked: false,
    foodAffinity: { sugar: 0.82, fruit: 0.95, starch: 0.82, fat: 0.9, seed: 1.05, protein: 1.45, mixed: 1.05 },
  },
  root: {
    id: "root",
    label: "木の根",
    index: 6,
    color: 0x4c2e18,
    movement: 0.48,
    detection: 0.86,
    roughness: 0.86,
    pheromoneDecay: 0.96,
    pheromoneDiffusion: 0.88,
    blocked: true,
    foodAffinity: { sugar: 0.7, fruit: 0.75, starch: 0.7, fat: 0.82, seed: 0.86, protein: 1.05, mixed: 0.8 },
  },
  mud: {
    id: "mud",
    label: "泥",
    index: 7,
    color: 0x4e422e,
    movement: 0.55,
    detection: 0.86,
    roughness: 0.58,
    pheromoneDecay: 0.78,
    pheromoneDiffusion: 1.22,
    blocked: false,
    foodAffinity: { sugar: 0.72, fruit: 0.82, starch: 0.65, fat: 0.66, seed: 0.75, protein: 1.08, mixed: 0.7 },
  },
  puddle: {
    id: "puddle",
    label: "水たまり",
    index: 8,
    color: 0x4f9eb2,
    movement: 0.35,
    detection: 0.76,
    roughness: 0.2,
    pheromoneDecay: 1.55,
    pheromoneDiffusion: 1.35,
    blocked: true,
    foodAffinity: { sugar: 0.35, fruit: 0.42, starch: 0.35, fat: 0.35, seed: 0.35, protein: 0.45, mixed: 0.35 },
  },
  pavement: {
    id: "pavement",
    label: "舗装片",
    index: 9,
    color: 0x7c817b,
    movement: 1.24,
    detection: 1.02,
    roughness: 0.18,
    pheromoneDecay: 1.22,
    pheromoneDiffusion: 0.7,
    blocked: false,
    foodAffinity: { sugar: 1.2, fruit: 1.34, starch: 1.35, fat: 1.18, seed: 0.92, protein: 0.68, mixed: 1.3 },
  },
};

const TERRAIN_TYPE_ORDER = ["soil", "grass", "path", "gravel", "sand", "leafLitter", "root", "mud", "puddle", "pavement"];
const TERRAIN_BY_INDEX = TERRAIN_TYPE_ORDER.map((id) => TERRAIN_TYPES[id]);
const TERRAIN_COMPLEXITY_LEVELS = ["low", "medium", "high"];
const TERRAIN_TEXTURE_MANIFEST = {
  parkGroundAtlas: "assets/textures/terrain/park_ground_atlas.png",
  grassPatch: "assets/textures/terrain/grass_patch.png",
  leafLitter: "assets/textures/terrain/leaf_litter.png",
  gravelPatch: "assets/textures/terrain/gravel_patch.png",
  rootBark: "assets/textures/terrain/root_bark.png",
  mudPatch: "assets/textures/terrain/mud_patch.png",
  pavementCrack: "assets/textures/terrain/pavement_crack.png",
};

const FOOD_TYPES = {
  sugar: {
    id: "sugar",
    label: "糖液",
    shortLabel: "糖",
    hint: "糖液: 発見しやすく軽い / 短時間で採取",
    category: "sugar",
    spawnWeight: 0.55,
    color: 0xe7c95a,
    amountBase: 8,
    amountPerIntensity: 4,
    radiusBase: 4.2,
    radiusPerIntensity: 0.55,
    detectRadius: 72,
    directAttraction: 1.25,
    pheromoneStrength: 1.25,
    trunkStrength: 0.04,
    harvestTime: 0.12,
    loadSize: 0.42,
    carrySpeedMultiplier: 0.92,
    energyValue: 1.2,
    storageValue: 0.65,
    broodValue: 0.25,
    materialValue: 0,
    decaySeconds: 92,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "honey",
    modelStyle: "liquid",
    roleAffinity: { scout: 1.25, worker: 1.05, nurse: 0.65, guard: 0.55 },
  },
  honeyDrop: {
    id: "honeyDrop",
    label: "蜜滴",
    shortLabel: "蜜",
    hint: "蜜滴: 強く誘引 / 軽い / 腐りやすい",
    category: "sugar",
    spawnWeight: 1.7,
    color: 0xf0b83d,
    amountBase: 7,
    amountPerIntensity: 3.2,
    radiusBase: 3.8,
    radiusPerIntensity: 0.45,
    detectRadius: 78,
    directAttraction: 1.48,
    pheromoneStrength: 1.55,
    trunkStrength: 0.035,
    harvestTime: 0.1,
    loadSize: 0.36,
    carrySpeedMultiplier: 0.95,
    energyValue: 1.35,
    storageValue: 0.58,
    broodValue: 0.2,
    materialValue: 0,
    decaySeconds: 62,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "honey",
    modelStyle: "liquid",
    roleAffinity: { scout: 1.38, worker: 1.08, nurse: 0.62, guard: 0.48 },
  },
  apple: {
    id: "apple",
    label: "りんご片",
    shortLabel: "林",
    hint: "りんご片: 果実系 / 発見しやすい / 複数で削る",
    category: "fruit",
    spawnWeight: 1.25,
    color: 0xd94c42,
    amountBase: 13,
    amountPerIntensity: 5.5,
    radiusBase: 6.2,
    radiusPerIntensity: 0.78,
    detectRadius: 74,
    directAttraction: 1.22,
    pheromoneStrength: 1.42,
    trunkStrength: 0.085,
    harvestTime: 1.35,
    loadSize: 0.52,
    carrySpeedMultiplier: 0.72,
    energyValue: 1.12,
    storageValue: 0.88,
    broodValue: 0.36,
    materialValue: 0,
    decaySeconds: 150,
    requiredHelpers: 2,
    cooperative: true,
    textureKey: "apple",
    modelStyle: "fruitChunk",
    roleAffinity: { scout: 1.22, worker: 1.18, nurse: 0.82, guard: 0.78 },
  },
  banana: {
    id: "banana",
    label: "バナナ片",
    shortLabel: "香",
    hint: "バナナ片: 高糖質 / 非常に誘引 / 柔らかい",
    category: "fruit",
    spawnWeight: 1.45,
    color: 0xf0d35a,
    amountBase: 10,
    amountPerIntensity: 4.8,
    radiusBase: 5.4,
    radiusPerIntensity: 0.7,
    detectRadius: 82,
    directAttraction: 1.55,
    pheromoneStrength: 1.62,
    trunkStrength: 0.055,
    harvestTime: 0.42,
    loadSize: 0.46,
    carrySpeedMultiplier: 0.84,
    energyValue: 1.32,
    storageValue: 0.72,
    broodValue: 0.28,
    materialValue: 0,
    decaySeconds: 82,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "banana",
    modelStyle: "softFruit",
    roleAffinity: { scout: 1.35, worker: 1.12, nurse: 0.72, guard: 0.58 },
  },
  strawberry: {
    id: "strawberry",
    label: "いちご片",
    shortLabel: "苺",
    hint: "いちご片: 糖質と水分 / 目立つ中型果実",
    category: "fruit",
    spawnWeight: 1.05,
    color: 0xd83b4f,
    amountBase: 9,
    amountPerIntensity: 4,
    radiusBase: 5.0,
    radiusPerIntensity: 0.62,
    detectRadius: 70,
    directAttraction: 1.32,
    pheromoneStrength: 1.35,
    trunkStrength: 0.052,
    harvestTime: 0.58,
    loadSize: 0.42,
    carrySpeedMultiplier: 0.82,
    energyValue: 1.18,
    storageValue: 0.7,
    broodValue: 0.34,
    materialValue: 0,
    decaySeconds: 104,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "strawberry",
    modelStyle: "softFruit",
    roleAffinity: { scout: 1.28, worker: 1.04, nurse: 0.82, guard: 0.55 },
  },
  breadCrumb: {
    id: "breadCrumb",
    label: "パン屑",
    shortLabel: "パ",
    hint: "パン屑: 出現頻度高め / 中立的な餌",
    category: "starch",
    spawnWeight: 2.35,
    color: 0xd8bd83,
    amountBase: 7,
    amountPerIntensity: 3.3,
    radiusBase: 4.3,
    radiusPerIntensity: 0.55,
    detectRadius: 44,
    directAttraction: 0.82,
    pheromoneStrength: 0.78,
    trunkStrength: 0.058,
    harvestTime: 0.34,
    loadSize: 0.48,
    carrySpeedMultiplier: 0.8,
    energyValue: 0.82,
    storageValue: 0.88,
    broodValue: 0.24,
    materialValue: 0,
    decaySeconds: 178,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "bread",
    modelStyle: "crumb",
    roleAffinity: { scout: 0.82, worker: 1.08, nurse: 0.7, guard: 0.62 },
  },
  cookieCrumb: {
    id: "cookieCrumb",
    label: "クッキー片",
    shortLabel: "ク",
    hint: "クッキー片: 糖質+脂質 / 貯蔵価値高め",
    category: "fat",
    spawnWeight: 1.35,
    color: 0xb98345,
    amountBase: 8,
    amountPerIntensity: 3.8,
    radiusBase: 4.8,
    radiusPerIntensity: 0.6,
    detectRadius: 54,
    directAttraction: 1.02,
    pheromoneStrength: 1.0,
    trunkStrength: 0.085,
    harvestTime: 0.58,
    loadSize: 0.54,
    carrySpeedMultiplier: 0.76,
    energyValue: 1.05,
    storageValue: 1.18,
    broodValue: 0.28,
    materialValue: 0,
    decaySeconds: 220,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "cookie",
    modelStyle: "shard",
    roleAffinity: { scout: 0.9, worker: 1.22, nurse: 0.62, guard: 0.76 },
  },
  cheeseBit: {
    id: "cheeseBit",
    label: "チーズ片",
    shortLabel: "チ",
    hint: "チーズ片: 脂質+タンパク / workerとguard向き",
    category: "fat",
    spawnWeight: 0.9,
    color: 0xe5c64e,
    amountBase: 9,
    amountPerIntensity: 3.8,
    radiusBase: 4.6,
    radiusPerIntensity: 0.62,
    detectRadius: 52,
    directAttraction: 0.98,
    pheromoneStrength: 0.95,
    trunkStrength: 0.075,
    harvestTime: 0.7,
    loadSize: 0.5,
    carrySpeedMultiplier: 0.72,
    energyValue: 0.98,
    storageValue: 0.95,
    broodValue: 1.12,
    materialValue: 0,
    decaySeconds: 126,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "cheese",
    modelStyle: "shard",
    roleAffinity: { scout: 0.72, worker: 1.18, nurse: 0.95, guard: 1.24 },
  },
  nutPiece: {
    id: "nutPiece",
    label: "ナッツ片",
    shortLabel: "ナ",
    hint: "ナッツ片: 脂質/種子系 / 重い / 貯蔵価値高い",
    category: "fat",
    spawnWeight: 1.05,
    color: 0x8b5b32,
    amountBase: 8,
    amountPerIntensity: 3.6,
    radiusBase: 4.9,
    radiusPerIntensity: 0.66,
    detectRadius: 46,
    directAttraction: 0.86,
    pheromoneStrength: 0.82,
    trunkStrength: 0.105,
    harvestTime: 0.86,
    loadSize: 0.62,
    carrySpeedMultiplier: 0.62,
    energyValue: 1.05,
    storageValue: 1.48,
    broodValue: 0.38,
    materialValue: 0.05,
    decaySeconds: 260,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "nut",
    modelStyle: "shard",
    roleAffinity: { scout: 0.62, worker: 1.35, nurse: 0.72, guard: 1.0 },
  },
  seed: {
    id: "seed",
    label: "種子",
    shortLabel: "種",
    hint: "種子: 貯蔵価値が高い",
    category: "seed",
    spawnWeight: 1.0,
    color: 0xb88445,
    amountBase: 7,
    amountPerIntensity: 3,
    radiusBase: 4.8,
    radiusPerIntensity: 0.65,
    detectRadius: 50,
    directAttraction: 0.9,
    pheromoneStrength: 0.85,
    trunkStrength: 0.08,
    harvestTime: 0.55,
    loadSize: 0.55,
    carrySpeedMultiplier: 0.72,
    energyValue: 0.8,
    storageValue: 1.25,
    broodValue: 0.45,
    materialValue: 0,
    decaySeconds: 300,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "seed",
    modelStyle: "seedPile",
    roleAffinity: { scout: 0.75, worker: 1.3, nurse: 0.75, guard: 0.85 },
  },
  seedPile: {
    id: "seedPile",
    label: "種子山",
    shortLabel: "山",
    hint: "種子山: worker適性高 / 幹道フェロモン強め",
    category: "seed",
    spawnWeight: 1.35,
    color: 0xad7b40,
    amountBase: 14,
    amountPerIntensity: 5.8,
    radiusBase: 6.0,
    radiusPerIntensity: 0.78,
    detectRadius: 52,
    directAttraction: 0.92,
    pheromoneStrength: 0.96,
    trunkStrength: 0.16,
    harvestTime: 0.82,
    loadSize: 0.58,
    carrySpeedMultiplier: 0.7,
    energyValue: 0.82,
    storageValue: 1.42,
    broodValue: 0.52,
    materialValue: 0.05,
    decaySeconds: 320,
    requiredHelpers: 2,
    cooperative: true,
    textureKey: "seed",
    modelStyle: "seedPile",
    roleAffinity: { scout: 0.7, worker: 1.42, nurse: 0.78, guard: 0.92 },
  },
  protein: {
    id: "protein",
    label: "タンパク",
    shortLabel: "蛋",
    hint: "タンパク: 育児価値が高い",
    category: "protein",
    spawnWeight: 0.6,
    color: 0xd08757,
    amountBase: 9,
    amountPerIntensity: 4,
    radiusBase: 4.8,
    radiusPerIntensity: 0.7,
    detectRadius: 58,
    directAttraction: 1.05,
    pheromoneStrength: 1.15,
    trunkStrength: 0.07,
    harvestTime: 0.75,
    loadSize: 0.5,
    carrySpeedMultiplier: 0.76,
    energyValue: 0.9,
    storageValue: 0.9,
    broodValue: 1.45,
    materialValue: 0,
    decaySeconds: 118,
    requiredHelpers: 1,
    cooperative: false,
    textureKey: "protein",
    modelStyle: "proteinChunk",
    roleAffinity: { scout: 0.75, worker: 1.05, nurse: 1.25, guard: 1.15 },
  },
  insectPiece: {
    id: "insectPiece",
    label: "昆虫片",
    shortLabel: "虫",
    hint: "昆虫片: 抽象タンパク / 育児価値が高い",
    category: "protein",
    spawnWeight: 0.95,
    color: 0x654533,
    amountBase: 11,
    amountPerIntensity: 4.8,
    radiusBase: 5.2,
    radiusPerIntensity: 0.72,
    detectRadius: 62,
    directAttraction: 1.12,
    pheromoneStrength: 1.22,
    trunkStrength: 0.095,
    harvestTime: 1.05,
    loadSize: 0.56,
    carrySpeedMultiplier: 0.68,
    energyValue: 0.98,
    storageValue: 0.88,
    broodValue: 1.72,
    materialValue: 0,
    decaySeconds: 112,
    requiredHelpers: 2,
    cooperative: true,
    textureKey: "insect",
    modelStyle: "proteinChunk",
    roleAffinity: { scout: 0.82, worker: 1.25, nurse: 1.38, guard: 1.3 },
  },
  largeFruit: {
    id: "largeFruit",
    label: "大型果実",
    shortLabel: "果",
    hint: "大型果実: 大量報酬 / 4匹以上で採取",
    category: "fruit",
    spawnWeight: 0.62,
    color: 0xc84b38,
    amountBase: 24,
    amountPerIntensity: 9,
    radiusBase: 8.4,
    radiusPerIntensity: 1.1,
    detectRadius: 84,
    directAttraction: 1.25,
    pheromoneStrength: 1.9,
    trunkStrength: 0.14,
    harvestTime: 3.6,
    loadSize: 0.78,
    carrySpeedMultiplier: 0.52,
    energyValue: 1.22,
    storageValue: 1.05,
    broodValue: 0.45,
    materialValue: 0.02,
    decaySeconds: 170,
    requiredHelpers: 5,
    cooperative: true,
    textureKey: "largeFruit",
    modelStyle: "largeFruit",
    roleAffinity: { scout: 1.18, worker: 1.34, nurse: 0.74, guard: 1.02 },
  },
  picnicScrap: {
    id: "picnicScrap",
    label: "食べ残し",
    shortLabel: "残",
    hint: "食べ残し: 高価値 / 腐敗でavoidが出やすい",
    category: "mixed",
    spawnWeight: 0.48,
    color: 0xb56a4c,
    amountBase: 18,
    amountPerIntensity: 7.4,
    radiusBase: 7.2,
    radiusPerIntensity: 0.96,
    detectRadius: 68,
    directAttraction: 1.05,
    pheromoneStrength: 1.12,
    trunkStrength: 0.12,
    harvestTime: 1.9,
    loadSize: 0.68,
    carrySpeedMultiplier: 0.6,
    energyValue: 1.18,
    storageValue: 1.22,
    broodValue: 0.98,
    materialValue: 0.08,
    decaySeconds: 90,
    requiredHelpers: 3,
    cooperative: true,
    textureKey: "picnic",
    modelStyle: "mixedScrap",
    roleAffinity: { scout: 0.9, worker: 1.22, nurse: 1.05, guard: 1.12 },
  },
  largePrey: {
    id: "largePrey",
    label: "大型餌",
    shortLabel: "大",
    hint: "大型餌: 複数匹で処理",
    category: "protein",
    spawnWeight: 0.42,
    color: 0x9a6a42,
    amountBase: 16,
    amountPerIntensity: 7,
    radiusBase: 6.8,
    radiusPerIntensity: 0.9,
    detectRadius: 64,
    directAttraction: 0.95,
    pheromoneStrength: 1.65,
    trunkStrength: 0.12,
    harvestTime: 2.4,
    loadSize: 0.75,
    carrySpeedMultiplier: 0.55,
    energyValue: 1.0,
    storageValue: 1.25,
    broodValue: 1.35,
    materialValue: 0,
    decaySeconds: 132,
    requiredHelpers: 3,
    cooperative: true,
    textureKey: "protein",
    modelStyle: "largeChunk",
    roleAffinity: { scout: 0.55, worker: 1.3, nurse: 0.65, guard: 1.2 },
  },
};

const FOOD_TYPE_ORDER = [
  "sugar",
  "honeyDrop",
  "apple",
  "banana",
  "strawberry",
  "breadCrumb",
  "cookieCrumb",
  "cheeseBit",
  "nutPiece",
  "seed",
  "seedPile",
  "protein",
  "insectPiece",
  "largeFruit",
  "picnicScrap",
  "largePrey",
];
const DEFAULT_FOOD_TYPE = FOOD_TYPES.sugar;

const FOOD_TEXTURE_MANIFEST = {
  honey: { asset: "assets/textures/food/honey.png", base: "#edae31", accent: "#fff0a5", dark: "#8f5a13" },
  apple: { asset: "assets/textures/food/apple.png", base: "#d84c42", accent: "#f5d8a7", dark: "#7f231e" },
  banana: { asset: "assets/textures/food/banana.png", base: "#efd45f", accent: "#fff2a9", dark: "#8f6a1f" },
  strawberry: { asset: "assets/textures/food/strawberry.png", base: "#d93d54", accent: "#ffe0b0", dark: "#6b1a28" },
  cookie: { asset: "assets/textures/food/cookie.png", base: "#b9854b", accent: "#f1d09b", dark: "#5b331c" },
  bread: { asset: "assets/textures/food/bread.png", base: "#d7b77a", accent: "#f5dfb3", dark: "#81572c" },
  cheese: { asset: "assets/textures/food/cheese.png", base: "#e6c64e", accent: "#fff1a0", dark: "#8e701b" },
  nut: { asset: "assets/textures/food/nut.png", base: "#8b5b32", accent: "#c99052", dark: "#3f2515" },
  seed: { asset: "assets/textures/food/seed.png", base: "#b88445", accent: "#e4bb78", dark: "#5b3418" },
  protein: { asset: "assets/textures/food/protein.png", base: "#9a6040", accent: "#d08757", dark: "#4a2a1e" },
  insect: { asset: "assets/textures/food/insect.png", base: "#604836", accent: "#a77955", dark: "#2f241c" },
  largeFruit: { asset: "assets/textures/food/large-fruit.png", base: "#c94a38", accent: "#f0b257", dark: "#6b1c1c" },
  picnic: { asset: "assets/textures/food/picnic-scrap.png", base: "#b56a4c", accent: "#f0d18f", dark: "#4a2b1e" },
};

const FOOD_TEXTURE_KEYS = [...new Set(FOOD_TYPE_ORDER.map((type) => FOOD_TYPES[type].textureKey))];

const FOOD_SPAWN_PRESETS = {
  low: { intervalMin: 20, intervalMax: 32, maxNatural: 4 },
  medium: { intervalMin: 12, intervalMax: 22, maxNatural: 7 },
  high: { intervalMin: 7, intervalMax: 14, maxNatural: 10 },
};

function getFoodType(type) {
  return FOOD_TYPES[type] ?? DEFAULT_FOOD_TYPE;
}

function createFoodTypeTotals() {
  const totals = {};
  for (const type of FOOD_TYPE_ORDER) totals[type] = 0;
  return totals;
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
  gradient.addColorStop(0, "#a98b58");
  gradient.addColorStop(0.52, "#94784d");
  gradient.addColorStop(1, "#7e6845");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 768, 768);

  for (let i = 0; i < 780; i += 1) {
    const x = Math.random() * 768;
    const y = Math.random() * 768;
    const r = Math.random() * 1.35 + 0.45;
    context.fillStyle = Math.random() > 0.5 ? "rgba(50,38,25,0.055)" : "rgba(236,212,164,0.045)";
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2.8, 2.8);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeWaterSurfaceTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 512, 512);
  const gradient = context.createRadialGradient(230, 220, 30, 256, 256, 250);
  gradient.addColorStop(0, "rgba(235,252,255,0.72)");
  gradient.addColorStop(0.42, "rgba(98,186,216,0.42)");
  gradient.addColorStop(0.78, "rgba(44,117,143,0.27)");
  gradient.addColorStop(1, "rgba(180,240,250,0.08)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);

  context.strokeStyle = "rgba(235,252,255,0.2)";
  context.lineWidth = 2;
  for (let i = 0; i < 15; i += 1) {
    const x = 256 + Math.cos(i * 1.7) * rand(14, 58);
    const y = 256 + Math.sin(i * 1.35) * rand(10, 52);
    context.beginPath();
    context.ellipse(x, y, rand(42, 138), rand(8, 24), rand(-0.7, 0.7), 0, Math.PI * 2);
    context.stroke();
  }

  for (let i = 0; i < 580; i += 1) {
    const alpha = Math.random() * 0.085;
    context.fillStyle = Math.random() > 0.56 ? `rgba(255,255,255,${alpha})` : `rgba(27,78,90,${alpha})`;
    context.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeBranchBarkTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 512, 192);
  gradient.addColorStop(0, "#8f8069");
  gradient.addColorStop(0.38, "#b5a283");
  gradient.addColorStop(0.72, "#9a866b");
  gradient.addColorStop(1, "#c7b28d");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 192);

  for (let i = 0; i < 90; i += 1) {
    const y = Math.random() * 192;
    const alpha = rand(0.1, 0.34);
    context.strokeStyle = Math.random() > 0.45 ? `rgba(104,89,70,${alpha * 0.44})` : `rgba(220,199,155,${alpha * 0.6})`;
    context.lineWidth = rand(0.6, 2.4);
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) {
      context.lineTo(x, y + Math.sin(x * 0.025 + i) * rand(0.8, 4.6) + rand(-2.2, 2.2));
    }
    context.stroke();
  }

  for (let i = 0; i < 28; i += 1) {
    const x = Math.random() * 512;
    const y = Math.random() * 192;
    context.fillStyle = "rgba(108,92,72,0.12)";
    context.beginPath();
    context.ellipse(x, y, rand(5, 18), rand(2, 7), rand(-0.6, 0.6), 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(204,181,137,0.18)";
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeBranchBumpTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  context.fillStyle = "#777";
  context.fillRect(0, 0, 512, 192);
  for (let i = 0; i < 120; i += 1) {
    const y = Math.random() * 192;
    context.strokeStyle = Math.random() > 0.5 ? "rgba(25,25,25,0.4)" : "rgba(235,235,235,0.28)";
    context.lineWidth = rand(0.5, 2.1);
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= 512; x += 26) {
      context.lineTo(x, y + Math.sin(x * 0.03 + i) * rand(1.2, 4.2));
    }
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1);
  return texture;
}

function makeLeafLitterTexture({ base = "#a96b31", light = "#dfb071", dark = "#513117" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(256, 128);

  const makeLeafPath = () => {
    context.beginPath();
    context.moveTo(-238, 0);
    context.bezierCurveTo(-176, -78, 92, -96, 238, 0);
    context.bezierCurveTo(94, 92, -178, 78, -238, 0);
    context.closePath();
  };

  makeLeafPath();
  context.clip();
  const gradient = context.createLinearGradient(-238, -80, 238, 96);
  gradient.addColorStop(0, dark);
  gradient.addColorStop(0.18, base);
  gradient.addColorStop(0.58, light);
  gradient.addColorStop(1, dark);
  context.fillStyle = gradient;
  context.fillRect(-256, -128, 512, 256);

  for (let i = 0; i < 360; i += 1) {
    const x = rand(-226, 226);
    const y = rand(-88, 88);
    const alpha = rand(0.035, 0.16);
    context.fillStyle = Math.random() > 0.48 ? `rgba(45,25,13,${alpha})` : `rgba(245,213,154,${alpha})`;
    context.beginPath();
    context.ellipse(x, y, rand(1.2, 6.5), rand(0.8, 4.2), rand(-1.2, 1.2), 0, Math.PI * 2);
    context.fill();
  }

  context.lineCap = "round";
  context.strokeStyle = "rgba(66,34,14,0.56)";
  context.lineWidth = 4.8;
  context.beginPath();
  context.moveTo(-228, 2);
  for (let x = -186; x <= 226; x += 44) context.lineTo(x, Math.sin(x * 0.025) * 5);
  context.stroke();

  context.strokeStyle = "rgba(239,197,124,0.28)";
  context.lineWidth = 1.8;
  context.beginPath();
  context.moveTo(-220, -3);
  context.lineTo(228, -6);
  context.stroke();

  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 11; i += 1) {
      const x = -176 + i * 37;
      const veinLength = 28 + i * 3.4 + rand(-5, 7);
      const y = Math.sin(x * 0.03) * 3;
      context.strokeStyle = i % 2 === 0 ? "rgba(74,39,16,0.36)" : "rgba(244,204,132,0.25)";
      context.lineWidth = rand(1.2, 2.2);
      context.beginPath();
      context.moveTo(x, y);
      context.quadraticCurveTo(x + 17, y + side * 8, x + veinLength, y + side * (22 + i * 1.7));
      context.stroke();
    }
  }

  context.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 15; i += 1) {
    context.fillStyle = `rgba(0,0,0,${rand(0.18, 0.45)})`;
    context.beginPath();
    context.ellipse(rand(-205, 200), rand(-72, 72), rand(2.2, 7), rand(1.4, 5), rand(-0.8, 0.8), 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
  context.restore();

  context.save();
  context.translate(256, 128);
  makeLeafPath();
  context.strokeStyle = "rgba(45,24,10,0.48)";
  context.lineWidth = 4;
  context.stroke();
  context.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  return texture;
}

function makeFoodTexture(textureKey) {
  const spec = FOOD_TEXTURE_MANIFEST[textureKey] ?? FOOD_TEXTURE_MANIFEST.bread;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 256, 256);

  const gradient = context.createRadialGradient(90, 74, 10, 128, 128, 132);
  gradient.addColorStop(0, spec.accent);
  gradient.addColorStop(0.48, spec.base);
  gradient.addColorStop(1, spec.dark);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);

  context.save();
  context.globalAlpha = 0.24;
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  for (let i = 0; i < 10; i += 1) {
    context.beginPath();
    context.ellipse(rand(48, 208), rand(48, 208), rand(18, 68), rand(4, 16), rand(-0.9, 0.9), 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();

  if (textureKey === "strawberry") {
    context.fillStyle = "rgba(255,232,160,0.9)";
    for (let i = 0; i < 42; i += 1) {
      context.beginPath();
      context.ellipse(rand(34, 222), rand(36, 220), rand(1.2, 2.4), rand(2.2, 4.8), rand(-0.4, 0.4), 0, Math.PI * 2);
      context.fill();
    }
  } else if (textureKey === "cheese") {
    context.fillStyle = "rgba(91,62,18,0.38)";
    for (let i = 0; i < 18; i += 1) {
      context.beginPath();
      context.arc(rand(28, 228), rand(28, 228), rand(4, 16), 0, Math.PI * 2);
      context.fill();
    }
  } else if (textureKey === "cookie") {
    context.fillStyle = "rgba(58,34,23,0.62)";
    for (let i = 0; i < 24; i += 1) {
      context.beginPath();
      context.arc(rand(20, 236), rand(20, 236), rand(2, 7), 0, Math.PI * 2);
      context.fill();
    }
  } else if (textureKey === "banana" || textureKey === "bread") {
    context.fillStyle = "rgba(92,62,24,0.26)";
    for (let i = 0; i < 28; i += 1) context.fillRect(rand(18, 236), rand(18, 236), rand(1, 4), rand(1, 4));
  } else if (textureKey === "seed" || textureKey === "nut") {
    for (let i = 0; i < 42; i += 1) {
      context.fillStyle = i % 2 ? "rgba(255,220,145,0.22)" : "rgba(64,34,16,0.22)";
      context.beginPath();
      context.ellipse(rand(14, 242), rand(14, 242), rand(5, 16), rand(2, 7), rand(0, Math.PI), 0, Math.PI * 2);
      context.fill();
    }
  } else if (textureKey === "insect" || textureKey === "protein") {
    context.fillStyle = "rgba(33,25,20,0.28)";
    for (let i = 0; i < 18; i += 1) {
      context.beginPath();
      context.ellipse(rand(28, 228), rand(28, 228), rand(10, 28), rand(5, 15), rand(-0.7, 0.7), 0, Math.PI * 2);
      context.fill();
    }
  } else if (textureKey === "picnic" || textureKey === "largeFruit") {
    const colors = ["rgba(230,72,52,0.38)", "rgba(242,206,112,0.32)", "rgba(112,74,42,0.28)", "rgba(245,230,180,0.3)"];
    for (let i = 0; i < 28; i += 1) {
      context.fillStyle = colors[i % colors.length];
      context.beginPath();
      context.ellipse(rand(20, 236), rand(20, 236), rand(8, 26), rand(4, 14), rand(-0.9, 0.9), 0, Math.PI * 2);
      context.fill();
    }
  }

  context.fillStyle = "rgba(255,255,255,0.2)";
  context.beginPath();
  context.ellipse(82, 58, 40, 12, -0.55, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  return texture;
}

function makeIrregularDiscGeometry(segments = 72, jitter = 0.12) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const ripple = 1 + Math.sin(angle * 3.1 + rand(-0.4, 0.4)) * jitter * 0.55 + rand(-jitter, jitter);
    points.push(new THREE.Vector2(Math.cos(angle) * ripple, Math.sin(angle) * ripple));
  }
  const shape = new THREE.Shape(points);
  return new THREE.ShapeGeometry(shape);
}

function createNestMoundGeometry({
  innerRadius = 3.1,
  outerRadius = 14,
  height = 2.2,
  ellipseZ = 0.82,
  segments = 96,
  rings = 12,
} = {}) {
  const vertices = [];
  const uvs = [];
  const indices = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const radius = innerRadius + (outerRadius - innerRadius) * t;
    const rimHeight = height * Math.pow(1 - t, 1.55);
    const rimLift = Math.exp(-Math.pow((t - 0.08) / 0.15, 2)) * height * 0.16;
    const shallowDip = Math.exp(-Math.pow((t - 0.44) / 0.2, 2)) * height * 0.05;

    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const edgeNoise = 1
        + Math.sin(angle * 3.2 + 0.7) * 0.035 * (1 - t * 0.18)
        + Math.sin(angle * 7.1 + t * 2.4) * 0.018;
      const x = Math.cos(angle) * radius * edgeNoise;
      const z = Math.sin(angle) * radius * ellipseZ * edgeNoise;
      const grain = Math.sin(angle * 11.0 + ring * 0.83) * 0.035 * height * (1 - t * 0.45);
      const y = Math.max(0, rimHeight + rimLift - shallowDip + grain);
      vertices.push(x, y, z);
      uvs.push(0.5 + Math.cos(angle) * t * 0.5, 0.5 + Math.sin(angle) * t * 0.5);
    }
  }

  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * stride + segment;
      const b = a + 1;
      const c = (ring + 1) * stride + segment;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createCurledLeafGeometry(width = 0.92, length = 0.38, widthSegments = 7, lengthSegments = 3) {
  const geometry = new THREE.PlaneGeometry(width, length, widthSegments, lengthSegments);
  const position = geometry.attributes.position;
  const halfWidth = width * 0.5;
  const halfLength = length * 0.5;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const along = Math.abs(x) / halfWidth;
    const across = Math.abs(y) / halfLength;
    const taper = clamp(1 - along * 0.58, 0.34, 1);
    const centerLift = Math.sin((x / width + 0.5) * Math.PI) * 0.055;
    const curledEdge = across * across * (0.045 + along * 0.035);
    const midrib = (1 - across) * 0.022;
    position.setY(i, y * taper);
    position.setZ(i, centerLift + curledEdge + midrib);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function appendBranchTube(vertices, uvs, indices, pathFn, radiusFn, radialSegments, lengthSegments) {
  const startIndex = vertices.length / 3;
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(1, 0, 0);
  const center = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const next = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();

  for (let ring = 0; ring <= lengthSegments; ring += 1) {
    const t = ring / lengthSegments;
    pathFn(t, center);
    pathFn(Math.max(0, t - 1 / lengthSegments), previous);
    pathFn(Math.min(1, t + 1 / lengthSegments), next);
    tangent.subVectors(next, previous).normalize();
    normal.crossVectors(tangent, up);
    if (normal.lengthSq() < 0.0001) normal.crossVectors(tangent, side);
    normal.normalize();
    binormal.crossVectors(tangent, normal).normalize();

    const radius = radiusFn(t);
    const rib = 1 + Math.sin(t * Math.PI * 8.4) * 0.035;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      const ringNoise = 1 + Math.sin(segment * 2.1 + ring * 0.76) * 0.045;
      const oval = 0.88 + Math.sin(t * Math.PI * 3.2) * 0.05;
      const nx = Math.cos(angle) * radius * ringNoise * rib;
      const nz = Math.sin(angle) * radius * ringNoise * rib * oval;
      vertices.push(
        center.x + normal.x * nx + binormal.x * nz,
        center.y + normal.y * nx + binormal.y * nz,
        center.z + normal.z * nx + binormal.z * nz,
      );
      uvs.push(segment / radialSegments, t);
    }
  }

  for (let ring = 0; ring < lengthSegments; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const a = startIndex + ring * radialSegments + segment;
      const b = startIndex + ring * radialSegments + ((segment + 1) % radialSegments);
      const c = startIndex + (ring + 1) * radialSegments + segment;
      const d = startIndex + (ring + 1) * radialSegments + ((segment + 1) % radialSegments);
      indices.push(a, c, b, b, c, d);
    }
  }
}

function createBroadleafBranchGeometry(length = 1, baseRadius = 0.08, tipRadius = 0.04, options = {}) {
  const radialSegments = options.radialSegments ?? 9;
  const lengthSegments = options.lengthSegments ?? 12;
  const bendX = options.bendX ?? 0.11;
  const bendZ = options.bendZ ?? 0.045;
  const vertices = [];
  const uvs = [];
  const indices = [];

  const mainPath = (t, target) => {
    const sway = Math.sin(t * Math.PI);
    target.set(
      (sway * bendX + Math.sin(t * Math.PI * 2.35 + 0.8) * bendX * 0.24) * length,
      (t - 0.5) * length,
      Math.sin(t * Math.PI * 1.7 + 0.55) * bendZ * length,
    );
  };
  const mainRadius = (t) => {
    const taper = baseRadius + (tipRadius - baseRadius) * Math.pow(t, 0.82);
    const nodeBump = Math.exp(-Math.pow((t - 0.32) / 0.055, 2)) * 0.18 + Math.exp(-Math.pow((t - 0.68) / 0.07, 2)) * 0.14;
    return taper * (1 + nodeBump);
  };

  appendBranchTube(vertices, uvs, indices, mainPath, mainRadius, radialSegments, lengthSegments);

  if (options.forked) {
    const makeFork = (anchorT, sideSign, forkLength, forkRadius) => {
      const start = new THREE.Vector3();
      mainPath(anchorT, start);
      appendBranchTube(
        vertices,
        uvs,
        indices,
        (t, target) => {
          target.set(
            start.x + sideSign * Math.sin(t * Math.PI * 0.72) * forkLength * 0.48,
            start.y + t * forkLength,
            start.z + Math.sin(t * Math.PI) * forkLength * 0.08,
          );
        },
        (t) => forkRadius * (1 - t * 0.62),
        Math.max(6, radialSegments - 2),
        Math.max(5, Math.round(lengthSegments * 0.45)),
      );
    };
    makeFork(0.34, 1, length * 0.24, baseRadius * 0.48);
    makeFork(0.62, -1, length * 0.19, baseRadius * 0.36);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBarkShardGeometry() {
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    -0.52, -0.055, -0.19,
    0.5, -0.06, -0.16,
    0.47, -0.045, 0.18,
    -0.48, -0.05, 0.15,
    -0.45, 0.045, -0.16,
    0.52, 0.075, -0.13,
    0.41, 0.12, 0.16,
    -0.53, 0.07, 0.12,
  ]);
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex([
    0, 2, 1,
    0, 3, 2,
    4, 5, 6,
    4, 6, 7,
    0, 1, 5,
    0, 5, 4,
    1, 2, 6,
    1, 6, 5,
    2, 3, 7,
    2, 7, 6,
    3, 0, 4,
    3, 4, 7,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

function createCylinderBetween(start, end, radiusTop, radiusBottom, material, radialSegments = 12) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, radialSegments);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function disposeMaterial(material) {
  for (const item of getMaterialList(material)) {
    for (const value of Object.values(item)) {
      if (value && value.isTexture && !value.userData?.sharedProceduralAsset) value.dispose();
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
    groundTexture.userData.sharedProceduralAsset = true;
    groundTexture.anisotropy = 4;
    this.cache.set("groundTexture", groundTexture);
    const waterSurfaceTexture = makeWaterSurfaceTexture();
    waterSurfaceTexture.userData.sharedProceduralAsset = true;
    waterSurfaceTexture.anisotropy = 4;
    this.cache.set("waterSurfaceTexture", waterSurfaceTexture);
    const branchBarkTexture = makeBranchBarkTexture();
    branchBarkTexture.userData.sharedProceduralAsset = true;
    branchBarkTexture.anisotropy = 6;
    this.cache.set("branchBarkTexture", branchBarkTexture);
    const branchBumpTexture = makeBranchBumpTexture();
    branchBumpTexture.userData.sharedProceduralAsset = true;
    branchBumpTexture.anisotropy = 6;
    this.cache.set("branchBumpTexture", branchBumpTexture);
    for (const textureKey of FOOD_TEXTURE_KEYS) {
      const texture = makeFoodTexture(textureKey);
      texture.userData.sharedProceduralAsset = true;
      texture.anisotropy = 4;
      texture.userData.manifest = FOOD_TEXTURE_MANIFEST[textureKey]?.asset ?? null;
      this.cache.set(`foodTexture:${textureKey}`, texture);
    }
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
    let returnCount = 0;
    let searchNestCount = 0;
    let insideNestCount = 0;
    let pathErrorSum = 0;
    for (const ant of this.sim.ants) {
      if (ant.insideNest) insideNestCount += 1;
      else if (ant.state === "return") returnCount += 1;
      else if (ant.state === "searchNest") searchNestCount += 1;
      pathErrorSum += ant.pathError ?? 0;
    }
    const averagePathError = this.sim.ants.length > 0 ? pathErrorSum / this.sim.ants.length : 0;
    const terrain = this.sim.terrain && Number.isFinite(this.sim.debugCursorX) ? this.sim.terrain.sampleType(this.sim.debugCursorX, this.sim.debugCursorZ) : null;
    const terrainMove = terrain ? this.sim.terrain.sampleMovementMultiplier(this.sim.debugCursorX, this.sim.debugCursorZ) : 1;
    const terrainPheromone = terrain ? this.sim.terrain.samplePheromoneModifiers(this.sim.debugCursorX, this.sim.debugCursorZ) : null;
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
      `return ${returnCount}`,
      `searchNest ${searchNestCount}`,
      `insideNest ${insideNestCount}`,
      `nestGate in ${this.sim.nestTraffic.entryTokens.toFixed(2)} out ${this.sim.nestTraffic.exitTokens.toFixed(2)}`,
      `pathError ${averagePathError.toFixed(1)}`,
      `pheromone ${this.sim.pheromones?.mode ?? "off"} ${this.sim.pheromones?.resolution ?? 0}`,
      `terrain ${terrain?.id ?? "-"} move ${terrainMove.toFixed(2)} decay ${(terrainPheromone?.decay ?? 1).toFixed(2)} diff ${(terrainPheromone?.diffusion ?? 1).toFixed(2)}`,
      `terrainProps ${this.sim.terrain?.propInstanceCount ?? 0}`,
      `propColliders ${this.sim.terrain?.propColliders.length ?? 0}`,
    ].join("\n");
    this.elapsed = 0;
    this.frames = 0;
  }
}

class TerrainSystem {
  constructor(sim, options = {}) {
    this.sim = sim;
    this.resolution = options.resolution ?? 144;
    this.fieldRadius = sim.worldRadius + sim.fieldMargin;
    this.fieldSize = this.fieldRadius * 2;
    this.cellSize = this.fieldSize / this.resolution;
    this.invCellSize = 1 / this.cellSize;
    this.seed = options.seed ?? readStorage("ant3d.terrainSeed") ?? `terrain-${Date.now()}`;
    this.complexity = TERRAIN_COMPLEXITY_LEVELS.includes(readStorage("ant3d.terrainComplexity")) ? readStorage("ant3d.terrainComplexity") : "medium";
    this.effectsEnabled = readStorage("ant3d.terrainEffects") !== "0";
    this.terrainType = new Uint8Array(this.resolution * this.resolution);
    this.height = new Float32Array(this.resolution * this.resolution);
    this.moisture = new Float32Array(this.resolution * this.resolution);
    this.roughness = new Float32Array(this.resolution * this.resolution);
    this.sampleScratch = { gx: 0, gz: 0, index: 0 };
    this.pheromoneScratch = { decay: 1, diffusion: 1 };
    this.propColor = new THREE.Color();
    this.propDirection = new THREE.Vector3();
    this.propMid = new THREE.Vector3();
    this.propUp = new THREE.Vector3(0, 1, 0);
    this.rootSegments = [];
    this.puddlePatches = [];
    this.propColliders = [];
    this.propColliderCellSize = 24;
    this.propColliderInvCellSize = 1 / this.propColliderCellSize;
    this.propColliderGridSize = Math.ceil(this.fieldSize / this.propColliderCellSize) + 1;
    this.propColliderGrid = Array.from({ length: this.propColliderGridSize * this.propColliderGridSize }, () => []);
    this.propSurfaceScratch = { hit: false, y: 0, slow: 1, pitch: 0, roll: 0, kind: null, climbable: false, edgeFactor: 0 };
    this.visuals = [];
    this.ownedGeometries = [];
    this.ownedMaterials = [];
    this.texture = null;
    this.mesh = null;
    this.propInstanceCount = 0;
    this.hazardAccumulator = 0;
    this.dummy = new THREE.Object3D();
    this.generate(this.seed);
  }

  reset() {
    this.generate(this.seed);
  }

  dispose() {
    this.clearVisuals();
    this.texture?.dispose();
    this.texture = null;
  }

  clearVisuals() {
    for (const visual of this.visuals) this.sim.scene.remove(visual);
    this.visuals.length = 0;
    this.texture?.dispose();
    this.texture = null;
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) disposeMaterial(material);
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.mesh = null;
    this.propInstanceCount = 0;
    this.clearPropColliders();
  }

  setEffectsEnabled(enabled) {
    this.effectsEnabled = Boolean(enabled);
    writeStorage("ant3d.terrainEffects", this.effectsEnabled ? "1" : "0");
  }

  setComplexity(complexity) {
    this.complexity = TERRAIN_COMPLEXITY_LEVELS.includes(complexity) ? complexity : "medium";
    writeStorage("ant3d.terrainComplexity", this.complexity);
  }

  regenerate() {
    this.seed = `terrain-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    writeStorage("ant3d.terrainSeed", this.seed);
    this.generate(this.seed);
  }

  update(dt) {
    if (!this.effectsEnabled || !this.sim.pheromones) return;
    this.hazardAccumulator += dt;
    if (this.hazardAccumulator < 0.75) return;
    const elapsed = this.hazardAccumulator;
    this.hazardAccumulator = 0;
    for (const patch of this.puddlePatches) {
      this.sim.pheromones.deposit("avoid", patch.x, patch.z, 0.045 * elapsed, patch.radius + 5);
    }
  }

  generate(seed = this.seed) {
    this.seed = seed;
    this.random = makeSeededRandom(seed);
    this.rootSegments.length = 0;
    this.puddlePatches.length = 0;
    const complexityScale = this.complexity === "high" ? 1.35 : this.complexity === "low" ? 0.7 : 1;
    const rootCount = Math.round(4 * complexityScale);
    for (let i = 0; i < rootCount; i += 1) {
      const a = this.random() * Math.PI * 2;
      const baseRadius = this.sim.worldRadius * (0.36 + this.random() * 0.42);
      const x1 = Math.cos(a) * baseRadius;
      const z1 = Math.sin(a) * baseRadius;
      const length = this.sim.worldRadius * (0.28 + this.random() * 0.34);
      const bend = a + (this.random() - 0.5) * 1.4;
      this.rootSegments.push({
        x1,
        z1,
        x2: x1 + Math.cos(bend) * length,
        z2: z1 + Math.sin(bend) * length,
        width: 2.2 + this.random() * 2.4,
      });
    }

    const pathAngle = -0.16 + this.random() * 0.42;
    const dirX = Math.cos(pathAngle);
    const dirZ = Math.sin(pathAngle);
    const pathPhase = this.random() * Math.PI * 2;
    const safeRadius = this.sim.nest.radius + 16;

    for (let gz = 0; gz < this.resolution; gz += 1) {
      const z = (gz + 0.5) * this.cellSize - this.fieldRadius;
      const row = gz * this.resolution;
      for (let gx = 0; gx < this.resolution; gx += 1) {
        const x = (gx + 0.5) * this.cellSize - this.fieldRadius;
        const index = row + gx;
        const worldDistance = Math.hypot(x, z);
        if (worldDistance > this.sim.worldRadius + 1) {
          this.terrainType[index] = TERRAIN_TYPES.soil.index;
          this.height[index] = 0;
          this.moisture[index] = 0;
          this.roughness[index] = 0;
          continue;
        }

        const toNestX = x - this.sim.nest.x;
        const toNestZ = z - this.sim.nest.z;
        const nestDistance = Math.hypot(toNestX, toNestZ);
        const alongPath = toNestX * dirX + toNestZ * dirZ;
        const lateral = Math.abs(toNestX * -dirZ + toNestZ * dirX + Math.sin(alongPath * 0.035 + pathPhase) * 8.5);
        const broadNoise = this.noise(x * 0.028, z * 0.028);
        const fineNoise = this.noise(x * 0.085 + 21.7, z * 0.085 - 9.2);
        let type = TERRAIN_TYPES.soil;

        if (nestDistance < safeRadius) {
          type = lateral < 9 ? TERRAIN_TYPES.path : TERRAIN_TYPES.soil;
        } else if (lateral < 5.5 + broadNoise * 3.5) {
          type = fineNoise > 0.78 ? TERRAIN_TYPES.pavement : TERRAIN_TYPES.path;
        } else if (this.pointInPuddle(x, z, 0.62)) {
          type = TERRAIN_TYPES.puddle;
        } else if (this.pointInPuddle(x, z, 1.25)) {
          type = TERRAIN_TYPES.mud;
        } else if (this.pointOnRoot(x, z) && nestDistance > safeRadius + 4) {
          type = TERRAIN_TYPES.root;
        } else if (broadNoise > 0.76) {
          type = TERRAIN_TYPES.leafLitter;
        } else if (broadNoise < 0.18) {
          type = fineNoise < 0.42 ? TERRAIN_TYPES.sand : TERRAIN_TYPES.gravel;
        } else if (fineNoise > 0.52) {
          type = TERRAIN_TYPES.grass;
        }

        this.terrainType[index] = type.index;
        this.moisture[index] = clamp((type === TERRAIN_TYPES.mud ? 0.72 : type === TERRAIN_TYPES.puddle ? 1 : 0.18 + broadNoise * 0.32), 0, 1);
        this.roughness[index] = clamp(type.roughness + fineNoise * 0.12, 0, 1);

        this.height[index] = 0;
      }
    }
    this.addTerrainVisuals();
    this.sim.pheromones?.refreshTerrainModifiers?.();
    this.sim.pheromones?.refreshTerrainGeometry?.();
  }

  noise(x, z) {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const tx = x - x0;
    const tz = z - z0;
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const n00 = this.hashNoise(x0, z0);
    const n10 = this.hashNoise(x0 + 1, z0);
    const n01 = this.hashNoise(x0, z0 + 1);
    const n11 = this.hashNoise(x0 + 1, z0 + 1);
    const a = n00 * (1 - sx) + n10 * sx;
    const b = n01 * (1 - sx) + n11 * sx;
    return a * (1 - sz) + b * sz;
  }

  hashNoise(x, z) {
    let h = hashSeed(`${this.seed}:${x}:${z}`);
    h ^= h >>> 16;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    return ((h >>> 0) % 10000) / 10000;
  }

  pointInPuddle(x, z, scale) {
    for (const patch of this.puddlePatches) {
      if (distance2(x, z, patch.x, patch.z) < patch.radius * scale) return true;
    }
    return false;
  }

  pointOnRoot(x, z) {
    for (const root of this.rootSegments) {
      const point = closestPointOnSegment(x, z, root.x1, root.z1, root.x2, root.z2);
      if (distance2(x, z, point.x, point.z) < root.width) return true;
    }
    return false;
  }

  worldToIndex(x, z, target = this.sampleScratch) {
    const gx = clamp(Math.floor((x + this.fieldRadius) * this.invCellSize), 0, this.resolution - 1);
    const gz = clamp(Math.floor((z + this.fieldRadius) * this.invCellSize), 0, this.resolution - 1);
    target.gx = gx;
    target.gz = gz;
    target.index = gz * this.resolution + gx;
    return target;
  }

  sampleType(x, z) {
    return TERRAIN_BY_INDEX[this.terrainType[this.worldToIndex(x, z).index]] ?? TERRAIN_TYPES.soil;
  }

  sampleTypeIndex(x, z) {
    return this.terrainType[this.worldToIndex(x, z).index] ?? TERRAIN_TYPES.soil.index;
  }

  sampleMovementMultiplier(x, z) {
    if (!this.effectsEnabled) return 1;
    return this.sampleType(x, z).movement;
  }

  sampleDetectionMultiplier(x, z) {
    if (!this.effectsEnabled) return 1;
    return this.sampleType(x, z).detection;
  }

  sampleRoughness(x, z) {
    if (!this.effectsEnabled) return 0;
    return this.roughness[this.worldToIndex(x, z).index] ?? 0;
  }

  samplePheromoneModifiers(x, z, target = this.pheromoneScratch) {
    if (!this.effectsEnabled) {
      target.decay = 1;
      target.diffusion = 1;
      return target;
    }
    const type = this.sampleType(x, z);
    target.decay = type.pheromoneDecay;
    target.diffusion = type.pheromoneDiffusion;
    return target;
  }

  sampleHeight(x, z) {
    const gx = clamp((x + this.fieldRadius) * this.invCellSize - 0.5, 0, this.resolution - 1);
    const gz = clamp((z + this.fieldRadius) * this.invCellSize - 0.5, 0, this.resolution - 1);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.resolution - 1, x0 + 1);
    const z1 = Math.min(this.resolution - 1, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const row0 = z0 * this.resolution;
    const row1 = z1 * this.resolution;
    const h00 = this.height[row0 + x0] ?? 0;
    const h10 = this.height[row0 + x1] ?? h00;
    const h01 = this.height[row1 + x0] ?? h00;
    const h11 = this.height[row1 + x1] ?? h10;
    const a = h00 * (1 - tx) + h10 * tx;
    const b = h01 * (1 - tx) + h11 * tx;
    return a * (1 - tz) + b * tz;
  }

  sampleMaxHeightAround(x, z, radius = 0) {
    let maxHeight = this.sampleHeight(x, z);
    if (radius <= 0) return maxHeight;
    const rings = radius > 18 ? 2 : 1;
    const samples = radius > 18 ? 12 : 8;
    for (let ring = 1; ring <= rings; ring += 1) {
      const distance = radius * (ring / rings);
      for (let i = 0; i < samples; i += 1) {
        const angle = (i / samples) * Math.PI * 2;
        const h = this.sampleHeight(x + Math.cos(angle) * distance, z + Math.sin(angle) * distance);
        if (h > maxHeight) maxHeight = h;
      }
    }
    return maxHeight;
  }

  clearPropColliders() {
    this.propColliders.length = 0;
    for (const cell of this.propColliderGrid) cell.length = 0;
  }

  propColliderCellCoord(value) {
    return clamp(Math.floor((value + this.fieldRadius) * this.propColliderInvCellSize), 0, this.propColliderGridSize - 1);
  }

  propColliderCellIndex(x, z) {
    return this.propColliderCellCoord(z) * this.propColliderGridSize + this.propColliderCellCoord(x);
  }

  registerPropCollider(collider) {
    const boundsRadius = collider.boundsRadius ?? Math.max(collider.halfLength ?? 0, collider.halfWidth ?? collider.radius ?? 0) + 2;
    collider.boundsRadius = boundsRadius;
    collider.id = this.propColliders.length;
    this.propColliders.push(collider);

    const minGX = this.propColliderCellCoord(collider.x - boundsRadius);
    const maxGX = this.propColliderCellCoord(collider.x + boundsRadius);
    const minGZ = this.propColliderCellCoord(collider.z - boundsRadius);
    const maxGZ = this.propColliderCellCoord(collider.z + boundsRadius);
    for (let gz = minGZ; gz <= maxGZ; gz += 1) {
      const row = gz * this.propColliderGridSize;
      for (let gx = minGX; gx <= maxGX; gx += 1) this.propColliderGrid[row + gx].push(collider);
    }
  }

  registerInstancedPropCollider(name, x, z, yaw, scale, baseHeight, yOffset, options) {
    const config = options.collider;
    if (!config) return;
    const stretchX = options.stretchX ?? 1;
    const stretchY = options.stretchY ?? 1;
    const stretchZ = options.stretchZ ?? 1;

    if (config.kind === "leaf") {
      const length = config.length * scale * stretchX;
      const width = config.width * scale * stretchZ;
      const dirX = Math.cos(yaw);
      const dirZ = Math.sin(yaw);
      const halfLength = length * 0.5;
      const halfWidth = width * 0.5;
      this.registerPropCollider({
        kind: "leaf",
        name,
        x,
        z,
        dirX,
        dirZ,
        sideX: -dirZ,
        sideZ: dirX,
        halfLength,
        halfWidth,
        surfaceY: baseHeight + yOffset + (config.surfaceOffset ?? 0.08),
        crown: config.crown ?? 0.12,
        boundsRadius: Math.hypot(halfLength, halfWidth) + 2,
      });
    } else if (config.kind === "branch") {
      const length = config.length * scale * stretchY;
      const radius = config.radius * scale * Math.max(stretchX, stretchZ);
      const dirX = Math.sin(yaw);
      const dirZ = Math.cos(yaw);
      this.registerPropCollider({
        kind: "branch",
        name,
        x,
        z,
        dirX,
        dirZ,
        halfLength: length * 0.5,
        radius,
        avoidRadius: radius + (config.avoidPadding ?? 0.55),
        climbable: config.climbable ?? radius <= PROP_CONTACT_PARAMS.branchClimbRadiusMax,
        surfaceY: baseHeight + yOffset + radius * (config.surfaceRadiusScale ?? 0.75),
        crown: radius * 0.18,
        boundsRadius: length * 0.5 + radius + 2,
      });
    }
  }

  samplePropContact(x, z, angle = 0, target = this.propSurfaceScratch) {
    target.hit = false;
    target.y = this.sampleHeight(x, z);
    target.slow = 1;
    target.pitch = 0;
    target.roll = 0;
    target.kind = null;
    target.climbable = false;
    target.edgeFactor = 0;
    const cell = this.propColliderGrid[this.propColliderCellIndex(x, z)];
    if (!cell || cell.length === 0) return target;

    let bestY = -Infinity;
    const forwardX = Math.sin(angle);
    const forwardZ = Math.cos(angle);
    const rightX = Math.cos(angle);
    const rightZ = -Math.sin(angle);
    for (const collider of cell) {
      const dx = x - collider.x;
      const dz = z - collider.z;
      if (dx * dx + dz * dz > collider.boundsRadius * collider.boundsRadius) continue;

      if (collider.kind === "leaf") {
        const along = dx * collider.dirX + dz * collider.dirZ;
        const side = dx * collider.sideX + dz * collider.sideZ;
        const normalized = (along * along) / (collider.halfLength * collider.halfLength) + (side * side) / (collider.halfWidth * collider.halfWidth);
        if (normalized > 1) continue;
        const edgeFactor = clamp(1 - normalized, 0, 1);
        const crown = collider.crown * Math.pow(edgeFactor, 0.65);
        const curl = Math.sin((along / collider.halfLength) * Math.PI * 0.5) * collider.crown * 0.2 * edgeFactor;
        const y = collider.surfaceY + crown + curl;
        if (y > bestY) {
          bestY = y;
          const slopeAlong = (-2 * collider.crown * along) / (collider.halfLength * collider.halfLength);
          const slopeSide = (-2 * collider.crown * side) / (collider.halfWidth * collider.halfWidth);
          const gradX = slopeAlong * collider.dirX + slopeSide * collider.sideX;
          const gradZ = slopeAlong * collider.dirZ + slopeSide * collider.sideZ;
          const slopeForward = gradX * forwardX + gradZ * forwardZ;
          const slopeRight = gradX * rightX + gradZ * rightZ;
          target.hit = true;
          target.y = bestY;
          target.slow = 0.78 + edgeFactor * 0.12;
          target.pitch = clamp(slopeForward * 0.72, -PROP_CONTACT_PARAMS.maxPitch, PROP_CONTACT_PARAMS.maxPitch);
          target.roll = clamp(slopeRight * 0.64, -PROP_CONTACT_PARAMS.maxRoll, PROP_CONTACT_PARAMS.maxRoll);
          target.kind = "leaf";
          target.climbable = true;
          target.edgeFactor = edgeFactor;
        }
      } else if (collider.kind === "branch") {
        if (!collider.climbable) continue;
        const along = clamp(dx * collider.dirX + dz * collider.dirZ, -collider.halfLength, collider.halfLength);
        const px = collider.x + collider.dirX * along;
        const pz = collider.z + collider.dirZ * along;
        const distance = Math.hypot(x - px, z - pz);
        const contactRadius = collider.radius + 0.34;
        if (distance > contactRadius) continue;
        const edgeFactor = clamp(1 - distance / contactRadius, 0, 1);
        const y = collider.surfaceY + collider.crown * Math.sqrt(edgeFactor);
        if (y > bestY) {
          bestY = y;
          const nx = distance > 0.001 ? (x - px) / distance : -collider.dirZ;
          const nz = distance > 0.001 ? (z - pz) / distance : collider.dirX;
          const slopeScale = -edgeFactor * 0.36;
          const gradX = nx * slopeScale;
          const gradZ = nz * slopeScale;
          target.hit = true;
          target.y = bestY;
          target.slow = 0.62 + edgeFactor * 0.18;
          target.pitch = clamp((gradX * forwardX + gradZ * forwardZ) * 0.75, -PROP_CONTACT_PARAMS.maxPitch, PROP_CONTACT_PARAMS.maxPitch);
          target.roll = clamp((gradX * rightX + gradZ * rightZ) * 0.82, -PROP_CONTACT_PARAMS.maxRoll, PROP_CONTACT_PARAMS.maxRoll);
          target.kind = "branch";
          target.climbable = true;
          target.edgeFactor = edgeFactor;
        }
      }
    }

    return target;
  }

  samplePropSurface(x, z, target = this.propSurfaceScratch) {
    return this.samplePropContact(x, z, 0, target);
  }

  resolvePropCollisions(ant, steering) {
    const cell = this.propColliderGrid[this.propColliderCellIndex(ant.x, ant.z)];
    if (!cell || cell.length === 0) return;
    const forwardX = Math.sin(ant.angle);
    const forwardZ = Math.cos(ant.angle);
    for (const collider of cell) {
      if (collider.kind !== "branch") continue;
      const dx = ant.x - collider.x;
      const dz = ant.z - collider.z;
      if (dx * dx + dz * dz > collider.boundsRadius * collider.boundsRadius) continue;
      const along = clamp(dx * collider.dirX + dz * collider.dirZ, -collider.halfLength, collider.halfLength);
      const px = collider.x + collider.dirX * along;
      const pz = collider.z + collider.dirZ * along;
      let nx = ant.x - px;
      let nz = ant.z - pz;
      let distance = Math.hypot(nx, nz);
      if (distance < 0.001) {
        nx = -collider.dirZ;
        nz = collider.dirX;
        distance = 1;
      } else {
        nx /= distance;
        nz /= distance;
      }

      const branchDot = forwardX * collider.dirX + forwardZ * collider.dirZ;
      const alongSign = branchDot >= 0 ? 1 : -1;
      const contactRadius = collider.radius + 0.34;
      if (collider.climbable && distance < contactRadius) {
        const centerPull = clamp(1 - distance / contactRadius, 0, 1) * 0.16;
        steering.x += collider.dirX * alongSign * 0.32 - nx * centerPull;
        steering.z += collider.dirZ * alongSign * 0.32 - nz * centerPull;
        continue;
      }

      const aheadX = ant.x + forwardX * PROP_CONTACT_PARAMS.branchApproachLookAhead;
      const aheadZ = ant.z + forwardZ * PROP_CONTACT_PARAMS.branchApproachLookAhead;
      const aheadDX = aheadX - collider.x;
      const aheadDZ = aheadZ - collider.z;
      const aheadAlong = clamp(aheadDX * collider.dirX + aheadDZ * collider.dirZ, -collider.halfLength, collider.halfLength);
      const aheadPX = collider.x + collider.dirX * aheadAlong;
      const aheadPZ = collider.z + collider.dirZ * aheadAlong;
      const aheadDistance = Math.hypot(aheadX - aheadPX, aheadZ - aheadPZ);
      const avoidRadius = collider.avoidRadius + 0.42;
      if (collider.climbable) {
        const mountRadius = avoidRadius + 1.2;
        if (aheadDistance < mountRadius) {
          const aheadNX = aheadDistance > 0.001 ? (aheadX - aheadPX) / aheadDistance : nx;
          const aheadNZ = aheadDistance > 0.001 ? (aheadZ - aheadPZ) / aheadDistance : nz;
          const mountStrength = clamp(1 - aheadDistance / mountRadius, 0, 1);
          steering.x += -aheadNX * mountStrength * 0.54 + collider.dirX * alongSign * mountStrength * 0.42;
          steering.z += -aheadNZ * mountStrength * 0.54 + collider.dirZ * alongSign * mountStrength * 0.42;
        }
        if (distance < avoidRadius) {
          const centerPull = clamp(1 - distance / avoidRadius, 0, 1) * 0.28;
          steering.x += -nx * centerPull + collider.dirX * alongSign * 0.32;
          steering.z += -nz * centerPull + collider.dirZ * alongSign * 0.32;
        }
        continue;
      }
      if (aheadDistance < avoidRadius + 1.4) {
        const aheadNX = aheadDistance > 0.001 ? (aheadX - aheadPX) / aheadDistance : nx;
        const aheadNZ = aheadDistance > 0.001 ? (aheadZ - aheadPZ) / aheadDistance : nz;
        const avoidStrength = clamp(1 - aheadDistance / (avoidRadius + 1.4), 0, 1);
        steering.x += aheadNX * avoidStrength * 0.66 + collider.dirX * alongSign * avoidStrength * 0.46;
        steering.z += aheadNZ * avoidStrength * 0.66 + collider.dirZ * alongSign * avoidStrength * 0.46;
      }

      if (distance >= avoidRadius) continue;
      const push = Math.min((avoidRadius - distance) * 0.16, 0.38);
      ant.x += nx * push;
      ant.z += nz * push;
      const slide = clamp(1 - distance / avoidRadius, 0, 1);
      steering.x += nx * 0.22 + collider.dirX * alongSign * slide * 0.56;
      steering.z += nz * 0.22 + collider.dirZ * alongSign * slide * 0.56;
    }
  }

  getVisualSegments() {
    const qualityFactor = this.sim.quality.effectsQuality >= 0.95 ? 1 : 0.76;
    const complexitySegments = this.complexity === "high" ? 128 : this.complexity === "low" ? 64 : 96;
    return Math.round(complexitySegments * qualityFactor);
  }

  buildTerrainGeometry() {
    const segments = this.getVisualSegments();
    const geometry = new THREE.PlaneGeometry(this.fieldSize, this.fieldSize, segments, segments);
    const positions = geometry.attributes.position;
    const edgeRadius = this.sim.worldRadius + 1.5;
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const z = -positions.getY(i);
      const distance = Math.hypot(x, z);
      let y = this.sampleHeight(x, z);
      if (distance > edgeRadius) y = -0.72;
      positions.setZ(i, y);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData.terrainSegments = segments;
    return geometry;
  }

  isBlocked(x, z) {
    if (!this.effectsEnabled) return false;
    return this.sampleType(x, z).blocked;
  }

  isBlockedArea(x, z, radius = 0) {
    if (!this.effectsEnabled) return false;
    if (this.isBlocked(x, z)) return true;
    const sampleRadius = Math.max(1, radius * 0.62);
    for (let i = 0; i < 4; i += 1) {
      const angle = i * Math.PI * 0.5 + Math.PI * 0.25;
      if (this.isBlocked(x + Math.cos(angle) * sampleRadius, z + Math.sin(angle) * sampleRadius)) return true;
    }
    return false;
  }

  findNearestOpenPoint(x, z, radius = 0) {
    if (!this.effectsEnabled || !this.isBlockedArea(x, z, radius)) return { x, z };
    const maxDistance = Math.max(8, radius + 10);
    for (let ring = 1; ring <= 5; ring += 1) {
      const distance = (ring / 5) * maxDistance;
      const samples = 8 + ring * 4;
      for (let i = 0; i < samples; i += 1) {
        const angle = (i / samples) * Math.PI * 2;
        const px = x + Math.cos(angle) * distance;
        const pz = z + Math.sin(angle) * distance;
        if (Math.hypot(px, pz) + radius > this.sim.worldRadius - 2) continue;
        if (!this.isBlockedArea(px, pz, radius)) return { x: px, z: pz };
      }
    }
    return null;
  }

  findSpawnPoint(kind, spawnRadius = 0, isClear = null) {
    const category = kind ?? "mixed";
    for (let attempt = 0; attempt < 56; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const radius = Math.sqrt(this.random()) * (this.sim.worldRadius - spawnRadius - 4);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const type = this.sampleType(x, z);
      if (type.blocked) continue;
      const affinity = type.foodAffinity[category] ?? 1;
      if (this.random() > clamp(affinity / 1.55, 0.18, 1)) continue;
      if (!isClear || isClear(x, z)) return { x, z };
    }
    return null;
  }

  addTerrainVisuals() {
    this.clearVisuals();
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      const z = (y / (canvas.height - 1)) * this.fieldSize - this.fieldRadius;
      for (let x = 0; x < canvas.width; x += 1) {
        const wx = (x / (canvas.width - 1)) * this.fieldSize - this.fieldRadius;
        const pixel = (y * canvas.width + x) * 4;
        if (wx * wx + z * z > this.sim.worldRadius * this.sim.worldRadius) {
          image.data[pixel + 3] = 0;
          continue;
        }
        const type = this.sampleType(wx, z);
        const red = (type.color >> 16) & 255;
        const green = (type.color >> 8) & 255;
        const blue = type.color & 255;
        const n = this.noise(wx * 0.16 + 14, z * 0.16 - 3) - 0.5;
        const sampleStep = this.cellSize * 1.4;
        const slopeX = this.sampleHeight(wx + sampleStep, z) - this.sampleHeight(wx - sampleStep, z);
        const slopeZ = this.sampleHeight(wx, z + sampleStep) - this.sampleHeight(wx, z - sampleStep);
        const height = this.sampleHeight(wx, z);
        const baseRed = 128;
        const baseGreen = 103;
        const baseBlue = 67;
        const typeInfluence = type.id === "puddle" ? 0.55 : type.id === "root" ? 0.38 : type.id === "pavement" || type.id === "gravel" ? 0.32 : 0.24;
        const lightShade = clamp(1 + slopeX * -0.12 + slopeZ * 0.14 + height * 0.024 - Math.hypot(slopeX, slopeZ) * 0.05, 0.78, 1.14);
        const mixedRed = baseRed * (1 - typeInfluence) + red * typeInfluence;
        const mixedGreen = baseGreen * (1 - typeInfluence) + green * typeInfluence;
        const mixedBlue = baseBlue * (1 - typeInfluence) + blue * typeInfluence;
        image.data[pixel] = clamp((mixedRed + n * 12) * lightShade, 0, 255);
        image.data[pixel + 1] = clamp((mixedGreen + n * 12) * lightShade, 0, 255);
        image.data[pixel + 2] = clamp((mixedBlue + n * 12) * lightShade, 0, 255);
        image.data[pixel + 3] = 255;
      }
    }
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = canvas.width;
    sourceCanvas.height = canvas.height;
    sourceCanvas.getContext("2d").putImageData(image, 0, 0);
    context.filter = "blur(3.2px)";
    context.drawImage(sourceCanvas, 0, 0);
    context.filter = "none";
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.anisotropy = 1;
    this.texture.userData.sharedProceduralAsset = true;
    const geometry = this.buildTerrainGeometry();
    const material = new THREE.MeshStandardMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: 0.5,
      roughness: 0.96,
      metalness: 0,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.ownedGeometries.push(geometry);
    this.ownedMaterials.push(material);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0;
    this.mesh.renderOrder = 0;
    this.mesh.receiveShadow = this.sim.quality.shadowQuality !== "off";
    this.sim.scene.add(this.mesh);
    this.visuals.push(this.mesh);
    this.addProps();
  }

  addProps() {
    const density = (this.complexity === "high" ? 1.9 : this.complexity === "low" ? 0.42 : 1) * this.sim.quality.effectsQuality;
    const dryLeafMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: makeLeafLitterTexture({ base: "#b87335", light: "#e9bd7c", dark: "#74451f" }),
      roughness: 0.9,
      side: THREE.DoubleSide,
      alphaTest: 0.22,
    });
    const paleLeafMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: makeLeafLitterTexture({ base: "#bd914d", light: "#edca8d", dark: "#7b5429" }),
      roughness: 0.92,
      side: THREE.DoubleSide,
      alphaTest: 0.22,
    });
    const barkMap = this.sim.assetService.get("branchBarkTexture");
    const barkBump = this.sim.assetService.get("branchBumpTexture");
    const darkTwigMaterial = new THREE.MeshStandardMaterial({
      color: 0xa28e71,
      map: barkMap,
      bumpMap: barkBump,
      bumpScale: 0.24,
      roughness: 0.97,
    });
    this.addInstancedProps("leafFlake", "leafLitter", Math.round(92 * density), createCurledLeafGeometry(1.45, 0.62, 8, 3), dryLeafMaterial, { yOffset: 0.18, minScale: 2.2, maxScale: 5.8, flat: true, tilt: 0.14, stretchX: 1.28, stretchZ: 1.0 });
    this.addInstancedProps("pebble", "gravel", Math.round(34 * density), new THREE.DodecahedronGeometry(0.18, 0), new THREE.MeshStandardMaterial({ color: 0xa3a49a, roughness: 0.94 }), { yOffset: 0.7, minScale: 5.8, maxScale: 17.2, tumble: true, stretchY: 0.58 });
    this.addInstancedProps("fieldStone", ["soil", "gravel", "sand", "path"], Math.round(18 * density), new THREE.DodecahedronGeometry(0.45, 0), new THREE.MeshStandardMaterial({ color: 0xa7a292, roughness: 0.92, flatShading: true }), { yOffset: 1.6, minScale: 4.0, maxScale: 10.0, tumble: true, stretchY: 0.48, colorJitter: 0.045, castShadow: true });
    this.addInstancedProps("largeStone", ["soil", "gravel", "sand", "path"], Math.round(5 * density), new THREE.DodecahedronGeometry(0.95, 0), new THREE.MeshStandardMaterial({ color: 0x9b9789, roughness: 0.94, flatShading: true }), { yOffset: 2.6, minScale: 3.2, maxScale: 8.4, tumble: true, stretchY: 0.42, stretchX: 1.18, stretchZ: 0.92, colorJitter: 0.04, castShadow: true });
    this.addFeaturedRocks();
    this.addRootProps(Math.round(15 * density), Math.round(6 * density));
    this.addInstancedProps("fallenLeaf", ["leafLitter", "grass", "soil"], Math.round(19 * density), createCurledLeafGeometry(2.65, 1.18, 10, 4), paleLeafMaterial, { yOffset: 0.72, minScale: 4.6, maxScale: 11.0, flat: true, tilt: 0.18, stretchX: 1.16, stretchZ: 1.0, clearanceRadius: 1.45, collider: { kind: "leaf", length: 2.65, width: 1.18, surfaceOffset: 0.18, crown: 0.22 }, castShadow: true });
    this.addInstancedProps("largeFallenLeaf", ["leafLitter", "grass", "soil"], Math.round(6 * density), createCurledLeafGeometry(5.4, 2.35, 14, 5), new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: makeLeafLitterTexture({ base: "#b9652a", light: "#e9aa62", dark: "#6d3c1d" }),
      roughness: 0.9,
      side: THREE.DoubleSide,
      alphaTest: 0.24,
    }), { yOffset: 1.05, minScale: 7.2, maxScale: 14.0, flat: true, tilt: 0.2, stretchX: 1.05, stretchZ: 1.0, clearanceRadius: 2.2, collider: { kind: "leaf", length: 5.4, width: 2.35, surfaceOffset: 0.22, crown: 0.28 }, castShadow: true });
    this.addInstancedProps("brokenTwig", ["leafLitter", "soil", "grass", "root"], Math.round(9 * density), createBroadleafBranchGeometry(2.35, 0.115, 0.055, { radialSegments: 9, lengthSegments: 12, bendX: 0.1, bendZ: 0.035, forked: true }), darkTwigMaterial, { yOffset: 1.55, minScale: 4.8, maxScale: 12.5, layCylinder: true, liftVariance: 0.1, stretchY: 1.62, stretchX: 0.96, stretchZ: 0.96, clearanceRadius: 1.35, collider: { kind: "branch", length: 2.35, radius: 0.115, avoidPadding: 0.45, surfaceRadiusScale: 0.9, climbable: true }, colorJitter: 0.035, castShadow: true });
    this.addInstancedProps("fallenBranch", ["leafLitter", "soil", "grass", "root"], Math.round(4 * density), createBroadleafBranchGeometry(6.8, 0.34, 0.16, { radialSegments: 12, lengthSegments: 18, bendX: 0.16, bendZ: 0.05, forked: true }), darkTwigMaterial.clone(), { yOffset: 2.55, minScale: 2.4, maxScale: 5.2, layCylinder: true, liftVariance: 0.06, stretchY: 2.15, stretchX: 1.0, stretchZ: 1.0, clearanceRadius: 3.1, collider: { kind: "branch", length: 6.8, radius: 0.34, avoidPadding: 0.78, surfaceRadiusScale: 0.88, climbable: true }, colorJitter: 0.03, castShadow: true });
    this.addFeaturedClutter(paleLeafMaterial, darkTwigMaterial);
    this.addInstancedProps("pavementChip", ["pavement", "path"], Math.round(9 * density), new THREE.BoxGeometry(0.74, 0.045, 0.42), new THREE.MeshStandardMaterial({ color: 0xa7aba2, roughness: 0.86 }), { yOffset: 0.12, minScale: 3.0, maxScale: 8.2, lowShard: true, stretchX: 1.2, stretchZ: 0.82 });
    this.addInstancedProps("mudClump", "mud", Math.round(17 * density), new THREE.DodecahedronGeometry(0.18, 0), new THREE.MeshStandardMaterial({ color: 0x8b7352, roughness: 0.98 }), { yOffset: 0.075, minScale: 1.3, maxScale: 4.0, tumble: true, stretchY: 0.36 });
    this.addInstancedProps("sandGrainCluster", "sand", Math.round(25 * density), new THREE.BoxGeometry(0.34, 0.035, 0.22), new THREE.MeshStandardMaterial({ color: 0xcab275, roughness: 0.98 }), { yOffset: 0.045, minScale: 0.52, maxScale: 1.34, lowShard: true, stretchX: 1.5, stretchZ: 0.75 });
  }

  addInstancedProps(name, typeIds, count, geometry, material, options = {}) {
    this.ownedGeometries.push(geometry);
    this.ownedMaterials.push(material);
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = `terrain-${name}`;
    mesh.frustumCulled = true;
    mesh.castShadow = Boolean(options.castShadow) && this.sim.quality.shadowQuality !== "off";
    mesh.receiveShadow = Boolean(options.receiveShadow);
    const targets = Array.isArray(typeIds) ? typeIds : [typeIds];
    const minScale = options.minScale ?? 0.72;
    const maxScale = options.maxScale ?? 1.42;
    const yOffset = options.yOffset ?? 0.045;
    const attempts = Math.max(count * 12, count + 120);
    const place = (x, z) => {
      const type = this.sampleType(x, z);
      if (!targets.includes(type.id)) return false;
      const yaw = this.random() * Math.PI * 2;
      const s = minScale + this.random() * (maxScale - minScale);
      const footprintScale = Math.max(options.stretchX ?? 1, options.stretchY ?? 1, options.stretchZ ?? 1);
      const clearanceRadius = (options.clearanceRadius ?? 0) * s * footprintScale;
      const h = clearanceRadius > 0 ? this.sampleMaxHeightAround(x, z, clearanceRadius) : this.sampleHeight(x, z);
      this.dummy.position.set(x, h + yOffset, z);
      if (options.flat) {
        const tilt = options.tilt ?? 0.16;
        this.dummy.rotation.set(-Math.PI / 2 + (this.random() - 0.5) * tilt, (this.random() - 0.5) * tilt, yaw);
      } else if (options.layCylinder) {
        const liftVariance = options.liftVariance ?? 0.08;
        this.propDirection.set(Math.sin(yaw), (this.random() - 0.5) * liftVariance, Math.cos(yaw)).normalize();
        this.dummy.quaternion.setFromUnitVectors(this.propUp, this.propDirection);
      } else if (options.tumble) {
        this.dummy.rotation.set(this.random() * Math.PI, this.random() * Math.PI * 2, this.random() * Math.PI);
      } else if (options.lowShard) {
        const tilt = options.tilt ?? 0.22;
        this.dummy.rotation.set((this.random() - 0.5) * tilt, yaw, (this.random() - 0.5) * tilt);
      } else if (options.upright) {
        const tilt = options.tilt ?? 0.18;
        this.dummy.rotation.set((this.random() - 0.5) * tilt, yaw, (this.random() - 0.5) * tilt);
      } else {
        this.dummy.rotation.set(0, yaw, 0);
      }
      this.dummy.scale.set(s * (options.stretchX ?? 1), s * (options.stretchY ?? 1), s * (options.stretchZ ?? 1));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(placed, this.dummy.matrix);
      if (options.colorJitter && material.color) {
        this.propColor.copy(material.color).offsetHSL((this.random() - 0.5) * options.colorJitter, (this.random() - 0.5) * options.colorJitter, (this.random() - 0.5) * options.colorJitter);
        mesh.setColorAt(placed, this.propColor);
      }
      this.registerInstancedPropCollider(name, x, z, yaw, s, h, yOffset, options);
      placed += 1;
      return true;
    };
    let placed = 0;
    for (let attempt = 0; attempt < attempts && placed < count; attempt += 1) {
      const angle = this.random() * Math.PI * 2;
      const radius = Math.sqrt(this.random()) * this.sim.worldRadius;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      place(x, z);
    }
    if (placed < count) {
      const targetIndexes = new Set(targets.map((id) => TERRAIN_TYPES[id]?.index).filter((index) => index != null));
      const stride = this.complexity === "high" ? 2 : 3;
      const startGX = Math.floor(this.random() * stride);
      const startGZ = Math.floor(this.random() * stride);
      for (let gz = startGZ; gz < this.resolution && placed < count; gz += stride) {
        const row = gz * this.resolution;
        for (let gx = startGX; gx < this.resolution && placed < count; gx += stride) {
          const index = row + gx;
          if (!targetIndexes.has(this.terrainType[index])) continue;
          const x = (gx + this.random()) * this.cellSize - this.fieldRadius;
          const z = (gz + this.random()) * this.cellSize - this.fieldRadius;
          if (Math.hypot(x, z) > this.sim.worldRadius - 1) continue;
          place(x, z);
        }
      }
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.propInstanceCount += placed;
    this.sim.scene.add(mesh);
    this.visuals.push(mesh);
  }

  addFeaturedRocks() {
    const nest = this.sim.nest;
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    const material = new THREE.MeshStandardMaterial({ color: 0xa8a390, roughness: 0.94, flatShading: true });
    this.ownedGeometries.push(geometry);
    this.ownedMaterials.push(material);

    const specs = [
      { x: 42, z: -44, scale: [9.0, 1.35, 5.8], rot: [0.34, 0.8, -0.16] },
      { x: -58, z: 78, scale: [6.8, 1.08, 4.4], rot: [0.24, -2.2, -0.18] },
    ];
    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    mesh.name = "terrain-featuredRocks";
    mesh.frustumCulled = true;
    mesh.castShadow = this.sim.quality.shadowQuality !== "off";
    mesh.receiveShadow = false;
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      const x = nest.x + spec.x;
      const z = nest.z + spec.z;
      this.dummy.position.set(x, this.sampleHeight(x, z) + spec.scale[1] * 0.92, z);
      this.dummy.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      this.dummy.scale.set(spec.scale[0], spec.scale[1], spec.scale[2]);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.propInstanceCount += specs.length;
    this.sim.scene.add(mesh);
    this.visuals.push(mesh);
  }

  addFeaturedClutter(leafMaterial, branchMaterial) {
    const nest = this.sim.nest;
    const leafGeometry = createCurledLeafGeometry(14.2, 6.2, 18, 7);
    const branchGeometry = createBroadleafBranchGeometry(58, 0.82, 0.34, { radialSegments: 12, lengthSegments: 22, bendX: 0.18, bendZ: 0.06, forked: true });
    const shadowGeometry = new THREE.CircleGeometry(1, 32);
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x1b1108, transparent: true, opacity: 0.18, depthWrite: false });
    this.ownedGeometries.push(leafGeometry, branchGeometry, shadowGeometry);
    this.ownedMaterials.push(shadowMaterial);

    const leafSpecs = [
      { x: 28, z: -32, yaw: 0.72, scale: 4.8, tilt: 0.055 },
      { x: -72, z: -34, yaw: 1.1, scale: 3.2, tilt: 0.04 },
    ];
    const leafMesh = new THREE.InstancedMesh(leafGeometry, leafMaterial, leafSpecs.length);
    leafMesh.name = "terrain-featuredLeaves";
    leafMesh.frustumCulled = true;
    leafMesh.castShadow = this.sim.quality.shadowQuality !== "off";
    leafMesh.receiveShadow = false;
    for (let i = 0; i < leafSpecs.length; i += 1) {
      const spec = leafSpecs[i];
      const x = nest.x + spec.x;
      const z = nest.z + spec.z;
      this.dummy.position.set(x, this.sampleMaxHeightAround(x, z, spec.scale * 5.4) + 0.95, z);
      this.dummy.rotation.set(-Math.PI / 2 + spec.tilt, spec.tilt * 0.16, spec.yaw);
      this.dummy.scale.setScalar(spec.scale);
      this.dummy.updateMatrix();
      leafMesh.setMatrixAt(i, this.dummy.matrix);
      const dirX = Math.cos(spec.yaw);
      const dirZ = Math.sin(spec.yaw);
      const halfLength = 14.2 * spec.scale * 0.5;
      const halfWidth = 6.2 * spec.scale * 0.5;
      this.registerPropCollider({
        kind: "leaf",
        name: "featuredLeaves",
        x,
        z,
        dirX,
        dirZ,
        sideX: -dirZ,
        sideZ: dirX,
        halfLength,
        halfWidth,
        surfaceY: this.dummy.position.y + 0.22,
        crown: 0.32,
        boundsRadius: Math.hypot(halfLength, halfWidth) + 2,
      });
    }
    leafMesh.instanceMatrix.needsUpdate = true;
    this.propInstanceCount += leafSpecs.length;
    this.sim.scene.add(leafMesh);
    this.visuals.push(leafMesh);

    const branchSpecs = [
      { x: 22, z: -54, yaw: 0.52, length: 58, radius: 0.82, slope: 0.03 },
    ];
    const branchMesh = new THREE.InstancedMesh(branchGeometry, branchMaterial, branchSpecs.length);
    branchMesh.name = "terrain-featuredBranches";
    branchMesh.frustumCulled = true;
    branchMesh.castShadow = this.sim.quality.shadowQuality !== "off";
    branchMesh.receiveShadow = false;
    for (let i = 0; i < branchSpecs.length; i += 1) {
      const spec = branchSpecs[i];
      const x = nest.x + spec.x;
      const z = nest.z + spec.z;
      this.propDirection.set(Math.sin(spec.yaw), spec.slope, Math.cos(spec.yaw)).normalize();
      this.dummy.position.set(x, this.sampleMaxHeightAround(x, z, spec.length * 0.42) + spec.radius * 2.1 + 0.65, z);
      this.dummy.quaternion.setFromUnitVectors(this.propUp, this.propDirection);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      branchMesh.setMatrixAt(i, this.dummy.matrix);
      this.registerPropCollider({
        kind: "branch",
        name: "featuredBranches",
        x,
        z,
        dirX: this.propDirection.x,
        dirZ: this.propDirection.z,
        halfLength: spec.length * 0.5,
        radius: spec.radius,
        avoidRadius: spec.radius + 0.6,
        climbable: true,
        surfaceY: this.dummy.position.y + spec.radius * 0.75,
        crown: spec.radius * 0.18,
        boundsRadius: spec.length * 0.5 + spec.radius + 2,
      });
    }
    branchMesh.instanceMatrix.needsUpdate = true;
    this.propInstanceCount += branchSpecs.length;
    this.sim.scene.add(branchMesh);
    this.visuals.push(branchMesh);

    const shadowMesh = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, leafSpecs.length + branchSpecs.length);
    shadowMesh.name = "terrain-featuredContactShadows";
    shadowMesh.frustumCulled = true;
    shadowMesh.renderOrder = 1;
    for (let i = 0; i < leafSpecs.length; i += 1) {
      const spec = leafSpecs[i];
      const x = nest.x + spec.x;
      const z = nest.z + spec.z;
      this.dummy.position.set(x, this.sampleHeight(x, z) + 0.045, z);
      this.dummy.rotation.set(-Math.PI / 2, 0, spec.yaw);
      this.dummy.scale.set(spec.scale * 6.1, spec.scale * 2.35, 1);
      this.dummy.updateMatrix();
      shadowMesh.setMatrixAt(i, this.dummy.matrix);
    }
    for (let i = 0; i < branchSpecs.length; i += 1) {
      const spec = branchSpecs[i];
      const x = nest.x + spec.x;
      const z = nest.z + spec.z;
      this.dummy.position.set(x, this.sampleHeight(x, z) + 0.048, z);
      this.dummy.rotation.set(-Math.PI / 2, 0, spec.yaw);
      this.dummy.scale.set(spec.length * 0.54, spec.radius * 2.8, 1);
      this.dummy.updateMatrix();
      shadowMesh.setMatrixAt(leafSpecs.length + i, this.dummy.matrix);
    }
    shadowMesh.instanceMatrix.needsUpdate = true;
    this.sim.scene.add(shadowMesh);
    this.visuals.push(shadowMesh);
  }

  addRootProps(segmentCount, knotCount) {
    const segmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    const segmentMaterial = new THREE.MeshStandardMaterial({ color: 0xa87442, roughness: 0.95 });
    const segmentMesh = new THREE.InstancedMesh(segmentGeometry, segmentMaterial, segmentCount);
    segmentMesh.name = "terrain-rootSegment";
    segmentMesh.frustumCulled = true;
    segmentMesh.castShadow = false;
    segmentMesh.receiveShadow = false;
    this.ownedGeometries.push(segmentGeometry);
    this.ownedMaterials.push(segmentMaterial);

    let placedSegments = 0;
    for (let attempt = 0; attempt < segmentCount * 10 && placedSegments < segmentCount; attempt += 1) {
      const root = this.rootSegments[Math.floor(this.random() * this.rootSegments.length)];
      if (!root) break;
      const t = this.random();
      const length = 4.0 + this.random() * 10.0;
      const dx = root.x2 - root.x1;
      const dz = root.z2 - root.z1;
      const rootLength = Math.hypot(dx, dz) || 1;
      const dirX = dx / rootLength;
      const dirZ = dz / rootLength;
      const x = root.x1 + dx * t + (this.random() - 0.5) * root.width * 0.38;
      const z = root.z1 + dz * t + (this.random() - 0.5) * root.width * 0.38;
      if (Math.hypot(x, z) > this.sim.worldRadius - 2) continue;
      if (this.sampleType(x, z).id !== "root") continue;
      const radius = 0.12 + this.random() * 0.32;
      this.propDirection.set(dirX, 0.05 + (this.random() - 0.5) * 0.04, dirZ).normalize();
      this.dummy.position.set(x, this.sampleHeight(x, z) + radius * 0.82, z);
      this.dummy.quaternion.setFromUnitVectors(this.propUp, this.propDirection);
      this.dummy.scale.set(radius, length, radius * (0.78 + this.random() * 0.32));
      this.dummy.updateMatrix();
      segmentMesh.setMatrixAt(placedSegments, this.dummy.matrix);
      placedSegments += 1;
    }
    segmentMesh.count = placedSegments;
    segmentMesh.instanceMatrix.needsUpdate = true;
    this.propInstanceCount += placedSegments;
    this.sim.scene.add(segmentMesh);
    this.visuals.push(segmentMesh);

    const knotGeometry = new THREE.DodecahedronGeometry(0.34, 0);
    const knotMaterial = new THREE.MeshStandardMaterial({ color: 0x9b6840, roughness: 0.98 });
    this.addInstancedProps("rootKnot", "root", knotCount, knotGeometry, knotMaterial, { yOffset: 0.42, minScale: 1.0, maxScale: 3.2, tumble: true, stretchY: 0.72 });
  }
}

const PHEROMONE_FIELD_MODES = ["off", "food", "alarm", "avoid", "rescue", "all"];
const PHEROMONE_FIELD_CHANNELS = ["food", "trunk", "alarm", "avoid", "rescue"];
const PHEROMONE_FIELD_PARAMS = {
  food: { decay: 0.16, diffusion: 0.025, color: [255, 178, 32], maxAlpha: 232 },
  trunk: { decay: 0.018, diffusion: 0.01, color: [255, 230, 74], maxAlpha: 172 },
  alarm: { decay: 0.45, diffusion: 0.035, color: [255, 58, 42], maxAlpha: 232 },
  avoid: { decay: 0.2, diffusion: 0.025, color: [48, 196, 255], maxAlpha: 218 },
  rescue: { decay: 0.22, diffusion: 0.025, color: [46, 230, 128], maxAlpha: 224 },
};

class PheromoneFieldSystem {
  constructor(sim, options = {}) {
    this.sim = sim;
    this.resolution = options.resolution ?? (sim.worldRadius > 140 ? 160 : 128);
    this.fieldRadius = options.fieldRadius ?? sim.worldRadius + (sim.fieldMargin ?? 12);
    this.visualRadius = options.visualRadius ?? sim.worldRadius;
    this.fieldSize = this.fieldRadius * 2;
    this.cellSize = this.fieldSize / this.resolution;
    this.invCellSize = 1 / this.cellSize;
    this.maxValue = options.maxValue ?? 3;
    this.fields = {};
    this.scratch = {};
    this.mode = "off";
    this.dirty = true;
    this.diffusionFrame = 0;
    this.visualAccumulator = 0;
    this.visualInterval = 0.1;
    this.visualSegments = options.visualSegments ?? (sim.quality.effectsQuality >= 0.95 ? 96 : 64);
    this.gridScratch = { gx: 0, gz: 0 };
    this.gradientScratch = { x: 0, z: 0 };
    this.antennaeScratch = { left: 0, right: 0, front: 0, peak: 0, turn: 0, strength: 0 };
    this.terrainDecay = null;
    this.terrainDiffusion = null;
    this.terrainScratch = { decay: 1, diffusion: 1 };

    const size = this.resolution * this.resolution;
    for (const channel of PHEROMONE_FIELD_CHANNELS) {
      this.fields[channel] = new Float32Array(size);
      this.scratch[channel] = new Float32Array(size);
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.resolution;
    this.canvas.height = this.resolution;
    this.context = this.canvas.getContext("2d", { willReadFrequently: false });
    this.imageData = this.context.createImageData(this.resolution, this.resolution);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = true;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.geometry = new THREE.PlaneGeometry(this.fieldSize, this.fieldSize, this.visualSegments, this.visualSegments);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this.overlay = new THREE.Mesh(this.geometry, this.material);
    this.overlay.rotation.x = -Math.PI / 2;
    this.overlay.position.y = 0;
    this.overlay.renderOrder = 2;
    this.overlay.visible = false;
    this.overlay.matrixAutoUpdate = false;
    this.refreshTerrainGeometry();
    this.overlay.updateMatrix();
    sim.scene.add(this.overlay);
    this.refreshTerrainModifiers();
  }

  reset() {
    for (const channel of PHEROMONE_FIELD_CHANNELS) this.fields[channel].fill(0);
    this.dirty = true;
    this.visualAccumulator = this.visualInterval;
    this.updateVisualization(true);
  }

  dispose() {
    if (this.overlay) this.sim.scene.remove(this.overlay);
    this.geometry?.dispose();
    this.material?.dispose();
    this.texture?.dispose();
    this.terrainDecay = null;
    this.terrainDiffusion = null;
    this.overlay = null;
    this.geometry = null;
    this.material = null;
    this.texture = null;
  }

  refreshTerrainModifiers() {
    const terrain = this.sim.terrain;
    if (!terrain) {
      this.terrainDecay = null;
      this.terrainDiffusion = null;
      return;
    }
    const size = this.resolution * this.resolution;
    if (!this.terrainDecay || this.terrainDecay.length !== size) {
      this.terrainDecay = new Float32Array(size);
      this.terrainDiffusion = new Float32Array(size);
    }
    for (let gz = 0; gz < this.resolution; gz += 1) {
      const z = (gz + 0.5) * this.cellSize - this.fieldRadius;
      const row = gz * this.resolution;
      for (let gx = 0; gx < this.resolution; gx += 1) {
        const x = (gx + 0.5) * this.cellSize - this.fieldRadius;
        const modifiers = terrain.samplePheromoneModifiers(x, z);
        const index = row + gx;
        this.terrainDecay[index] = modifiers.decay;
        this.terrainDiffusion[index] = modifiers.diffusion;
      }
    }
  }

  refreshTerrainGeometry() {
    if (!this.geometry) return;
    const terrain = this.sim.terrain;
    const positions = this.geometry.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      const x = positions.getX(i);
      const z = -positions.getY(i);
      const y = terrain ? terrain.sampleHeight(x, z) + 0.08 : 0.08;
      positions.setZ(i, y);
    }
    positions.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  update(dt) {
    let changed = false;
    for (const channel of PHEROMONE_FIELD_CHANNELS) {
      const field = this.fields[channel];
      const decay = PHEROMONE_FIELD_PARAMS[channel].decay * dt;
      const decayFactor = Math.max(0, 1 - decay);
      const terrainDecay = this.terrainDecay;
      for (let i = 0; i < field.length; i += 1) {
        const value = field[i];
        if (value <= 0) continue;
        const next = terrainDecay ? value * Math.max(0, 1 - decay * terrainDecay[i]) : value * decayFactor;
        field[i] = next < 0.0004 ? 0 : next;
        changed = true;
      }
    }

    this.diffusionFrame = (this.diffusionFrame + 1) % 3;
    if (this.diffusionFrame === 0) {
      for (const channel of PHEROMONE_FIELD_CHANNELS) {
        this.diffuse(channel, PHEROMONE_FIELD_PARAMS[channel].diffusion);
      }
      changed = true;
    }

    if (changed) this.dirty = true;
    if (this.mode === "off") return;
    this.visualAccumulator += dt;
    if (this.visualAccumulator >= this.visualInterval) {
      this.updateVisualization();
      this.visualAccumulator = 0;
    }
  }

  diffuse(channel, amount) {
    if (amount <= 0) return;
    const field = this.fields[channel];
    const scratch = this.scratch[channel];
    const r = this.resolution;
    const blend = clamp(amount, 0, 0.2);
    const keep = 1 - blend;
    const terrainDiffusion = this.terrainDiffusion;
    scratch.set(field);
    for (let z = 1; z < r - 1; z += 1) {
      const row = z * r;
      for (let x = 1; x < r - 1; x += 1) {
        const i = row + x;
        if (terrainDiffusion) {
          const localBlend = clamp(amount * terrainDiffusion[i], 0, 0.2);
          scratch[i] = field[i] * (1 - localBlend) + (field[i - 1] + field[i + 1] + field[i - r] + field[i + r]) * localBlend * 0.25;
        } else {
          scratch[i] = field[i] * keep + (field[i - 1] + field[i + 1] + field[i - r] + field[i + r]) * blend * 0.25;
        }
      }
    }
    field.set(scratch);
  }

  worldToGrid(x, z, target = this.gridScratch) {
    target.gx = (x + this.fieldRadius) * this.invCellSize - 0.5;
    target.gz = (z + this.fieldRadius) * this.invCellSize - 0.5;
    return target;
  }

  deposit(channel, x, z, strength, radius = 2.5) {
    this.depositGaussian(channel, x, z, strength, radius);
  }

  dampen(channel, x, z, amount, radius) {
    const field = this.fields[channel];
    if (!field || amount <= 0 || radius <= 0) return;
    const grid = this.worldToGrid(x, z);
    const cellRadius = Math.ceil(radius * this.invCellSize) + 1;
    const minX = clamp(Math.floor(grid.gx) - cellRadius, 0, this.resolution - 1);
    const maxX = clamp(Math.floor(grid.gx) + cellRadius, 0, this.resolution - 1);
    const minZ = clamp(Math.floor(grid.gz) - cellRadius, 0, this.resolution - 1);
    const maxZ = clamp(Math.floor(grid.gz) + cellRadius, 0, this.resolution - 1);
    const dampenAmount = clamp(amount, 0, 1);
    for (let gz = minZ; gz <= maxZ; gz += 1) {
      const wz = (gz + 0.5) * this.cellSize - this.fieldRadius;
      const dz = wz - z;
      const row = gz * this.resolution;
      for (let gx = minX; gx <= maxX; gx += 1) {
        const wx = (gx + 0.5) * this.cellSize - this.fieldRadius;
        const dx = wx - x;
        const distance = Math.hypot(dx, dz);
        if (distance > radius) continue;
        const falloff = (1 - distance / radius) ** 2;
        const index = row + gx;
        field[index] *= 1 - dampenAmount * falloff;
      }
    }
    this.dirty = true;
  }

  depositGaussian(channel, x, z, strength, radius) {
    const field = this.fields[channel];
    if (!field || strength <= 0 || radius <= 0) return;
    let writeStrength = strength;
    let writeRadius = radius;
    const terrain = this.sim.terrain;
    if (terrain?.effectsEnabled) {
      const modifiers = terrain.samplePheromoneModifiers(x, z, this.terrainScratch);
      const terrainType = terrain.sampleType(x, z);
      writeStrength *= clamp(1 / modifiers.decay, 0.55, 1.45);
      writeRadius *= clamp(modifiers.diffusion, 0.72, 1.35);
      if (terrainType.id === "puddle") {
        if (channel === "avoid") writeStrength *= 1.35;
        else if (channel === "food" || channel === "trunk") writeStrength *= 0.2;
      }
    }
    const grid = this.worldToGrid(x, z);
    const cellRadius = Math.ceil(writeRadius * this.invCellSize) + 1;
    const minX = clamp(Math.floor(grid.gx) - cellRadius, 0, this.resolution - 1);
    const maxX = clamp(Math.floor(grid.gx) + cellRadius, 0, this.resolution - 1);
    const minZ = clamp(Math.floor(grid.gz) - cellRadius, 0, this.resolution - 1);
    const maxZ = clamp(Math.floor(grid.gz) + cellRadius, 0, this.resolution - 1);
    const sigma = Math.max(this.cellSize * 0.75, writeRadius * 0.45);
    const sigma2 = sigma * sigma;
    const radius2 = writeRadius * writeRadius;

    for (let gz = minZ; gz <= maxZ; gz += 1) {
      const wz = (gz + 0.5) * this.cellSize - this.fieldRadius;
      const dz = wz - z;
      const row = gz * this.resolution;
      for (let gx = minX; gx <= maxX; gx += 1) {
        const wx = (gx + 0.5) * this.cellSize - this.fieldRadius;
        const dx = wx - x;
        const dist2Value = dx * dx + dz * dz;
        if (dist2Value > radius2) continue;
        const falloff = Math.exp(-dist2Value / (2 * sigma2));
        const index = row + gx;
        field[index] = Math.min(this.maxValue, field[index] + writeStrength * falloff);
      }
    }
    this.dirty = true;
  }

  sample(channel, x, z) {
    const field = this.fields[channel];
    if (!field) return 0;
    const grid = this.worldToGrid(x, z);
    if (grid.gx < 0 || grid.gz < 0 || grid.gx > this.resolution - 1 || grid.gz > this.resolution - 1) return 0;
    const x0 = clamp(Math.floor(grid.gx), 0, this.resolution - 2);
    const z0 = clamp(Math.floor(grid.gz), 0, this.resolution - 2);
    const tx = clamp(grid.gx - x0, 0, 1);
    const tz = clamp(grid.gz - z0, 0, 1);
    const row = z0 * this.resolution;
    const i00 = row + x0;
    const i10 = i00 + 1;
    const i01 = i00 + this.resolution;
    const i11 = i01 + 1;
    const a = field[i00] * (1 - tx) + field[i10] * tx;
    const b = field[i01] * (1 - tx) + field[i11] * tx;
    return a * (1 - tz) + b * tz;
  }

  sampleGradient(channel, x, z, target = this.gradientScratch) {
    const step = this.cellSize * 1.4;
    target.x = (this.sample(channel, x + step, z) - this.sample(channel, x - step, z)) / (step * 2);
    target.z = (this.sample(channel, x, z + step) - this.sample(channel, x, z - step)) / (step * 2);
    return target;
  }

  sampleAntennae(channel, x, z, angle, options = null) {
    const lookAhead = options?.lookAhead ?? 5.2;
    const sideAngle = options?.antennaAngle ?? 0.65;
    const threshold = options?.threshold ?? 0.025;
    const fx = x + Math.sin(angle) * lookAhead;
    const fz = z + Math.cos(angle) * lookAhead;
    const la = angle + sideAngle;
    const ra = angle - sideAngle;
    const lx = x + Math.sin(la) * lookAhead;
    const lz = z + Math.cos(la) * lookAhead;
    const rx = x + Math.sin(ra) * lookAhead;
    const rz = z + Math.cos(ra) * lookAhead;
    const scratch = this.antennaeScratch;
    scratch.left = this.sample(channel, lx, lz);
    scratch.right = this.sample(channel, rx, rz);
    scratch.front = this.sample(channel, fx, fz);
    scratch.peak = Math.max(scratch.left, scratch.right, scratch.front);
    scratch.turn = (scratch.right - scratch.left) / (scratch.left + scratch.right + 0.001);
    scratch.strength = Math.max(0, scratch.peak - threshold);
    return scratch;
  }

  setVisualizationMode(mode) {
    this.mode = PHEROMONE_FIELD_MODES.includes(mode) ? mode : "off";
    if (this.overlay) this.overlay.visible = this.mode !== "off";
    this.dirty = true;
    this.visualAccumulator = this.visualInterval;
    this.updateVisualization(true);
    return this.mode;
  }

  cycleVisualizationMode() {
    const index = PHEROMONE_FIELD_MODES.indexOf(this.mode);
    return this.setVisualizationMode(PHEROMONE_FIELD_MODES[(index + 1) % PHEROMONE_FIELD_MODES.length]);
  }

  updateVisualization(force = false) {
    if (!this.overlay || !this.texture) return;
    if (this.mode === "off") {
      this.overlay.visible = false;
      return;
    }
    if (!force && !this.dirty) return;
    this.overlay.visible = true;
    const data = this.imageData.data;
    const r = this.resolution;
    data.fill(0);

    const visualRadius2 = this.visualRadius * this.visualRadius;
    for (let y = 0; y < r; y += 1) {
      const sourceRow = y * r;
      const pixelRow = y * r * 4;
      const wz = (y + 0.5) * this.cellSize - this.fieldRadius;
      for (let x = 0; x < r; x += 1) {
        const wx = (x + 0.5) * this.cellSize - this.fieldRadius;
        if (wx * wx + wz * wz > visualRadius2) continue;
        const fieldIndex = sourceRow + x;
        const pixelIndex = pixelRow + x * 4;
        if (this.mode === "all") {
          this.writeCombinedPixel(data, pixelIndex, fieldIndex);
        } else if (this.mode === "food") {
          this.writeFoodPixel(data, pixelIndex, fieldIndex);
        } else {
          this.writeSinglePixel(data, pixelIndex, fieldIndex, this.mode);
        }
      }
    }

    this.context.putImageData(this.imageData, 0, 0);
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  channelAlpha(channel, value) {
    if (value <= 0.0005) return 0;
    const params = PHEROMONE_FIELD_PARAMS[channel];
    return clamp(Math.pow(value / this.maxValue, 0.32) * params.maxAlpha, 0, params.maxAlpha);
  }

  writeSinglePixel(data, pixelIndex, fieldIndex, channel) {
    const value = this.fields[channel]?.[fieldIndex] ?? 0;
    const alpha = this.channelAlpha(channel, value);
    if (alpha <= 0) return;
    const color = PHEROMONE_FIELD_PARAMS[channel].color;
    data[pixelIndex] = color[0];
    data[pixelIndex + 1] = color[1];
    data[pixelIndex + 2] = color[2];
    data[pixelIndex + 3] = alpha;
  }

  writeFoodPixel(data, pixelIndex, fieldIndex) {
    const foodAlpha = this.channelAlpha("food", this.fields.food[fieldIndex]);
    const trunkAlpha = this.channelAlpha("trunk", this.fields.trunk[fieldIndex]);
    const totalAlpha = Math.min(242, foodAlpha + trunkAlpha * 0.9);
    if (totalAlpha <= 0) return;
    const foodColor = PHEROMONE_FIELD_PARAMS.food.color;
    const trunkColor = PHEROMONE_FIELD_PARAMS.trunk.color;
    const denom = foodAlpha + trunkAlpha || 1;
    data[pixelIndex] = (foodColor[0] * foodAlpha + trunkColor[0] * trunkAlpha) / denom;
    data[pixelIndex + 1] = (foodColor[1] * foodAlpha + trunkColor[1] * trunkAlpha) / denom;
    data[pixelIndex + 2] = (foodColor[2] * foodAlpha + trunkColor[2] * trunkAlpha) / denom;
    data[pixelIndex + 3] = totalAlpha;
  }

  writeCombinedPixel(data, pixelIndex, fieldIndex) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (const channel of PHEROMONE_FIELD_CHANNELS) {
      const channelAlpha = this.channelAlpha(channel, this.fields[channel][fieldIndex]);
      if (channelAlpha <= 0) continue;
      const color = PHEROMONE_FIELD_PARAMS[channel].color;
      red += color[0] * channelAlpha;
      green += color[1] * channelAlpha;
      blue += color[2] * channelAlpha;
      alpha += channelAlpha;
    }
    if (alpha <= 0) return;
    data[pixelIndex] = red / alpha;
    data[pixelIndex + 1] = green / alpha;
    data[pixelIndex + 2] = blue / alpha;
    data[pixelIndex + 3] = clamp(alpha, 0, 244);
  }
}

class FoodSpawner {
  constructor(sim) {
    this.sim = sim;
    this.enabled = readStorage("ant3d.naturalFoodEnabled") !== "0";
    this.rate = FOOD_SPAWN_PRESETS[readStorage("ant3d.naturalFoodRate")] ? readStorage("ant3d.naturalFoodRate") : "medium";
    this.timer = 0;
    this.spawnWeights = [];
    this.totalWeight = 0;
    this.rebuildWeights();
    this.reset();
  }

  rebuildWeights() {
    this.spawnWeights = [];
    this.totalWeight = 0;
    for (const type of FOOD_TYPE_ORDER) {
      const config = FOOD_TYPES[type];
      if (!config.spawnWeight || config.spawnWeight <= 0) continue;
      this.totalWeight += config.spawnWeight;
      this.spawnWeights.push({ type, threshold: this.totalWeight });
    }
  }

  reset() {
    this.timer = rand(2.5, 6.5);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    writeStorage("ant3d.naturalFoodEnabled", this.enabled ? "1" : "0");
    if (this.enabled && this.timer <= 0) this.reset();
  }

  setRate(rate) {
    this.rate = FOOD_SPAWN_PRESETS[rate] ? rate : "medium";
    writeStorage("ant3d.naturalFoodRate", this.rate);
    this.timer = Math.min(this.timer, this.nextInterval());
  }

  currentPreset() {
    return FOOD_SPAWN_PRESETS[this.rate] ?? FOOD_SPAWN_PRESETS.medium;
  }

  nextInterval() {
    const preset = this.currentPreset();
    return rand(preset.intervalMin, preset.intervalMax);
  }

  update(dt) {
    if (!this.enabled) return;
    const preset = this.currentPreset();
    const naturalCount = this.sim.food.reduce((count, food) => count + (food.natural ? 1 : 0), 0);
    if (naturalCount >= preset.maxNatural) {
      this.timer = Math.max(this.timer, 4);
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    if (this.spawnNaturalFood()) this.timer = this.nextInterval();
    else this.timer = rand(4, 8);
  }

  chooseType() {
    if (this.totalWeight <= 0) return DEFAULT_FOOD_TYPE.id;
    const roll = Math.random() * this.totalWeight;
    const match = this.spawnWeights.find((entry) => roll <= entry.threshold);
    return match?.type ?? this.spawnWeights[this.spawnWeights.length - 1]?.type ?? DEFAULT_FOOD_TYPE.id;
  }

  spawnNaturalFood() {
    const type = this.chooseType();
    const config = getFoodType(type);
    const intensity = rand(1.2, 4.8);
    const amountScale = rand(0.78, 1.24);
    const radiusScale = rand(0.9, 1.15);
    const spawnRadius = (config.radiusBase + intensity * config.radiusPerIntensity) * radiusScale;
    const point = this.findSpawnPoint(spawnRadius, config.category);
    if (!point) return false;
    this.sim.addFood(point.x, point.z, type, {
      source: "natural",
      natural: true,
      intensity,
      amountScale,
      radiusScale,
    });
    return true;
  }

  findSpawnPoint(spawnRadius, category = "mixed") {
    const usableRadius = this.sim.worldRadius - spawnRadius - 4;
    if (usableRadius <= this.sim.nest.radius + spawnRadius + 8) return null;
    const terrainPoint = this.sim.terrain?.findSpawnPoint(category, spawnRadius, (x, z) => this.isClear(x, z, spawnRadius));
    if (terrainPoint) return terrainPoint;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const angle = rand(0, Math.PI * 2);
      const radius = Math.sqrt(Math.random()) * usableRadius;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (this.isClear(x, z, spawnRadius)) return { x, z };
    }
    return null;
  }

  isClear(x, z, spawnRadius) {
    if (Math.hypot(x, z) + spawnRadius > this.sim.worldRadius - 2) return false;
    if (distance2(x, z, this.sim.nest.x, this.sim.nest.z) < this.sim.nest.radius + spawnRadius + 10) return false;
    if (this.sim.terrain?.isBlockedArea(x, z, spawnRadius)) return false;
    for (const food of this.sim.food) {
      if (distance2(x, z, food.x, food.z) < food.radius + spawnRadius + 8) return false;
    }
    for (const patch of this.sim.water) {
      if (distance2(x, z, patch.x, patch.z) < patch.radius + spawnRadius + 5) return false;
    }
    for (const stone of this.sim.stones) {
      if (distance2(x, z, stone.x, stone.z) < stone.radius + spawnRadius + 5) return false;
    }
    for (const branch of this.sim.branches) {
      const point = closestPointOnSegment(x, z, branch.x1, branch.z1, branch.x2, branch.z2);
      if (distance2(x, z, point.x, point.z) < branch.width + spawnRadius + 5) return false;
    }
    return true;
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
    this.spatialGridX = 0;
    this.spatialGridZ = 0;
    this.angle = rand(0, Math.PI * 2);
    this.turnBias = rand(-0.4, 0.4);
    this.baseSpeed = rand(8.5, 15.5);
    this.state = "explore";
    this.stateTime = 0;
    this.wander = rand(0, Math.PI * 2);
    this.wet = 0;
    this.stun = 0;
    this.carrying = 0;
    this.carryingFoodType = null;
    this.carryingLoad = 0;
    this.carryingFoodValue = 0;
    this.carryingFoodQuality = 1;
    this.foodSourceId = null;
    this.targetFoodId = null;
    this.harvestTimer = 0;
    this.energy = rand(0.55, 1);
    this.lastTrail = rand(0, 1);
    this.homeTimer = rand(0, 8);
    this.rescueTarget = null;
    this.trailFollowing = 0;
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
      foodScore: 0,
      terrainDetection: 1,
      terrainRoughness: 0,
      terrainMovement: 1,
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

    this.fieldGradient = { x: 0, z: 0 };
    this.propSurface = { hit: false, y: 0, slow: 1, pitch: 0, roll: 0, kind: null, climbable: false, edgeFactor: 0 };
    this.branchSurface = { hit: false, y: 0, slow: 1, pitch: 0, roll: 0, kind: null, climbable: false, edgeFactor: 0 };
    this.surfaceY = sim.getSurfaceY(this.x, this.z, 0.72);
    this.surfacePitch = 0;
    this.surfaceRoll = 0;
    this.surfaceSlow = 1;
    this.surfaceKind = null;
    this.insideNest = false;
    this.nestTimer = 0;
    this.renderStateScratch = {
      x: this.x,
      z: this.z,
      angle: this.angle,
      y: 0,
      scale: 1,
      pitch: 0,
      roll: 0,
      yawSin: 0,
      yawCos: 1,
      pitchSin: 0,
      pitchCos: 1,
      rollSin: 0,
      rollCos: 1,
      state: this.state,
      carrying: 0,
    };
    this.foodAntennaeOptions = {
      lookAhead: 4.8 + this.traits.curiosity * 2.4,
      antennaAngle: 0.58,
      threshold: 0.018,
    };
    this.trunkAntennaeOptions = {
      lookAhead: 7.2 + this.traits.social * 2.2,
      antennaAngle: 0.66,
      threshold: 0.012,
    };
    this.returnTrunkAntennaeOptions = {
      lookAhead: 5.6,
      antennaAngle: 0.55,
      threshold: 0.015,
    };
    this.returnFoodAntennaeOptions = {
      lookAhead: 4.8,
      antennaAngle: 0.52,
      threshold: 0.025,
    };
    const nestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z);
    const startsInNest = nestDistance < sim.nest.radius * HOMING_PARAMS.pathResetRadiusMultiplier;
    this.pathX = startsInNest ? 0 : this.x - sim.nest.x;
    this.pathZ = startsInNest ? 0 : this.z - sim.nest.z;
    this.pathError = rand(0.2, 0.8);
    this.homingConfidence = 1;
    this.pathDrift = rand(-0.025, 0.025);
    this.pathDistanceBias = rand(0.96, 1.04);
    this.searchNestTime = 0;
    this.nestFoundRecently = startsInNest;
    this.homeEstimate = { x: 0, z: 0, distance: 0, confidence: 1 };
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
    if (this.insideNest) {
      this.updateInsideNest(dt, sim);
      return;
    }
    this.homeTimer += dt;
    this.wet = Math.max(0, this.wet - dt * 0.11);
    this.energy = clamp(this.energy + dt * 0.012, 0, 1);
    this.lastTrail += dt;
    this.trailFollowing = Math.max(0, this.trailFollowing - dt * 2.4);
    this.updateSurfaceContact(dt, sim);

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
    else if (this.state === "harvest") this.updateHarvest(dt, sim, steering);
    else if (this.state === "return") this.updateReturn(dt, sim, steering);
    else if (this.state === "searchNest") this.updateSearchNest(dt, sim, steering);
    else if (this.state === "rescue") this.updateRescue(dt, sim, steering);
    else this.updateExplore(dt, sim, steering, sensed);

    if (this.insideNest) return;
    this.move(dt, sim, steering);
    this.leaveTrail(sim);
  }

  setState(nextState) {
    if (this.state !== nextState) {
      if (nextState !== "harvest") {
        this.targetFoodId = null;
        this.harvestTimer = 0;
      }
      this.state = nextState;
      this.stateTime = 0;
    }
  }

  updatePathIntegration(dx, dz, sim) {
    const distance = Math.hypot(dx, dz);
    if (distance < 0.0001 || this.state === "stunned") return;

    const realNestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z);
    if (realNestDistance < sim.nest.radius * HOMING_PARAMS.pathResetRadiusMultiplier) {
      this.resetPathIntegration(sim);
      return;
    }

    const terrainRoughness = sim.terrain?.sampleRoughness(this.x, this.z) ?? 0;
    const terrainError = 1 + terrainRoughness * 0.85;
    const angularNoise = (rand(-HOMING_PARAMS.pathAngularNoise, HOMING_PARAMS.pathAngularNoise) * terrainError) + this.pathDrift * clamp(distance / 12, 0, 1.5);
    const distanceScale = this.pathDistanceBias * (1 + rand(-HOMING_PARAMS.pathDistanceNoise, HOMING_PARAMS.pathDistanceNoise) * terrainError);
    const sin = Math.sin(angularNoise);
    const cos = Math.cos(angularNoise);
    const estimatedDX = (dx * cos - dz * sin) * distanceScale;
    const estimatedDZ = (dx * sin + dz * cos) * distanceScale;

    this.pathX += estimatedDX;
    this.pathZ += estimatedDZ;
    this.pathError = clamp(
      this.pathError + distance * HOMING_PARAMS.pathErrorGain * terrainError * (1 + Math.abs(angularNoise) * 10),
      0,
      HOMING_PARAMS.pathErrorMax,
    );
    this.homingConfidence = clamp(1 - this.pathError / HOMING_PARAMS.pathErrorMax, 0.25, 1);
  }

  resetPathIntegration(sim) {
    const realNestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z);
    const insideNest = realNestDistance < sim.nest.radius * HOMING_PARAMS.pathResetRadiusMultiplier;
    this.pathX = insideNest ? 0 : this.x - sim.nest.x;
    this.pathZ = insideNest ? 0 : this.z - sim.nest.z;
    this.pathError = rand(0.15, 0.6);
    this.homingConfidence = 1;
    this.searchNestTime = 0;
    this.nestFoundRecently = insideNest;
  }

  getHomeEstimate() {
    const distance = Math.hypot(this.pathX, this.pathZ);
    const estimate = this.homeEstimate;
    estimate.distance = distance;
    estimate.confidence = this.homingConfidence;
    if (distance < 0.001) {
      estimate.x = 0;
      estimate.z = 0;
    } else {
      estimate.x = -this.pathX / distance;
      estimate.z = -this.pathZ / distance;
    }
    return estimate;
  }

  updateSurfaceContact(dt, sim) {
    const groundY = sim.getSurfaceY(this.x, this.z, 0.72);
    const propContact = sim.terrain?.samplePropContact(this.x, this.z, this.angle, this.propSurface);
    const branchContact = sim.sampleDynamicBranchContact(this.x, this.z, this.angle, this.branchSurface);
    const contact = branchContact.hit && (!propContact?.hit || branchContact.y > propContact.y) ? branchContact : propContact;
    const targetY = contact?.hit ? Math.max(groundY, contact.y + 0.72) : groundY;
    const targetPitch = contact?.hit ? contact.pitch : 0;
    const targetRoll = contact?.hit ? contact.roll : 0;
    const lerpScale = dt / FIXED_DT;
    const heightLerp = clamp(PROP_CONTACT_PARAMS.surfaceHeightLerp * lerpScale, 0, 1);
    const tiltLerp = clamp(PROP_CONTACT_PARAMS.surfaceTiltLerp * lerpScale, 0, 1);
    this.surfaceY += (targetY - this.surfaceY) * heightLerp;
    this.surfacePitch += (targetPitch - this.surfacePitch) * tiltLerp;
    this.surfaceRoll += (targetRoll - this.surfaceRoll) * tiltLerp;
    this.surfaceSlow = contact?.hit ? contact.slow : 1;
    this.surfaceKind = contact?.hit ? contact.kind : null;
  }

  updateInsideNest(dt, sim) {
    this.nestTimer = Math.max(0, this.nestTimer - dt);
    this.wet = Math.max(0, this.wet - dt * 0.22);
    this.energy = 1;
    this.stun = 0;
    this.carrying = 0;
    this.carryingLoad = 0;
    this.carryingFoodValue = 0;
    this.homeTimer = 0;
    this.x = sim.nest.x;
    this.z = sim.nest.z;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevAngle = this.angle;
    if (this.nestTimer <= 0 && sim.requestNestExit(this)) {
      this.exitNest(sim);
    }
  }

  addNestQueueSteering(sim, steering, realNestDistance) {
    const d = realNestDistance || 1;
    const toNestX = (sim.nest.x - this.x) / d;
    const toNestZ = (sim.nest.z - this.z) / d;
    const tangentSign = this.id % 2 === 0 ? 1 : -1;
    const tangentX = -toNestZ * tangentSign;
    const tangentZ = toNestX * tangentSign;
    const queueRadius = sim.nest.radius * NEST_TRAFFIC_PARAMS.queueRadiusScale;
    const hold = clamp((queueRadius - realNestDistance) / queueRadius, 0, 1);
    steering.x += tangentX * (0.58 + hold * 0.44);
    steering.z += tangentZ * (0.58 + hold * 0.44);
    steering.x -= toNestX * hold * 0.42;
    steering.z -= toNestZ * hold * 0.42;
  }

  tryEnterNest(sim, steering, realNestDistance) {
    const entryRadius = sim.nest.radius * NEST_TRAFFIC_PARAMS.entryRadiusScale;
    if (realNestDistance > entryRadius) return false;
    if (sim.requestNestEntry(this)) {
      this.completeNestArrival(sim);
      return true;
    }
    this.addNestQueueSteering(sim, steering, realNestDistance);
    return true;
  }

  enterNest(sim) {
    this.insideNest = true;
    this.nestTimer = NEST_TRAFFIC_PARAMS.dwellSeconds;
    this.x = sim.nest.x;
    this.z = sim.nest.z;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.state = "insideNest";
    this.stateTime = 0;
  }

  exitNest(sim) {
    this.insideNest = false;
    this.nestTimer = 0;
    const angle = sim.nextNestExitAngle();
    const radius = sim.nest.radius * NEST_TRAFFIC_PARAMS.exitRadiusScale + rand(-0.32, 0.52);
    this.x = sim.nest.x + Math.sin(angle) * radius;
    this.z = sim.nest.z + Math.cos(angle) * radius;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.angle = angle;
    this.prevAngle = angle;
    this.homeTimer = 0;
    this.energy = 1;
    this.resetPathIntegration(sim);
    this.setState("explore");
  }

  completeNestArrival(sim) {
    this.deliverFoodToNest(sim);
    this.carrying = 0;
    this.carryingFoodType = null;
    this.carryingLoad = 0;
    this.carryingFoodValue = 0;
    this.carryingFoodQuality = 1;
    this.foodSourceId = null;
    this.targetFoodId = null;
    this.harvestTimer = 0;
    this.energy = 1;
    this.homeTimer = 0;
    this.resetPathIntegration(sim);
    this.enterNest(sim);
  }

  deliverFoodToNest(sim) {
    if (this.carrying <= 0) return;
    const type = this.carryingFoodType ?? "sugar";
    const config = getFoodType(type);
    const load = this.carryingLoad || this.carrying || config.loadSize;
    const quality = this.carryingFoodQuality ?? 1;
    sim.collectedFood += load * config.storageValue * quality;
    sim.collectedByType[type] = (sim.collectedByType[type] ?? 0) + load;
    sim.colonyStores.energy += load * config.energyValue * quality;
    sim.colonyStores.storage += load * config.storageValue * quality;
    sim.colonyStores.brood += load * config.broodValue * quality;
    sim.colonyStores.material += load * (config.materialValue ?? 0) * quality;
    sim.pheromones?.deposit("trunk", this.x, this.z, 0.18 + config.trunkStrength * 1.2, 5.5);
  }

  addNestOdorSteering(sim, steering, radiusMultiplier, maxGain) {
    const realNestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    const odorRadius = sim.nest.radius * radiusMultiplier;
    if (realNestDistance >= odorRadius) return;
    const gain = (1 - realNestDistance / odorRadius) * maxGain;
    steering.x += ((sim.nest.x - this.x) / realNestDistance) * gain;
    steering.z += ((sim.nest.z - this.z) / realNestDistance) * gain;
  }

  addReturnPheromoneBias(sim, steering) {
    if (!sim.pheromones) return;
    const trunk = sim.pheromones.sampleAntennae("trunk", this.x, this.z, this.angle, this.returnTrunkAntennaeOptions);
    let bestStrength = trunk.strength;
    let bestTurn = trunk.turn;
    const food = sim.pheromones.sampleAntennae("food", this.x, this.z, this.angle, this.returnFoodAntennaeOptions);
    if (food.strength > bestStrength) {
      bestStrength = food.strength;
      bestTurn = food.turn;
    }

    if (bestStrength > 0) {
      this.trailFollowing = Math.max(this.trailFollowing, clamp(bestStrength * 1.6, 0, 1));
      const turnAngle = this.angle - bestTurn * 0.45;
      const gain = clamp(bestStrength, 0, 0.65) * 0.28;
      steering.x += Math.sin(turnAngle) * gain;
      steering.z += Math.cos(turnAngle) * gain;
      const centerChannel = food.strength > trunk.strength ? "food" : "trunk";
      const gradient = sim.pheromones.sampleGradient(centerChannel, this.x, this.z, this.fieldGradient);
      const centerGain = clamp(bestStrength, 0, 0.8) * 1.05;
      steering.x += gradient.x * centerGain;
      steering.z += gradient.z * centerGain;
    }

    const avoidGradient = sim.pheromones.sampleGradient("avoid", this.x, this.z, this.fieldGradient);
    steering.x -= avoidGradient.x * 0.45;
    steering.z -= avoidGradient.z * 0.45;
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
    sensed.foodScore = 0;
    const terrain = sim.terrain;
    sensed.terrainDetection = terrain?.sampleDetectionMultiplier(this.x, this.z) ?? 1;
    sensed.terrainRoughness = terrain?.sampleRoughness(this.x, this.z) ?? 0;
    sensed.terrainMovement = terrain?.sampleMovementMultiplier(this.x, this.z) ?? 1;

    if (terrain?.effectsEnabled) {
      const terrainType = terrain.sampleType(this.x, this.z);
      if (terrainType.id === "puddle") {
        sensed.waterDepth = Math.max(sensed.waterDepth, 0.36);
        sensed.alarm = Math.max(sensed.alarm, 0.18);
      } else if (terrainType.id === "mud") {
        sensed.waterDepth = Math.max(sensed.waterDepth, 0.08);
      }
    }

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

    if (sim.pheromones) {
      const alarm = sim.pheromones.sample("alarm", this.x, this.z);
      if (alarm > 0.012) {
        const gradient = sim.pheromones.sampleGradient("alarm", this.x, this.z, this.fieldGradient);
        sensed.alarm = Math.max(sensed.alarm, alarm * 0.82);
        const gain = clamp(alarm, 0, 1.4) * (4.8 + this.traits.caution * 2.4);
        hazard.x -= gradient.x * gain;
        hazard.z -= gradient.z * gain;
      }

      const avoid = sim.pheromones.sample("avoid", this.x, this.z);
      if (avoid > 0.01) {
        const gradient = sim.pheromones.sampleGradient("avoid", this.x, this.z, this.fieldGradient);
        const gain = clamp(avoid, 0, 1.6) * (5.5 + this.traits.caution * 2.2);
        hazard.x -= gradient.x * gain;
        hazard.z -= gradient.z * gain;
        if (avoid > 0.68) sensed.alarm = Math.max(sensed.alarm, avoid * 0.42);
      }
    }

    for (const food of sim.food) {
      if (food.amount <= 0) continue;
      const d = distance2(this.x, this.z, food.x, food.z);
      const config = food.config ?? getFoodType(food.type);
      const quality = food.quality ?? 1;
      if (quality <= 0.08) continue;
      const affinity = config.roleAffinity[this.role] ?? 1;
      const terrainVision = sensed.terrainDetection * (1 - sensed.terrainRoughness * 0.18);
      const effectiveDetectRadius = config.detectRadius * (0.74 + this.traits.curiosity * 0.46) * (0.78 + quality * 0.22) * terrainVision;
      if (d > effectiveDetectRadius) continue;
      const proximity = clamp(1 - d / effectiveDetectRadius, 0, 1);
      const amountFactor = clamp(food.amount / food.initialAmount, 0.15, 1) * quality;
      let traitFactor = 0.7 + this.traits.curiosity * 0.45;
      if (this.role === "scout" && (config.category === "sugar" || config.category === "fruit")) traitFactor *= 1.14;
      if (this.role === "worker" && (config.category === "seed" || config.category === "fat" || config.category === "starch")) traitFactor *= 1.16;
      if (this.role === "nurse" && config.category === "protein") traitFactor *= 1.32;
      if (this.role === "guard" && (config.category === "protein" || config.category === "fat")) traitFactor *= 1.16;
      if (config.cooperative) traitFactor *= 0.65 + this.traits.social * 0.75;
      if (food.type === "seed" || food.type === "largePrey") traitFactor *= 0.75 + this.traits.persistence * 0.6;
      if ((food.type === "largePrey" || food.type === "largeFruit") && this.role !== "guard") traitFactor *= 0.88 + this.traits.caution * 0.16;
      const helperCount = food.lastHarvesterCount ?? 0;
      const helperNeed = config.cooperative ? clamp((config.requiredHelpers - helperCount) / config.requiredHelpers, 0, 1) : 0;
      const helperSignal = config.cooperative ? 1 + clamp(helperCount / config.requiredHelpers, 0, 1) * 0.22 + helperNeed * this.traits.social * 0.18 : 1;
      const score = proximity * amountFactor * config.directAttraction * affinity * traitFactor * helperSignal;
      if (score > sensed.foodScore) {
        sensed.foodScore = score;
        sensed.foodDistance = d;
        sensed.closestFood = food;
      }
    }

    return sensed;
  }

  updateExplore(dt, sim, steering, sensed) {
    if (sensed.closestFood && sensed.foodDistance < sensed.closestFood.radius + 1.5) {
      this.targetFoodId = sensed.closestFood.id;
      this.harvestTimer = 0;
      this.setState("harvest");
      return;
    }

    if (sensed.closestFood) {
      const config = sensed.closestFood.config ?? getFoodType(sensed.closestFood.type);
      const quality = sensed.closestFood.quality ?? 1;
      const sourceRatio = clamp(sensed.closestFood.amount / sensed.closestFood.initialAmount, 0, 1);
      const affinity = config.roleAffinity[this.role] ?? 1;
      const effectiveRange = config.detectRadius * (0.72 + this.traits.curiosity * 0.42) * (sensed.terrainDetection ?? 1);
      const strength =
        clamp(1 - sensed.foodDistance / effectiveRange, 0, 1) *
        config.directAttraction *
        affinity *
        quality *
        (0.62 + this.traits.curiosity * 0.55) *
        (0.35 + sourceRatio * 0.65);
      steering.x += ((sensed.closestFood.x - this.x) / (sensed.foodDistance || 1)) * strength;
      steering.z += ((sensed.closestFood.z - this.z) / (sensed.foodDistance || 1)) * strength;
    }

    if (sim.pheromones && this.role !== "guard") {
      const foodSignal = sim.pheromones.sampleAntennae("food", this.x, this.z, this.angle, this.foodAntennaeOptions);
      if (foodSignal.strength > 0) {
        this.trailFollowing = Math.max(this.trailFollowing, clamp(foodSignal.strength * 1.8, 0, 1));
        const turnAngle = this.angle - foodSignal.turn * 0.85;
        const gain =
          clamp(foodSignal.strength, 0, 1.2) *
          PHEROMONE_PARAMS.foodFollowGain *
          (0.75 + this.traits.curiosity * 0.65) *
          (0.82 + this.traits.social * 0.28);
        steering.x += Math.sin(turnAngle) * gain;
        steering.z += Math.cos(turnAngle) * gain;
        const gradient = sim.pheromones.sampleGradient("food", this.x, this.z, this.fieldGradient);
        const centerGain = clamp(foodSignal.strength, 0, 1) * (1.6 + this.traits.social * 0.6);
        steering.x += gradient.x * centerGain;
        steering.z += gradient.z * centerGain;
      }

      const trunkSignal = sim.pheromones.sampleAntennae("trunk", this.x, this.z, this.angle, this.trunkAntennaeOptions);
      if (trunkSignal.strength > 0) {
        this.trailFollowing = Math.max(this.trailFollowing, clamp(trunkSignal.strength * 1.4, 0, 0.82));
        const turnAngle = this.angle - trunkSignal.turn * 0.6;
        const gain = clamp(trunkSignal.strength, 0, 0.75) * PHEROMONE_PARAMS.foodFollowGain * (0.18 + this.traits.social * 0.16);
        steering.x += Math.sin(turnAngle) * gain;
        steering.z += Math.cos(turnAngle) * gain;
        const gradient = sim.pheromones.sampleGradient("trunk", this.x, this.z, this.fieldGradient);
        const centerGain = clamp(trunkSignal.strength, 0, 0.8) * (0.8 + this.traits.social * 0.45);
        steering.x += gradient.x * centerGain;
        steering.z += gradient.z * centerGain;
      }
    }

    const legacyTrailGain = sim.pheromones ? 0.16 : 1;
    for (const trail of sim.trails) {
      if (trail.kind !== "food") continue;
      const d = distance2(this.x, this.z, trail.x, trail.z);
      if (d < PHEROMONE_PARAMS.foodFollowRadius && trail.followStrength > 0) {
        const strength = trail.life * trail.followStrength * (1 - d / PHEROMONE_PARAMS.foodFollowRadius) * PHEROMONE_PARAMS.foodFollowGain * legacyTrailGain;
        steering.x += ((trail.x - this.x) / (d || 1)) * strength;
        steering.z += ((trail.z - this.z) / (d || 1)) * strength;
      }
    }

    const exploreReturnDelay =
      HOMING_PARAMS.exploreReturnBaseDelay +
      this.traits.persistence * HOMING_PARAMS.exploreReturnPersistenceDelay +
      this.traits.curiosity * HOMING_PARAMS.exploreReturnCuriosityDelay;
    if (this.homeTimer > exploreReturnDelay || this.energy < 0.12) {
      this.setState("return");
      this.carrying = 0;
      this.carryingFoodType = null;
      this.carryingLoad = 0;
      this.carryingFoodValue = 0;
      this.carryingFoodQuality = 1;
      this.foodSourceId = null;
      this.homeTimer = 0;
      return;
    }

    const terrainNoise = 1 + (sensed.terrainRoughness ?? 0) * 0.72;
    this.wander += (Math.random() - 0.5) * dt * (2.3 + this.traits.curiosity * 3.2) * terrainNoise + this.turnBias * dt;
    steering.x += Math.sin(this.wander) * (0.58 + this.traits.curiosity * 0.5) * terrainNoise;
    steering.z += Math.cos(this.wander) * (0.58 + this.traits.curiosity * 0.5) * terrainNoise;

    const homeDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z);
    if (homeDistance > sim.worldRadius * 0.72) {
      steering.x += ((sim.nest.x - this.x) / homeDistance) * 0.9;
      steering.z += ((sim.nest.z - this.z) / homeDistance) * 0.9;
    }
  }

  updateHarvest(dt, sim, steering) {
    const food = sim.getFoodById(this.targetFoodId);
    if (!food || food.amount <= 0.05) {
      this.targetFoodId = null;
      this.harvestTimer = 0;
      this.setState("explore");
      return;
    }

    const config = food.config ?? getFoodType(food.type);
    const quality = food.quality ?? 1;
    if (quality <= 0.08) {
      this.targetFoodId = null;
      this.harvestTimer = 0;
      this.setState("explore");
      return;
    }
    const d = distance2(this.x, this.z, food.x, food.z) || 1;
    const harvestRadius = food.radius + 1.6;
    if (d > harvestRadius) {
      steering.x += ((food.x - this.x) / d) * (1.65 + this.traits.persistence * 0.45);
      steering.z += ((food.z - this.z) / d) * (1.65 + this.traits.persistence * 0.45);
      if (d > config.detectRadius * 1.15) {
        this.targetFoodId = null;
        this.harvestTimer = 0;
        this.setState("explore");
      }
      return;
    }

    const affinity = config.roleAffinity[this.role] ?? 1;
    const harvestPower = affinity * (0.75 + this.traits.persistence * 0.5);
    food.harvesterCount += 1;
    food.harvestPower += harvestPower;
    const helperCount = Math.max(food.lastHarvesterCount ?? 0, food.harvesterCount);
    const requiredHelpers = config.requiredHelpers ?? 1;
    const hasEnoughHelpers = !config.cooperative || helperCount >= requiredHelpers;

    this.wander += (Math.random() - 0.5) * dt * 1.4;
    steering.x += Math.sin(this.wander) * 0.08;
    steering.z += Math.cos(this.wander) * 0.08;

    if (!hasEnoughHelpers) {
      this.harvestTimer = Math.max(0, this.harvestTimer - dt * 0.18);
      food.harvestProgress = Math.max(0, food.harvestProgress - dt * 0.08);
      if (this.lastTrail > 0.55) {
        const helperNeed = clamp((requiredHelpers - helperCount) / requiredHelpers, 0, 1);
        const waitStrength = PHEROMONE_PARAMS.foodBaseStrength * config.pheromoneStrength * (0.88 + helperNeed * 0.82) * quality;
        sim.pheromones?.deposit("food", this.x, this.z, waitStrength, 4.8 + helperNeed * 2.2);
        sim.pheromones?.deposit("trunk", this.x, this.z, waitStrength * config.trunkStrength, 5.0);
        this.lastTrail = 0;
      }
      if (this.stateTime > 7 + this.traits.persistence * 5 && chance(dt * 0.35)) {
        this.targetFoodId = null;
        this.harvestTimer = 0;
        this.setState("explore");
      }
      return;
    }

    const helperFactor = config.cooperative ? clamp(helperCount / requiredHelpers, 0.8, 1.7) : 1;
    const effectiveHarvestTime = config.harvestTime * (1 + (1 - quality) * 0.75);
    if (config.cooperative) {
      food.harvestProgress += dt * harvestPower * helperFactor;
      if (food.harvestProgress < effectiveHarvestTime) return;
      food.harvestProgress = Math.max(0, food.harvestProgress - effectiveHarvestTime);
    } else {
      this.harvestTimer += dt * harvestPower * helperFactor;
      if (this.harvestTimer < effectiveHarvestTime) return;
    }

    const load = Math.min(config.loadSize, food.amount);
    if (load <= 0.05) {
      sim.refreshFoodMesh(food);
      this.targetFoodId = null;
      this.harvestTimer = 0;
      this.setState("explore");
      return;
    }

    this.carrying = load;
    this.carryingLoad = load;
    this.carryingFoodType = food.type;
    this.carryingFoodValue = load * config.storageValue * quality;
    this.carryingFoodQuality = quality;
    this.foodSourceId = food.id;
    this.targetFoodId = null;
    this.harvestTimer = 0;
    food.amount -= load;
    sim.refreshFoodMesh(food);
    this.lastTrail = PHEROMONE_PARAMS.foodDepositInterval;
    this.setState("return");
  }

  updateReturn(dt, sim, steering) {
    const realNestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    if (this.tryEnterNest(sim, steering, realNestDistance)) {
      return;
    }

    const home = this.getHomeEstimate();
    if (home.distance > HOMING_PARAMS.returnSearchDistance) {
      const gain =
        HOMING_PARAMS.returnGain *
        (1.05 + this.traits.persistence * 0.75) *
        clamp(home.distance / 20, 0.35, 1.4) *
        (0.72 + home.confidence * 0.28);
      steering.x += home.x * gain;
      steering.z += home.z * gain;
    } else {
      this.searchNestTime = 0;
      this.setState("searchNest");
      return;
    }

    this.wander += (Math.random() - 0.5) * dt * (1.2 + this.pathError * 0.06);
    const wanderGain = clamp(this.pathError * 0.025, 0.04, 0.28);
    steering.x += Math.sin(this.wander) * wanderGain;
    steering.z += Math.cos(this.wander) * wanderGain;
    this.addNestOdorSteering(sim, steering, HOMING_PARAMS.nestOdorRadiusMultiplier, 2.2);
    this.addReturnPheromoneBias(sim, steering);
    this.energy = clamp(this.energy - dt * 0.024, 0, 1);
  }

  updateSearchNest(dt, sim, steering) {
    this.searchNestTime += dt;
    const realNestDistance = distance2(this.x, this.z, sim.nest.x, sim.nest.z) || 1;
    if (this.tryEnterNest(sim, steering, realNestDistance)) {
      return;
    }

    this.wander += dt * (1.7 + this.traits.curiosity * 1.4) + Math.sin(this.searchNestTime * 1.3) * dt * 0.8;
    const searchRadiusFactor = clamp(this.searchNestTime / 8, 0.2, 1.2);
    steering.x += Math.sin(this.wander) * (0.65 + searchRadiusFactor * 0.35);
    steering.z += Math.cos(this.wander) * (0.65 + searchRadiusFactor * 0.35);
    this.addNestOdorSteering(sim, steering, HOMING_PARAMS.nestSearchOdorRadiusMultiplier, 2.8);
    this.addReturnPheromoneBias(sim, steering);

    if (this.searchNestTime > HOMING_PARAMS.searchFallbackDelay) {
      const fallbackMax = this.carrying > 0 ? 0.85 : 0.55;
      const fallbackGain = clamp((this.searchNestTime - HOMING_PARAMS.searchFallbackDelay) / 8, 0, fallbackMax);
      steering.x += ((sim.nest.x - this.x) / realNestDistance) * fallbackGain;
      steering.z += ((sim.nest.z - this.z) / realNestDistance) * fallbackGain;
    }

    this.energy = clamp(this.energy - dt * 0.02, 0, 1);
    if (this.searchNestTime > HOMING_PARAMS.searchGiveUpDelay && this.carrying <= 0) {
      this.resetPathIntegration(sim);
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
      sim.pheromones?.deposit("alarm", this.x, this.z, 0.82, 4.2);
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
        sim.pheromones?.deposit("rescue", this.x, this.z, 0.72, 4.0);
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
    const forwardX = Math.sin(this.angle);
    const forwardZ = Math.cos(this.angle);
    const rightX = Math.cos(this.angle);
    const rightZ = -Math.sin(this.angle);
    const orderlyState = this.state === "explore" || this.state === "harvest" || this.state === "return" || this.state === "searchNest";
    const lineBias = clamp(this.trailFollowing, 0, 1);
    const laneWidth = ANT_FORMATION_PARAMS.laneWidth * (1 - lineBias * 0.32);
    const gridSize = sim.antSpatialGridSize;
    const gridMax = gridSize - 1;
    const range = sim.antSpatialQueryRange;
    const minGX = Math.max(0, this.spatialGridX - range);
    const maxGX = Math.min(gridMax, this.spatialGridX + range);
    const minGZ = Math.max(0, this.spatialGridZ - range);
    const maxGZ = Math.min(gridMax, this.spatialGridZ + range);

    for (let gz = minGZ; gz <= maxGZ; gz += 1) {
      const row = gz * gridSize;
      for (let gx = minGX; gx <= maxGX; gx += 1) {
        const cell = sim.antSpatialCells[row + gx];
        for (let i = 0; i < cell.length; i += 1) {
          const other = cell[i];
          if (other === this || other.insideNest) continue;
          const d = distance2(this.x, this.z, other.x, other.z);
          if (d <= 0 || d > ANT_FORMATION_PARAMS.sameDirectionRadius) continue;

          const awayX = (this.x - other.x) / d;
          const awayZ = (this.z - other.z) / d;
          const otherForwardX = Math.sin(other.angle);
          const otherForwardZ = Math.cos(other.angle);
          const headingSimilarity = forwardX * otherForwardX + forwardZ * otherForwardZ;
          const sameDirection =
            orderlyState &&
            (other.state === "explore" || other.state === "harvest" || other.state === "return" || other.state === "searchNest") &&
            headingSimilarity > 0.55;

          if (d < ANT_FORMATION_PARAMS.hardRadius) {
            const strength = (1 - d / ANT_FORMATION_PARAMS.hardRadius) * 1.05;
            sx += awayX * strength;
            sz += awayZ * strength;
            count += 1;
            continue;
          }

          if (!sameDirection) {
            if (d < ANT_FORMATION_PARAMS.personalRadius) {
              const strength = (1 - d / ANT_FORMATION_PARAMS.personalRadius) * 0.54;
              sx += awayX * strength;
              sz += awayZ * strength;
              count += 1;
            }
            continue;
          }

          const toOtherX = other.x - this.x;
          const toOtherZ = other.z - this.z;
          const forwardOffset = toOtherX * forwardX + toOtherZ * forwardZ;
          const lateralOffset = toOtherX * rightX + toOtherZ * rightZ;
          const absForward = Math.abs(forwardOffset);
          const absLateral = Math.abs(lateralOffset);

          if (forwardOffset > 0 && forwardOffset < ANT_FORMATION_PARAMS.followGap && absLateral < laneWidth) {
            const strength = (1 - forwardOffset / ANT_FORMATION_PARAMS.followGap) * (1 - absLateral / laneWidth) * (0.46 + lineBias * 0.18);
            sx -= forwardX * strength;
            sz -= forwardZ * strength;
            count += 1;
          } else if (
            absForward < ANT_FORMATION_PARAMS.sideBySideForwardRange &&
            absLateral > laneWidth &&
            absLateral < ANT_FORMATION_PARAMS.personalRadius + 1.35
          ) {
            const sideSign = lateralOffset >= 0 ? 1 : -1;
            const orderSign = this.id > other.id ? -1 : 1;
            const sideBySideStrength =
              (1 - absForward / ANT_FORMATION_PARAMS.sideBySideForwardRange) *
              (1 - (absLateral - laneWidth) / (ANT_FORMATION_PARAMS.personalRadius + 1.35 - laneWidth));
            const mergeGain = ANT_FORMATION_PARAMS.laneMergeGain + lineBias * 0.22;
            const orderGain = ANT_FORMATION_PARAMS.queueOrderGain + lineBias * 0.18;
            sx -= rightX * sideSign * sideBySideStrength * mergeGain;
            sz -= rightZ * sideSign * sideBySideStrength * mergeGain;
            sx += forwardX * orderSign * sideBySideStrength * orderGain;
            sz += forwardZ * orderSign * sideBySideStrength * orderGain;
            count += 1;
          } else if (d < ANT_FORMATION_PARAMS.personalRadius) {
            const strength = (1 - d / ANT_FORMATION_PARAMS.personalRadius) * 0.24;
            const forwardRepel = awayX * forwardX + awayZ * forwardZ;
            const lateralRepel = awayX * rightX + awayZ * rightZ;
            const lateralGain = 1 - lineBias * 0.62;
            sx += (forwardX * forwardRepel + rightX * lateralRepel * lateralGain) * strength;
            sz += (forwardZ * forwardRepel + rightZ * lateralRepel * lateralGain) * strength;
            count += 1;
          }
        }
      }
    }
    if (count) {
      steering.x += sx / count;
      steering.z += sz / count;
    }
  }

  addObstacleAvoidance(steering, sim) {
    const terrain = sim.terrain;
    if (terrain?.effectsEnabled) {
      const aheadDistance = 3.2;
      const forwardX = Math.sin(this.angle);
      const forwardZ = Math.cos(this.angle);
      const aheadX = this.x + forwardX * aheadDistance;
      const aheadZ = this.z + forwardZ * aheadDistance;
      if (terrain.isBlocked(aheadX, aheadZ)) {
        const rightX = Math.cos(this.angle);
        const rightZ = -Math.sin(this.angle);
        const leftBlocked = terrain.isBlocked(this.x - rightX * 2.8 + forwardX * 2.2, this.z - rightZ * 2.8 + forwardZ * 2.2);
        const rightBlocked = terrain.isBlocked(this.x + rightX * 2.8 + forwardX * 2.2, this.z + rightZ * 2.8 + forwardZ * 2.2);
        const side = leftBlocked && !rightBlocked ? 1 : rightBlocked && !leftBlocked ? -1 : this.turnBias >= 0 ? 1 : -1;
        steering.x -= forwardX * 0.72;
        steering.z -= forwardZ * 0.72;
        steering.x += rightX * side * 0.88;
        steering.z += rightZ * side * 0.88;
      }
    }

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
      const vx = branch.x2 - branch.x1;
      const vz = branch.z2 - branch.z1;
      const length = Math.hypot(vx, vz) || 1;
      const dirX = vx / length;
      const dirZ = vz / length;
      const t = clamp(((this.x - branch.x1) * vx + (this.z - branch.z1) * vz) / (length * length), 0, 1);
      const px = branch.x1 + vx * t;
      const pz = branch.z1 + vz * t;
      let nx = this.x - px;
      let nz = this.z - pz;
      let d = Math.hypot(nx, nz);
      if (d < 0.001) {
        nx = -dirZ;
        nz = dirX;
        d = 1;
      } else {
        nx /= d;
        nz /= d;
      }

      const forwardX = Math.sin(this.angle);
      const forwardZ = Math.cos(this.angle);
      const aheadX = this.x + forwardX * 4.4;
      const aheadZ = this.z + forwardZ * 4.4;
      const aheadT = clamp(((aheadX - branch.x1) * vx + (aheadZ - branch.z1) * vz) / (length * length), 0, 1);
      const aheadPX = branch.x1 + vx * aheadT;
      const aheadPZ = branch.z1 + vz * aheadT;
      const aheadDistance = distance2(aheadX, aheadZ, aheadPX, aheadPZ);
      const avoidRadius = branch.width + 1.1;
      const alongSign = forwardX * dirX + forwardZ * dirZ >= 0 ? 1 : -1;
      const mountRadius = avoidRadius + 1.6;
      if (aheadDistance < mountRadius) {
        const mountStrength = clamp(1 - aheadDistance / mountRadius, 0, 1);
        const aheadNX = aheadDistance > 0.001 ? (aheadX - aheadPX) / aheadDistance : nx;
        const aheadNZ = aheadDistance > 0.001 ? (aheadZ - aheadPZ) / aheadDistance : nz;
        steering.x += -aheadNX * mountStrength * 0.5 + dirX * alongSign * mountStrength * 0.44;
        steering.z += -aheadNZ * mountStrength * 0.5 + dirZ * alongSign * mountStrength * 0.44;
      }

      if (d < avoidRadius) {
        const slide = clamp(1 - d / avoidRadius, 0, 1);
        steering.x += -nx * slide * 0.24 + dirX * alongSign * slide * 0.56;
        steering.z += -nz * slide * 0.24 + dirZ * alongSign * slide * 0.56;
      }
    }
    sim.terrain?.resolvePropCollisions(this, steering);
  }

  move(dt, sim, steering) {
    const beforeX = this.x;
    const beforeZ = this.z;
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
    if (this.state === "searchNest") speed *= 0.9;
    if (this.state === "rescue") speed *= 0.92;
    if (this.state === "wet") speed *= 0.56;
    if (this.carrying > 0) speed *= getFoodType(this.carryingFoodType).carrySpeedMultiplier ?? 0.75;
    speed *= clamp(1 - this.wet * 0.3, 0.34, 1);
    speed *= sim.terrain?.sampleMovementMultiplier(this.x, this.z) ?? 1;
    speed *= this.surfaceSlow;
    speed *= sim.timeScale;

    let moveX = Math.sin(this.angle) * speed * dt;
    let moveZ = Math.cos(this.angle) * speed * dt;
    const nextX = this.x + moveX;
    const nextZ = this.z + moveZ;
    if (sim.terrain?.isBlocked(nextX, nextZ)) {
      const side = this.turnBias >= 0 ? 1 : -1;
      this.angle += side * dt * 2.8;
      moveX *= -0.12;
      moveZ *= -0.12;
    }

    this.x += moveX;
    this.z += moveZ;
    this.keepInWorld(sim);
    this.updatePathIntegration(this.x - beforeX, this.z - beforeZ, sim);
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
    if ((this.state === "return" || this.state === "searchNest") && this.carrying > 0 && this.lastTrail > PHEROMONE_PARAMS.foodDepositInterval) {
      const source = sim.getFoodSource(this.foodSourceId);
      const carriedConfig = getFoodType(this.carryingFoodType);
      if (source) {
        const quality = source.quality ?? 1;
        const sourceRatio = clamp(source.amount / source.initialAmount, 0, 1) * quality;
        const lowSourceFactor = clamp(sourceRatio / PHEROMONE_PARAMS.foodLowSourceThreshold, 0.18, 1);
        const sourceConfig = source.config ?? carriedConfig;
        const strength =
          (PHEROMONE_PARAMS.foodBaseStrength + sourceRatio * PHEROMONE_PARAMS.foodSourceStrengthBonus) *
          sourceConfig.pheromoneStrength *
          lowSourceFactor;
        sim.addTrail(this.x, this.z, "food", strength, {
          sourceId: this.foodSourceId,
          sourceRatio,
          sourceType: source.type,
        });
        sim.pheromones?.deposit("food", this.x, this.z, strength, 3.0);
        sim.pheromones?.deposit("trunk", this.x, this.z, strength * sourceConfig.trunkStrength, 4.0);
      } else {
        const fallbackStrength = PHEROMONE_PARAMS.foodBaseStrength * carriedConfig.pheromoneStrength * 0.32;
        sim.pheromones?.deposit("trunk", this.x, this.z, fallbackStrength * carriedConfig.trunkStrength, 4.0);
      }
      this.lastTrail = 0;
    } else if (this.state === "wet" && this.lastTrail > 0.6) {
      sim.addTrail(this.x, this.z, "water", 0.45);
      sim.pheromones?.deposit("avoid", this.x, this.z, 0.28, 3.5);
      this.lastTrail = 0;
    }
  }

  shock(strength) {
    if (this.insideNest) return;
    if (strength > 0.82 && chance(0.24 + this.traits.caution * 0.18)) {
      this.stun = rand(0.8, 2.8) * strength;
      this.setState("stunned");
    } else if (strength > 0.18) {
      this.setState("panic");
    }
  }

  renderState(sim, alpha) {
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const z = this.prevZ + (this.z - this.prevZ) * alpha;
    const state = this.renderStateScratch;
    state.x = x;
    state.z = z;
    state.angle = this.prevAngle + normAngle(this.angle - this.prevAngle) * alpha;
    state.y = this.surfaceY + Math.sin(sim.renderTime * 0.006 + this.id) * 0.03;
    state.scale = this.state === "stunned" ? 0.82 : 1;
    state.pitch = this.surfacePitch;
    state.roll = this.surfaceRoll;
    state.yawSin = Math.sin(state.angle);
    state.yawCos = Math.cos(state.angle);
    state.pitchSin = Math.sin(state.pitch);
    state.pitchCos = Math.cos(state.pitch);
    state.rollSin = Math.sin(state.roll);
    state.rollCos = Math.cos(state.roll);
    state.state = this.state;
    state.carrying = this.carrying;
    return state;
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
    this.localCoordsToWorld(renderState, localX, localY, localZ, this.dummy.position);
    this.dummy.rotation.set(renderState.pitch, renderState.angle, renderState.roll, "YXZ");
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
    this.localCoordsToWorld(renderState, point[0], point[1], point[2], target);
  }

  localCoordsToWorld(renderState, sourceX, sourceY, sourceZ, target) {
    const localX = sourceX * renderState.scale;
    const localY = sourceY * renderState.scale;
    const localZ = sourceZ * renderState.scale;
    const rolledX = localX * renderState.rollCos - localY * renderState.rollSin;
    const rolledY = localX * renderState.rollSin + localY * renderState.rollCos;
    const pitchedY = rolledY * renderState.pitchCos + localZ * renderState.pitchSin;
    const pitchedZ = -rolledY * renderState.pitchSin + localZ * renderState.pitchCos;
    target.set(
      renderState.x + rolledX * renderState.yawCos + pitchedZ * renderState.yawSin,
      renderState.y + pitchedY,
      renderState.z - rolledX * renderState.yawSin + pitchedZ * renderState.yawCos,
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
    for (const ant of ants) {
      if (!ant.insideNest) this.renderAnt(ant, ant.renderState(sim, alpha));
    }
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
    this.currentPixelRatio = 1;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x181a18);
    this.scene.fog = new THREE.Fog(0x181a18, 260, 560);
    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 660);
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
    this.uiCollapsed = readStorage("ant3d.uiCollapsed") === "1";
    this.paused = false;
    this.timeScale = 1;
    this.worldRadius = 170;
    this.fieldMargin = 0;
    this.nest = { x: -42, z: 12, radius: 12 };
    this.nestTraffic = {
      entryTokens: NEST_TRAFFIC_PARAMS.maxEntryTokens,
      exitTokens: NEST_TRAFFIC_PARAMS.maxExitTokens,
      exitAngle: 0,
    };
    this.antSpatialCellSize = ANT_FORMATION_PARAMS.sameDirectionRadius;
    this.antSpatialInvCellSize = 1 / this.antSpatialCellSize;
    this.antSpatialGridSize = Math.ceil((this.worldRadius * 2) / this.antSpatialCellSize) + 1;
    this.antSpatialQueryRange = Math.ceil(ANT_FORMATION_PARAMS.sameDirectionRadius / this.antSpatialCellSize);
    this.antSpatialCells = Array.from({ length: this.antSpatialGridSize * this.antSpatialGridSize }, () => []);
    this.antSpatialOccupiedCells = [];
    this.selectedAnt = null;
    this.collectedFood = 0;
    this.collectedByType = createFoodTypeTotals();
    this.colonyStores = { energy: 0, storage: 0, brood: 0, material: 0 };
    this.nextFoodId = 1;
    this.activeFoodType = ui.foodTypeSelect?.value ?? DEFAULT_FOOD_TYPE.id;
    this.foodSpawner = new FoodSpawner(this);
    this.ants = [];
    this.water = [];
    this.stones = [];
    this.food = [];
    this.branches = [];
    this.trails = [];
    this.lastUiUpdate = 0;
    this.resizeWidth = 0;
    this.resizeHeight = 0;
    this.debugCursorX = NaN;
    this.debugCursorZ = NaN;

    this.cameraTarget = new THREE.Vector3(this.nest.x * 0.55, 0, this.nest.z * 0.55);
    this.cameraRenderTarget = this.cameraTarget.clone();
    this.cameraYaw = -0.62;
    this.cameraPitch = window.innerWidth < 680 ? 1.26 : 1.18;
    this.targetCameraYaw = this.cameraYaw;
    this.targetCameraPitch = this.cameraPitch;
    this.cameraDistance = this.getDefaultCameraDistance();
    this.targetCameraDistance = this.cameraDistance;

    this.sharedGeometries = new Set();
    this.sharedMaterials = new Set();
    this.dynamicObjects = new Set();

    this.assetService.preloadProceduralAssets();
    this.createSharedAssets();
    this.terrain = new TerrainSystem(this);
    this.antRenderer = new AntRenderSystem(this, Number(ui.antCount.max));
    this.createWorld();
    this.pheromones = new PheromoneFieldSystem(this);
    this.setUiCollapsed(this.uiCollapsed, false);
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
      foodDisc: new THREE.CylinderGeometry(1, 0.94, 0.24, 20),
      foodShard: new THREE.DodecahedronGeometry(1, 0),
      foodSeed: new THREE.SphereGeometry(0.72, 8, 6),
      waterCircle: new THREE.CircleGeometry(1, 64),
      trailCircle: new THREE.CircleGeometry(1, 18),
      impactRing: new THREE.TorusGeometry(1, 0.035, 8, 72),
      branchKnob: new THREE.SphereGeometry(1, 8, 6),
    };

    this.materials = {
      ground: new THREE.MeshStandardMaterial({
        map: this.assetService.get("groundTexture"),
        roughness: 0.92,
        metalness: 0,
      }),
      nest: new THREE.MeshStandardMaterial({ color: 0x6d4e2a, roughness: 0.95 }),
      nestInner: new THREE.MeshStandardMaterial({ color: 0x2b1b10, roughness: 1, side: THREE.DoubleSide }),
      nestDark: new THREE.MeshBasicMaterial({ color: 0x120c08 }),
      nestPebble: new THREE.MeshStandardMaterial({ color: 0x82623a, roughness: 0.98, flatShading: true }),
      antDefault: new THREE.MeshStandardMaterial({ color: 0x18130f, roughness: 0.72 }),
      antAppendage: new THREE.MeshStandardMaterial({ color: 0x12100d, roughness: 0.82 }),
      food: new THREE.MeshStandardMaterial({ color: 0xd9a63f, roughness: 0.62 }),
      stone: new THREE.MeshStandardMaterial({ color: 0x777c75, roughness: 0.86 }),
      branch: new THREE.MeshStandardMaterial({
        color: 0xb8a586,
        map: this.assetService.get("branchBarkTexture"),
        bumpMap: this.assetService.get("branchBumpTexture"),
        bumpScale: 0.18,
        roughness: 0.94,
      }),
      branchDark: new THREE.MeshStandardMaterial({
        color: 0xa28e71,
        map: this.assetService.get("branchBarkTexture"),
        bumpMap: this.assetService.get("branchBumpTexture"),
        bumpScale: 0.24,
        roughness: 0.98,
      }),
      branchTip: new THREE.MeshStandardMaterial({
        color: 0xc7b28d,
        map: this.assetService.get("branchBarkTexture"),
        bumpMap: this.assetService.get("branchBumpTexture"),
        bumpScale: 0.12,
        roughness: 0.9,
      }),
      water: new THREE.MeshPhysicalMaterial({
        color: 0x78c7df,
        map: this.assetService.get("waterSurfaceTexture"),
        transparent: true,
        opacity: 0.42,
        roughness: 0.06,
        metalness: 0,
        transmission: 0.22,
        clearcoat: 0.65,
        clearcoatRoughness: 0.18,
        depthWrite: false,
      }),
      waterDepth: new THREE.MeshBasicMaterial({ color: 0x2d7689, transparent: true, opacity: 0.13, depthWrite: false }),
      waterFoam: new THREE.MeshBasicMaterial({ color: 0xe2fbff, transparent: true, opacity: 0.16, depthWrite: false }),
      waterShadow: new THREE.MeshBasicMaterial({ color: 0x173b36, transparent: true, opacity: 0.08, depthWrite: false }),
      waterRing: new THREE.MeshBasicMaterial({ color: 0x9ce7ff, transparent: true, opacity: 0.48 }),
      waterRipple: new THREE.MeshBasicMaterial({ color: 0xc8f6ff, transparent: true, opacity: 0.24, depthWrite: false }),
      waterHighlight: new THREE.MeshBasicMaterial({ color: 0xf1feff, transparent: true, opacity: 0.32, depthWrite: false }),
      branchShadow: new THREE.MeshBasicMaterial({ color: 0x20160d, transparent: true, opacity: 0.2, depthWrite: false }),
      impact: new THREE.MeshBasicMaterial({ color: 0xe47f63, transparent: true, opacity: 0.42 }),
      trailFood: new THREE.MeshBasicMaterial({ color: 0xd9a63f, transparent: true, opacity: 0.2, depthWrite: false }),
      trailAlarm: new THREE.MeshBasicMaterial({ color: 0xd96f58, transparent: true, opacity: 0.24, depthWrite: false }),
      trailRescue: new THREE.MeshBasicMaterial({ color: 0x51b7a6, transparent: true, opacity: 0.22, depthWrite: false }),
      trailWater: new THREE.MeshBasicMaterial({ color: 0x55aee0, transparent: true, opacity: 0.18, depthWrite: false }),
    };

    this.materials.foodByType = {};
    for (const type of FOOD_TYPE_ORDER) {
      const config = FOOD_TYPES[type];
      const isLiquid = config.modelStyle === "liquid";
      this.materials.foodByType[type] = new THREE.MeshStandardMaterial({
        color: config.color,
        map: this.assetService.get(`foodTexture:${config.textureKey}`),
        transparent: isLiquid,
        opacity: isLiquid ? 0.78 : 1,
        roughness: isLiquid ? 0.22 : config.category === "fruit" ? 0.48 : 0.74,
        metalness: 0,
      });
    }
    this.materials.foodSpawn = new THREE.MeshBasicMaterial({ color: 0xf3d27a, transparent: true, opacity: 0.42, depthWrite: false });

    this.materials.antByState = {
      explore: this.materials.antDefault,
      harvest: new THREE.MeshStandardMaterial({ color: 0x2f2215, roughness: 0.74 }),
      return: new THREE.MeshStandardMaterial({ color: 0x2a1b0e, roughness: 0.72 }),
      searchNest: new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 0.76 }),
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
    for (const material of Object.values(this.materials.foodByType)) this.sharedMaterials.add(material);
  }

  createWorld() {
    const hemi = new THREE.HemisphereLight(0xf8ead2, 0x21352e, 1.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffedc8, 2.2);
    sun.position.set(-64, 112, 58);
    sun.castShadow = this.quality.shadowQuality !== "off";
    if (sun.castShadow) {
      const mapSize = this.quality.shadowQuality === "medium" ? 1024 : 512;
      const shadowExtent = this.worldRadius + 24;
      sun.shadow.mapSize.set(mapSize, mapSize);
      sun.shadow.camera.left = -shadowExtent;
      sun.shadow.camera.right = shadowExtent;
      sun.shadow.camera.top = shadowExtent;
      sun.shadow.camera.bottom = -shadowExtent;
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 340;
      sun.shadow.bias = -0.00015;
    }
    this.scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(this.worldRadius + this.fieldMargin, 224), this.materials.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.86;
    ground.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(ground);
    this.sharedGeometries.add(ground.geometry);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(this.worldRadius + 2, 0.26, 8, 224),
      new THREE.MeshBasicMaterial({ color: 0x51412b, transparent: true, opacity: 0.46 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.02;
    this.scene.add(rim);
    this.sharedGeometries.add(rim.geometry);
    this.sharedMaterials.add(rim.material);

    this.createNest();
  }

  getSurfaceY(x, z, offset = 0) {
    return (this.terrain?.sampleHeight(x, z) ?? 0) + offset;
  }

  createNest() {
    const nestY = this.getSurfaceY(this.nest.x, this.nest.z);
    const holeRadius = this.nest.radius * NEST_TRAFFIC_PARAMS.holeRadiusScale;
    const outerRadius = this.nest.radius * 1.22;
    const moundGeometry = createNestMoundGeometry({
      innerRadius: holeRadius,
      outerRadius,
      height: 2.28,
      ellipseZ: 0.84,
      segments: 104,
      rings: 13,
    });
    const mound = new THREE.Mesh(moundGeometry, this.materials.nest);
    mound.position.set(this.nest.x, nestY + 0.02, this.nest.z);
    mound.castShadow = this.quality.shadowQuality !== "off";
    mound.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(mound);
    this.sharedGeometries.add(mound.geometry);

    const shaftDepth = 3.5;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(holeRadius * 1.05, holeRadius * 0.64, shaftDepth, 72, 2, true),
      this.materials.nestInner,
    );
    shaft.position.set(this.nest.x, nestY + 0.72, this.nest.z);
    shaft.scale.z = 0.84;
    shaft.castShadow = false;
    shaft.receiveShadow = true;
    this.scene.add(shaft);
    this.sharedGeometries.add(shaft.geometry);

    const bottom = new THREE.Mesh(new THREE.CircleGeometry(holeRadius * 0.72, 72), this.materials.nestDark);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(this.nest.x, nestY - 1.0, this.nest.z);
    bottom.scale.set(1, 0.84, 1);
    this.scene.add(bottom);
    this.sharedGeometries.add(bottom.geometry);

    const innerShadow = new THREE.Mesh(new THREE.RingGeometry(holeRadius * 0.84, holeRadius * 1.12, 72), this.materials.nestDark);
    innerShadow.rotation.x = -Math.PI / 2;
    innerShadow.position.set(this.nest.x, nestY + 2.22, this.nest.z);
    innerShadow.scale.set(1, 0.84, 1);
    this.scene.add(innerShadow);
    this.sharedGeometries.add(innerShadow.geometry);

    const crumbCount = this.quality.effectsQuality < 0.9 ? 18 : 30;
    const crumbs = new THREE.InstancedMesh(this.geometries.foodShard, this.materials.nestPebble, crumbCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < crumbCount; i += 1) {
      const angle = (i / crumbCount) * Math.PI * 2 + rand(-0.18, 0.18);
      const r = rand(holeRadius * 1.04, outerRadius * 0.82);
      const rimT = clamp((r - holeRadius) / (outerRadius - holeRadius), 0, 1);
      const y = nestY + 0.18 + Math.pow(1 - rimT, 1.35) * 1.34 + rand(-0.08, 0.12);
      const s = rand(0.22, 0.58) * (1 - rimT * 0.28);
      dummy.position.set(this.nest.x + Math.cos(angle) * r, y, this.nest.z + Math.sin(angle) * r * 0.84);
      dummy.rotation.set(rand(-0.55, 0.55), rand(0, Math.PI * 2), rand(-0.45, 0.45));
      dummy.scale.set(s * rand(0.75, 1.45), s * rand(0.42, 0.86), s * rand(0.75, 1.35));
      dummy.updateMatrix();
      crumbs.setMatrixAt(i, dummy.matrix);
    }
    crumbs.instanceMatrix.needsUpdate = true;
    crumbs.castShadow = this.quality.shadowQuality !== "off";
    crumbs.receiveShadow = this.quality.shadowQuality !== "off";
    this.scene.add(crumbs);
  }

  bindEvents() {
    this.boundResize = () => this.resize();
    this.boundPageHide = () => this.dispose();
    window.addEventListener("resize", this.boundResize);
    window.addEventListener("pagehide", this.boundPageHide, { once: true });

    ui.buttons.forEach((button) => {
      button.addEventListener("click", () => {
        this.tool = button.dataset.tool;
        ui.activeToolLabel.textContent = this.tool === "food" ? `餌: ${getFoodType(this.activeFoodType).label}` : button.dataset.label;
        ui.buttons.forEach((item) => item.classList.toggle("active", item === button));
      });
    });

    ui.uiToggle?.addEventListener("click", () => this.setUiCollapsed(!this.uiCollapsed));

    ui.pause.addEventListener("click", () => {
      this.paused = !this.paused;
      ui.pause.classList.toggle("is-paused", this.paused);
      ui.pause.title = this.paused ? "再開" : "一時停止";
      ui.pause.setAttribute("aria-label", ui.pause.title);
    });

    ui.reset.addEventListener("click", () => this.reset());
    ui.pheromone?.addEventListener("click", () => {
      const mode = this.pheromones?.cycleVisualizationMode() ?? "off";
      this.updatePheromoneButton(mode);
      const activeTool = ui.buttons.find((button) => button.dataset.tool === this.tool);
      ui.activeToolLabel.textContent = mode === "off" ? (activeTool?.dataset.label ?? "観察") : `フェロモン ${mode}`;
    });
    this.updatePheromoneButton();
    ui.antCount.addEventListener("input", () => {
      ui.antCountValue.value = ui.antCount.value;
    });
    ui.antCount.addEventListener("change", () => this.reset());
    ui.intensity.addEventListener("input", () => {
      ui.intensityValue.value = ui.intensity.value;
    });
    ui.foodTypeSelect?.addEventListener("change", () => {
      this.activeFoodType = ui.foodTypeSelect.value;
      this.updateFoodTypeHint();
      if (this.tool === "food") ui.activeToolLabel.textContent = `餌: ${getFoodType(this.activeFoodType).label}`;
    });
    this.updateFoodTypeHint();
    if (ui.naturalFoodToggle) {
      ui.naturalFoodToggle.checked = this.foodSpawner.enabled;
      ui.naturalFoodToggle.addEventListener("change", () => this.foodSpawner.setEnabled(ui.naturalFoodToggle.checked));
    }
    if (ui.naturalFoodRate) {
      ui.naturalFoodRate.value = this.foodSpawner.rate;
      ui.naturalFoodRate.addEventListener("change", () => this.foodSpawner.setRate(ui.naturalFoodRate.value));
    }
    if (ui.terrainEffectsToggle) {
      ui.terrainEffectsToggle.checked = this.terrain?.effectsEnabled ?? true;
      ui.terrainEffectsToggle.addEventListener("change", () => {
        this.terrain?.setEffectsEnabled(ui.terrainEffectsToggle.checked);
        this.pheromones?.refreshTerrainModifiers();
      });
    }
    if (ui.terrainComplexity) {
      ui.terrainComplexity.value = this.terrain?.complexity ?? "medium";
      ui.terrainComplexity.addEventListener("change", () => {
        this.terrain?.setComplexity(ui.terrainComplexity.value);
        this.regenerateTerrain();
      });
    }
    ui.terrainRegenerate?.addEventListener("click", () => this.regenerateTerrain());

    const canvas = this.renderer.domElement;
    this.input = new InputManager(this, canvas);
  }

  setUiCollapsed(collapsed, persist = true) {
    this.uiCollapsed = Boolean(collapsed);
    ui.appShell?.classList.toggle("ui-collapsed", this.uiCollapsed);
    if (ui.uiToggle) {
      const label = this.uiCollapsed ? "操作UIを表示" : "操作UIを隠す";
      ui.uiToggle.title = label;
      ui.uiToggle.setAttribute("aria-label", label);
      ui.uiToggle.setAttribute("aria-pressed", String(this.uiCollapsed));
      ui.uiToggle.classList.toggle("is-hidden-mode", this.uiCollapsed);
    }
    if (persist) writeStorage("ant3d.uiCollapsed", this.uiCollapsed ? "1" : "0");
  }

  updatePheromoneButton(mode = this.pheromones?.mode ?? "off") {
    if (!ui.pheromone) return;
    const label = `フェロモン表示: ${mode}`;
    ui.pheromone.title = label;
    ui.pheromone.setAttribute("aria-label", label);
    ui.pheromone.classList.toggle("is-active", mode !== "off");
  }

  updateFoodTypeHint() {
    if (!ui.foodTypeHint) return;
    ui.foodTypeHint.textContent = getFoodType(this.activeFoodType).hint;
  }

  regenerateTerrain() {
    this.terrain?.regenerate();
    this.pheromones?.refreshTerrainModifiers();
    this.reset();
    ui.activeToolLabel.textContent = "地形を再生成";
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
    this.pheromones?.reset();
    this.antRenderer?.beginFrame();
    this.antRenderer?.endFrame();
    this.collectedFood = 0;
    this.collectedByType = createFoodTypeTotals();
    this.colonyStores = { energy: 0, storage: 0, brood: 0, material: 0 };
    this.nextFoodId = 1;
    this.resetNestTraffic();
    this.foodSpawner?.reset();
    this.selectedAnt = null;
    const count = Number(ui.antCount.value);
    for (let i = 0; i < count; i += 1) this.ants.push(new Ant3D(i + 1, this));
    this.updateStats();
    this.updateInspector();
  }

  resetNestTraffic() {
    this.nestTraffic.entryTokens = NEST_TRAFFIC_PARAMS.maxEntryTokens;
    this.nestTraffic.exitTokens = NEST_TRAFFIC_PARAMS.maxExitTokens;
    this.nestTraffic.exitAngle = rand(0, Math.PI * 2);
  }

  updateNestTraffic(dt) {
    this.nestTraffic.entryTokens = Math.min(
      NEST_TRAFFIC_PARAMS.maxEntryTokens,
      this.nestTraffic.entryTokens + dt * NEST_TRAFFIC_PARAMS.entryRate,
    );
    this.nestTraffic.exitTokens = Math.min(
      NEST_TRAFFIC_PARAMS.maxExitTokens,
      this.nestTraffic.exitTokens + dt * NEST_TRAFFIC_PARAMS.exitRate,
    );
  }

  requestNestEntry() {
    if (this.nestTraffic.entryTokens < 1) return false;
    this.nestTraffic.entryTokens -= 1;
    return true;
  }

  requestNestExit() {
    if (this.nestTraffic.exitTokens < 1) return false;
    this.nestTraffic.exitTokens -= 1;
    return true;
  }

  nextNestExitAngle() {
    this.nestTraffic.exitAngle = (this.nestTraffic.exitAngle + 2.399963229728653) % (Math.PI * 2);
    return this.nestTraffic.exitAngle + rand(-0.22, 0.22);
  }

  sampleDynamicBranchContact(x, z, angle, target) {
    target.hit = false;
    target.y = 0;
    target.slow = 1;
    target.pitch = 0;
    target.roll = 0;
    target.kind = null;
    target.climbable = false;
    target.edgeFactor = 0;
    if (this.branches.length === 0) return target;

    const forwardX = Math.sin(angle);
    const forwardZ = Math.cos(angle);
    const rightX = Math.cos(angle);
    const rightZ = -Math.sin(angle);
    let bestY = -Infinity;

    for (const branch of this.branches) {
      const vx = branch.x2 - branch.x1;
      const vz = branch.z2 - branch.z1;
      const lenSq = vx * vx + vz * vz || 1;
      const t = clamp(((x - branch.x1) * vx + (z - branch.z1) * vz) / lenSq, 0, 1);
      const px = branch.x1 + vx * t;
      const pz = branch.z1 + vz * t;
      const dx = x - px;
      const dz = z - pz;
      const distance = Math.hypot(dx, dz);
      const surfaceRadius = branch.width * 0.58;
      const contactRadius = branch.width * 0.74;
      if (distance > contactRadius) continue;

      const edgeFactor = clamp(1 - distance / contactRadius, 0, 1);
      const y = this.getSurfaceY(px, pz, surfaceRadius * 0.92) + surfaceRadius * 0.14 * Math.sqrt(edgeFactor);
      if (y <= bestY) continue;

      bestY = y;
      const nx = distance > 0.001 ? dx / distance : -vz / Math.sqrt(lenSq);
      const nz = distance > 0.001 ? dz / distance : vx / Math.sqrt(lenSq);
      const slopeScale = -edgeFactor * 0.28;
      const gradX = nx * slopeScale;
      const gradZ = nz * slopeScale;
      target.hit = true;
      target.y = y;
      target.slow = 0.58 + edgeFactor * 0.2;
      target.pitch = clamp((gradX * forwardX + gradZ * forwardZ) * 0.72, -PROP_CONTACT_PARAMS.maxPitch, PROP_CONTACT_PARAMS.maxPitch);
      target.roll = clamp((gradX * rightX + gradZ * rightZ) * 0.82, -PROP_CONTACT_PARAMS.maxRoll, PROP_CONTACT_PARAMS.maxRoll);
      target.kind = "branch";
      target.climbable = true;
      target.edgeFactor = edgeFactor;
    }

    return target;
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

  getDefaultCameraDistance() {
    return window.innerWidth < 680 ? this.worldRadius * 1.96 : this.worldRadius * 1.86;
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
    this.cameraDistance = this.getDefaultCameraDistance();
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
    this.terrain?.update(dt);
    this.foodSpawner?.update(dt);
    this.updateNestTraffic(dt);
    this.updateFoodSources(dt);

    for (const food of this.food) {
      food.harvesterCount = 0;
      food.harvestPower = 0;
    }

    for (const patch of this.water) {
      patch.age += dt;
      patch.power = Math.max(0.08, patch.power - dt * 0.014);
      patch.group.scale.setScalar(1 + Math.sin(patch.age * 2.5) * 0.015);
      patch.ring.material.opacity = Math.max(0.1, patch.power * 0.44);
      patch.ring.scale.setScalar(1 + (patch.age % 1) * 0.05);
      patch.shore.material.opacity = patch.power * (0.075 + Math.sin(patch.age * 1.3) * 0.012);
      patch.shadow.material.opacity = patch.power * 0.075;
      patch.depth.material.opacity = patch.power * 0.12;
      for (const ripple of patch.ripples) {
        const phase = (patch.age * ripple.speed + ripple.offset) % 1;
        const scale = ripple.baseScale * (0.82 + phase * 0.34);
        ripple.mesh.scale.set(scale, scale * ripple.squash, scale);
        ripple.mesh.material.opacity = patch.power * ripple.opacity * (1 - phase);
      }
      for (const highlight of patch.highlights) {
        highlight.material.opacity = patch.power * highlight.userData.baseOpacity * (0.72 + Math.sin(patch.age * highlight.userData.speed + highlight.userData.offset) * 0.16);
      }
      this.pheromones?.deposit("avoid", patch.x, patch.z, patch.power * dt * 0.5, patch.radius + 4);
    }
    let waterWrite = 0;
    for (let i = 0; i < this.water.length; i += 1) {
      const patch = this.water[i];
      if (patch.power > 0.09 && patch.age < 85) {
        this.water[waterWrite] = patch;
        waterWrite += 1;
      } else {
        this.disposeDynamicItem(patch);
      }
    }
    this.water.length = waterWrite;

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
    let trailWrite = 0;
    for (let i = 0; i < this.trails.length; i += 1) {
      const trail = this.trails[i];
      if (trail.life > 0.02) {
        this.trails[trailWrite] = trail;
        trailWrite += 1;
      } else {
        this.disposeDynamicItem(trail);
      }
    }
    this.trails.length = trailWrite;

    this.pheromones?.update(dt);
    this.rebuildAntSpatialIndex();
    for (const ant of this.ants) ant.update(dt, this);
    for (const food of this.food) {
      food.lastHarvesterCount = food.harvesterCount;
      food.lastHarvestPower = food.harvestPower;
    }
    this.lastUiUpdate += dt;
    if (this.lastUiUpdate > 0.15) {
      this.updateStats();
      this.updateInspector();
      this.lastUiUpdate = 0;
    }
  }

  rebuildAntSpatialIndex() {
    for (const cell of this.antSpatialOccupiedCells) cell.length = 0;
    this.antSpatialOccupiedCells.length = 0;
    const gridMax = this.antSpatialGridSize - 1;
    for (const ant of this.ants) {
      if (ant.insideNest) continue;
      const gx = clamp(Math.floor((ant.x + this.worldRadius) * this.antSpatialInvCellSize), 0, gridMax);
      const gz = clamp(Math.floor((ant.z + this.worldRadius) * this.antSpatialInvCellSize), 0, gridMax);
      ant.spatialGridX = gx;
      ant.spatialGridZ = gz;
      const cell = this.antSpatialCells[gz * this.antSpatialGridSize + gx];
      if (cell.length === 0) this.antSpatialOccupiedCells.push(cell);
      cell.push(ant);
    }
  }

  updateFoodSources(dt) {
    for (let i = this.food.length - 1; i >= 0; i -= 1) {
      const food = this.food[i];
      const config = food.config ?? getFoodType(food.type);
      food.age += dt;
      if (food.spawnHighlight) {
        food.spawnHighlight.userData.age += dt;
        const phase = clamp(food.spawnHighlight.userData.age / 2.2, 0, 1);
        food.spawnHighlight.scale.setScalar(food.radius * (0.72 + phase * 0.58));
        food.spawnHighlight.material.opacity = (1 - phase) * 0.38;
        if (phase >= 1) food.spawnHighlight.visible = false;
      }

      const decaySeconds = config.decaySeconds ?? 180;
      if (decaySeconds <= 0) {
        food.quality = 1;
        continue;
      }

      const freshness = clamp(1 - food.age / decaySeconds, 0, 1);
      food.quality = freshness > 0.35 ? 1 : clamp(freshness / 0.35, 0.08, 1);
      if (food.age > decaySeconds * 0.68) {
        food.decayPulse += dt;
        const rotFactor = clamp((food.age - decaySeconds * 0.68) / (decaySeconds * 0.32), 0, 1);
        if (food.decayPulse > 2.2) {
          this.pheromones?.deposit("avoid", food.x, food.z, 0.05 + rotFactor * 0.14, food.radius + 4);
          this.pheromones?.dampen("food", food.x, food.z, 0.04 + rotFactor * 0.08, food.radius + 8);
          food.decayPulse = 0;
        }
        if (food.age > decaySeconds) {
          food.amount = Math.max(0, food.amount - dt * food.initialAmount * (0.02 + rotFactor * 0.035));
          this.refreshFoodMesh(food);
        }
      }
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

    const sourceRatio = clamp(source.amount / source.initialAmount, 0, 1) * (source.quality ?? 1);
    const lowSourceFactor = 1 - clamp(sourceRatio / PHEROMONE_PARAMS.foodLowSourceThreshold, 0, 1);
    trail.followStrength = clamp(sourceRatio * trail.sourceRatio, 0.08, 1);
    trail.life -= dt * (PHEROMONE_PARAMS.foodActiveDecay + lowSourceFactor * PHEROMONE_PARAMS.foodLowSourceExtraDecay);
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
    this.clearBranchPreview();
    this.antRenderer?.destroy();
    for (const list of [this.water, this.stones, this.food, this.branches, this.trails]) {
      for (const item of list) this.disposeDynamicItem(item);
    }
    this.pheromones?.dispose();
    this.terrain?.dispose();
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
      this.targetCameraDistance = clamp(
        this.pinchStart.cameraDistance * (this.pinchStart.distance / (current || 1)),
        128,
        this.worldRadius * 2.7,
      );
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;

    if (this.tool === "inspect") {
      this.targetCameraYaw -= dx * 0.006;
      this.targetCameraPitch = clamp(this.targetCameraPitch + dy * 0.004, 0.62, 1.56);
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
    if (hit) this.groundHit.y = this.getSurfaceY(hit.x, hit.z);
    if (!hit) return null;
    const d = Math.hypot(hit.x, hit.z);
    if (d > this.worldRadius + this.fieldMargin) return null;
    this.debugCursorX = hit.x;
    this.debugCursorZ = hit.z;
    return { x: hit.x, z: hit.z, y: hit.y };
  }

  addWater(x, z, scale = 1) {
    const intensity = Number(ui.intensity.value);
    const radius = 5.5 + intensity * 1.6 * scale + rand(-0.4, 0.8);
    const group = new THREE.Group();
    const waterGeometry = makeIrregularDiscGeometry(88, 0.055);
    const shadow = new THREE.Mesh(waterGeometry, this.materials.waterShadow.clone());
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(radius * 1.32, radius * 0.96, 1);
    shadow.position.y = 0.022;
    group.add(shadow);

    const depth = new THREE.Mesh(waterGeometry, this.materials.waterDepth.clone());
    depth.rotation.x = -Math.PI / 2;
    depth.scale.set(radius * 0.72, radius * 0.5, 1);
    depth.rotation.z = rand(-0.5, 0.5);
    depth.position.y = 0.029;
    group.add(depth);

    const pool = new THREE.Mesh(waterGeometry, this.materials.water.clone());
    pool.rotation.x = -Math.PI / 2;
    pool.scale.set(radius * 1.18, radius * 0.82, 1);
    pool.position.y = 0.035;
    pool.material.opacity = clamp(0.34 + intensity * 0.04, 0.34, 0.54);
    pool.rotation.z = rand(-0.12, 0.12);
    group.add(pool);

    const shore = new THREE.Mesh(this.geometries.impactRing, this.materials.waterFoam.clone());
    shore.rotation.x = Math.PI / 2;
    shore.scale.set(radius * 1.2, radius * 0.85, radius * 1.2);
    shore.position.y = 0.066;
    shore.material.opacity = 0.08 + intensity * 0.012;
    group.add(shore);

    const highlights = [];
    const highlightCount = intensity > 3 ? 3 : 2;
    for (let i = 0; i < highlightCount; i += 1) {
      const highlight = new THREE.Mesh(this.geometries.waterCircle, this.materials.waterHighlight.clone());
      highlight.rotation.x = -Math.PI / 2;
      const a = rand(0, Math.PI * 2);
      const r = rand(radius * 0.12, radius * 0.42);
      highlight.position.set(Math.cos(a) * r, 0.052 + i * 0.002, Math.sin(a) * r);
      highlight.rotation.z = rand(-0.7, 0.7);
      highlight.scale.set(radius * rand(0.12, 0.24), radius * rand(0.025, 0.055), 1);
      highlight.userData.baseOpacity = rand(0.18, 0.34);
      highlight.userData.speed = rand(1.3, 2.4);
      highlight.userData.offset = rand(0, Math.PI * 2);
      highlights.push(highlight);
      group.add(highlight);
    }

    const fleckCount = intensity > 4 ? 8 : 5;
    for (let i = 0; i < fleckCount; i += 1) {
      const fleck = new THREE.Mesh(this.geometries.waterCircle, this.materials.waterFoam.clone());
      fleck.rotation.x = -Math.PI / 2;
      const a = rand(0, Math.PI * 2);
      const r = rand(radius * 0.52, radius * 1.02);
      fleck.position.set(Math.cos(a) * r, 0.071 + i * 0.001, Math.sin(a) * r * 0.76);
      fleck.rotation.z = rand(0, Math.PI);
      fleck.scale.set(radius * rand(0.018, 0.042), radius * rand(0.006, 0.016), 1);
      fleck.material.opacity = rand(0.08, 0.18);
      group.add(fleck);
    }

    const ripples = [];
    const rippleCount = intensity > 4 ? 4 : 3;
    for (let i = 0; i < rippleCount; i += 1) {
      const ripple = new THREE.Mesh(this.geometries.impactRing, this.materials.waterRipple.clone());
      ripple.rotation.x = Math.PI / 2;
      ripple.position.y = 0.07 + i * 0.002;
      group.add(ripple);
      ripples.push({
        mesh: ripple,
        baseScale: radius * rand(0.48, 0.92),
        squash: rand(0.68, 0.86),
        speed: rand(0.16, 0.34),
        offset: i / rippleCount,
        opacity: rand(0.18, 0.34),
      });
    }

    const ring = new THREE.Mesh(this.geometries.impactRing, this.materials.waterRing.clone());
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(radius * 0.85, radius * 0.85, radius * 0.85);
    ring.position.y = 0.08;
    group.add(ring);
    group.position.set(x, this.getSurfaceY(x, z), z);
    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.water.push({ x, z, radius, power: clamp(0.45 + intensity * 0.13 * scale, 0.35, 1.08), age: 0, group, ring, shore, shadow, depth, ripples, highlights });
    this.pheromones?.deposit("avoid", x, z, 0.9 + intensity * 0.12, radius + 5);
    if (intensity >= 4) this.pheromones?.deposit("alarm", x, z, 0.22, radius + 3);
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
    group.position.set(x, this.getSurfaceY(x, z), z);
    this.scene.add(group);
    this.dynamicObjects.add(group);

    const item = { x, z, radius, shock: 1, group, ring };
    this.stones.push(item);
    this.pheromones?.deposit("alarm", x, z, 0.84 + intensity * 0.12, radius + 10);
    this.pheromones?.deposit("avoid", x, z, 0.48 + intensity * 0.08, radius + 7);
    for (const ant of this.ants) {
      const d = distance2(ant.x, ant.z, x, z);
      if (d < radius + 28) ant.shock((1 - d / (radius + 28)) * (0.78 + intensity * 0.13));
    }
  }

  addFood(x, z, type = this.activeFoodType, options = {}) {
    const intensity = options.intensity ?? Number(ui.intensity.value);
    const config = getFoodType(type);
    const amount = (config.amountBase + intensity * config.amountPerIntensity) * (options.amountScale ?? 1);
    const radius = (config.radiusBase + intensity * config.radiusPerIntensity) * (options.radiusScale ?? 1);
    const placement = this.resolveFoodPlacement(x, z, radius, options);
    if (!placement) {
      ui.activeToolLabel.textContent = "そこには置けません";
      return null;
    }
    x = placement.x;
    z = placement.z;
    const group = new THREE.Group();
    const item = {
      id: this.nextFoodId,
      type: config.id,
      config,
      source: options.source ?? "player",
      natural: Boolean(options.natural),
      x,
      z,
      radius,
      amount,
      initialAmount: amount,
      age: options.age ?? 0,
      quality: 1,
      decayPulse: rand(0, 1.5),
      harvestProgress: 0,
      harvesterCount: 0,
      harvestPower: 0,
      lastHarvesterCount: 0,
      lastHarvestPower: 0,
      group,
      crumbs: [],
      spawnHighlight: null,
    };
    this.nextFoodId += 1;
    const crumbCount = this.getFoodCrumbCount(config, item);
    for (let i = 0; i < crumbCount; i += 1) {
      const crumb = new THREE.Mesh(this.getFoodGeometry(config, i), this.materials.foodByType[config.id] ?? this.materials.food);
      this.configureFoodCrumb(crumb, config, item, i, crumbCount);
      crumb.castShadow = this.quality.shadowQuality !== "off";
      crumb.receiveShadow = this.quality.shadowQuality !== "off";
      group.add(crumb);
      item.crumbs.push(crumb);
    }
    if (item.natural) this.addFoodSpawnHighlight(item, group);
    group.position.set(x, this.getSurfaceY(x, z), z);
    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.food.push(item);
    return item;
  }

  resolveFoodPlacement(x, z, radius, options = {}) {
    if (Math.hypot(x, z) + radius > this.worldRadius - 2) return null;
    if (distance2(x, z, this.nest.x, this.nest.z) < this.nest.radius + radius + 2 && options.source !== "natural") return { x, z };
    const terrain = this.terrain;
    if (!terrain?.effectsEnabled) return { x, z };
    if (!terrain.isBlockedArea(x, z, radius)) return { x, z };
    return terrain.findNearestOpenPoint(x, z, radius);
  }

  getFoodCrumbCount(config, item) {
    const style = config.modelStyle;
    if (style === "liquid") return 8;
    if (style === "seedPile") return clamp(Math.round(item.radius * 4.2), 22, 46);
    if (style === "largeFruit") return clamp(Math.round(item.radius * 3.4), 24, 42);
    if (style === "largeChunk" || style === "mixedScrap") return clamp(Math.round(item.radius * 3.1), 22, 38);
    if (style === "shard" || style === "proteinChunk") return clamp(Math.round(item.radius * 2.6), 16, 30);
    if (style === "softFruit" || style === "fruitChunk") return clamp(Math.round(item.radius * 2.8), 18, 32);
    return clamp(Math.round(item.radius * 2.4), 14, 26);
  }

  getFoodGeometry(config, index) {
    const style = config.modelStyle;
    if (style === "liquid") return index % 3 === 0 ? this.geometries.foodDisc : this.geometries.foodCrumb;
    if (style === "seedPile") return this.geometries.foodSeed;
    if (style === "shard" || style === "proteinChunk" || style === "largeChunk" || style === "mixedScrap") return this.geometries.foodShard;
    if (style === "fruitChunk" || style === "softFruit" || style === "largeFruit") return index % 4 === 0 ? this.geometries.foodDisc : this.geometries.foodShard;
    return this.geometries.foodCrumb;
  }

  configureFoodCrumb(crumb, config, item, index, count) {
    const style = config.modelStyle;
    const angle = rand(0, Math.PI * 2);
    const spread = style === "largeFruit" || style === "largeChunk" ? item.radius * 0.9 : item.radius;
    const radius = style === "liquid" ? rand(0, item.radius * 0.62) : rand(0, spread);
    crumb.position.set(Math.cos(angle) * radius, 0.44 + index * 0.001, Math.sin(angle) * radius);
    crumb.rotation.set(rand(-0.45, 0.45), rand(0, Math.PI), rand(-0.45, 0.45));

    if (style === "liquid") {
      const s = rand(0.52, 1.18);
      crumb.position.y = 0.18 + index * 0.001;
      crumb.scale.set(s * rand(1.1, 2.3), 0.08 + s * 0.06, s * rand(0.78, 1.55));
    } else if (style === "seedPile") {
      const s = rand(0.26, 0.54);
      crumb.position.y = 0.28 + rand(0, 0.48);
      crumb.scale.set(s * 0.7, s * 0.46, s * 1.32);
    } else if (style === "softFruit") {
      const s = rand(0.4, 0.86);
      crumb.position.y = 0.36 + rand(0, 0.45);
      crumb.scale.set(s * rand(0.9, 1.5), s * rand(0.26, 0.54), s * rand(0.85, 1.45));
    } else if (style === "fruitChunk") {
      const s = rand(0.46, 0.92);
      crumb.position.y = 0.42 + rand(0, 0.62);
      crumb.scale.set(s * rand(1.0, 1.7), s * rand(0.32, 0.62), s * rand(0.85, 1.45));
    } else if (style === "largeFruit") {
      const s = rand(0.62, 1.22);
      crumb.position.y = 0.46 + rand(0, 0.82);
      crumb.scale.set(s * rand(1.2, 2.1), s * rand(0.34, 0.72), s * rand(0.92, 1.7));
    } else if (style === "shard") {
      const s = rand(0.34, 0.72);
      crumb.position.y = 0.38 + rand(0, 0.48);
      crumb.scale.set(s * rand(0.8, 1.6), s * rand(0.35, 0.72), s * rand(0.75, 1.5));
    } else if (style === "proteinChunk" || style === "largeChunk") {
      const s = rand(0.46, style === "largeChunk" ? 1.18 : 0.82);
      crumb.position.y = 0.42 + rand(0, style === "largeChunk" ? 0.78 : 0.48);
      crumb.scale.set(s * rand(0.9, 1.75), s * rand(0.42, 0.82), s * rand(0.8, 1.55));
    } else if (style === "mixedScrap") {
      const s = rand(0.42, 1.02);
      crumb.position.y = 0.42 + rand(0, 0.66);
      crumb.scale.set(s * rand(0.8, 1.8), s * rand(0.32, 0.76), s * rand(0.7, 1.55));
    } else {
      const s = rand(0.28, 0.62);
      crumb.position.y = 0.42 + rand(0, 0.38);
      crumb.scale.setScalar(s);
    }

    if (count > 1 && index > count * 0.72) crumb.position.y += rand(0.04, 0.22);
  }

  addFoodSpawnHighlight(item, group) {
    const ring = new THREE.Mesh(this.geometries.impactRing, this.materials.foodSpawn.clone());
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.09;
    ring.scale.setScalar(item.radius * 0.72);
    ring.userData.age = 0;
    group.add(ring);
    item.spawnHighlight = ring;
  }

  getFoodById(sourceId) {
    if (sourceId == null) return null;
    return this.food.find((item) => item.id === sourceId) ?? null;
  }

  getFoodSource(sourceId) {
    if (sourceId == null) return null;
    return this.food.find((item) => item.id === sourceId && item.amount > 0.05 && (item.quality ?? 1) > 0.1) ?? null;
  }

  refreshFoodMesh(food) {
    const ratio = clamp(food.amount / food.initialAmount, 0, 1);
    const quality = food.quality ?? 1;
    const config = food.config ?? getFoodType(food.type);
    const baseScale = config.modelStyle === "liquid" ? 0.58 + ratio * 0.42 : 0.84 + ratio * 0.16;
    food.group.scale.setScalar(baseScale * (0.9 + quality * 0.1));
    food.crumbs.forEach((crumb, index) => {
      const visibilityCutoff = config.cooperative ? ratio : ratio * 1.05;
      crumb.visible = index / food.crumbs.length < visibilityCutoff;
    });
    if (food.amount <= 0.05) {
      this.fadeFoodTrails(food.id);
      this.pheromones?.dampen("food", food.x, food.z, 0.72, food.radius + 12);
      this.pheromones?.dampen("trunk", food.x, food.z, 0.42, food.radius + 16);
      this.pheromones?.deposit("avoid", food.x, food.z, 0.48, food.radius + 6);
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
      this.pheromones?.dampen("food", trail.x, trail.z, 0.55, 4.5);
      this.pheromones?.dampen("trunk", trail.x, trail.z, 0.22, 5.5);
    }
  }

  addBranch(branch) {
    const dx = branch.x2 - branch.x1;
    const dz = branch.z2 - branch.z1;
    const length = Math.hypot(dx, dz);
    const width = 1.35 + Number(ui.intensity.value) * 0.18;
    const direction = new THREE.Vector3(dx, 0, dz).normalize();
    const side = new THREE.Vector3(-direction.z, 0, direction.x);
    const up = new THREE.Vector3(0, 1, 0);
    const centerX = (branch.x1 + branch.x2) / 2;
    const centerZ = (branch.z1 + branch.z2) / 2;
    const center = new THREE.Vector3(centerX, this.getSurfaceY(centerX, centerZ, width * 0.95), centerZ);
    const group = new THREE.Group();

    const contactShadow = new THREE.Mesh(this.geometries.waterCircle, this.materials.branchShadow.clone());
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.rotation.z = -Math.atan2(dz, dx);
    contactShadow.position.set(center.x, this.getSurfaceY(center.x, center.z, 0.024), center.z);
    contactShadow.scale.set(length * 0.52, width * 2.1, 1);
    group.add(contactShadow);

    const start = new THREE.Vector3(branch.x1, this.getSurfaceY(branch.x1, branch.z1, width * 0.92), branch.z1);
    const end = new THREE.Vector3(branch.x2, this.getSurfaceY(branch.x2, branch.z2, width * 0.92), branch.z2);
    const segmentCount = clamp(Math.floor(length / 10), 4, 8);
    const points = [];
    const bendPhase = rand(0, Math.PI * 2);
    for (let i = 0; i <= segmentCount; i += 1) {
      const t = i / segmentCount;
      const endpointFade = Math.sin(t * Math.PI);
      const wobble = side.clone().multiplyScalar(endpointFade * Math.sin(t * Math.PI * 2 + bendPhase) * width * rand(0.12, 0.34));
      const lift = Math.sin(t * Math.PI) * width * rand(0.02, 0.12);
      const point = start.clone().lerp(end, t).add(wobble);
      point.y = this.getSurfaceY(point.x, point.z, width * 0.92 + lift);
      points.push(point);
    }

    for (let i = 0; i < points.length - 1; i += 1) {
      const t = i / Math.max(1, points.length - 2);
      const radiusA = width * (1.02 - t * 0.28) * rand(0.94, 1.08);
      const radiusB = width * (0.94 - t * 0.3) * rand(0.9, 1.04);
      const trunk = createCylinderBetween(points[i], points[i + 1], radiusB, radiusA, this.materials.branch, 12);
      trunk.castShadow = this.quality.shadowQuality !== "off";
      trunk.receiveShadow = this.quality.shadowQuality !== "off";
      group.add(trunk);
    }

    for (const offset of [-0.5, 0.5]) {
      const knob = new THREE.Mesh(this.geometries.branchKnob, this.materials.branchTip);
      knob.position.copy(offset < 0 ? points[0] : points[points.length - 1]);
      knob.position.y += width * 0.02;
      knob.scale.set(width * rand(0.68, 0.92), width * rand(0.42, 0.62), width * rand(0.68, 0.92));
      knob.castShadow = this.quality.shadowQuality !== "off";
      group.add(knob);
    }

    const knotCount = clamp(Math.floor(length / 8), 2, 6);
    for (let i = 0; i < knotCount; i += 1) {
      const t = (i + 1) / (knotCount + 1);
      const knotLength = width * rand(0.2, 0.42);
      const knotGeometry = new THREE.CylinderGeometry(width * rand(0.82, 1.04), width * rand(0.76, 0.96), knotLength, 10);
      const knot = new THREE.Mesh(knotGeometry, this.materials.branchDark);
      const segmentIndex = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
      const segmentT = t * (points.length - 1) - segmentIndex;
      const segmentDirection = points[segmentIndex + 1].clone().sub(points[segmentIndex]).normalize();
      knot.position.copy(points[segmentIndex]).lerp(points[segmentIndex + 1], segmentT);
      knot.position.y += width * 0.012;
      knot.quaternion.setFromUnitVectors(up, segmentDirection);
      knot.castShadow = this.quality.shadowQuality !== "off";
      group.add(knot);
    }

    const twigCount = clamp(Math.floor(length / 13), 1, 4);
    for (let i = 0; i < twigCount; i += 1) {
      const t = rand(0.18, 0.84);
      const sideSign = chance(0.5) ? 1 : -1;
      const twigLength = width * rand(2.4, 4.6);
      const twigWidth = width * rand(0.18, 0.32);
      const segmentIndex = Math.min(points.length - 2, Math.floor(t * (points.length - 1)));
      const segmentT = t * (points.length - 1) - segmentIndex;
      const segmentDirection = points[segmentIndex + 1].clone().sub(points[segmentIndex]).normalize();
      const twigDirection = direction
        .clone()
        .multiplyScalar(rand(-0.18, 0.28))
        .add(side.clone().multiplyScalar(sideSign * rand(0.64, 0.96)))
        .add(segmentDirection.multiplyScalar(0.18))
        .normalize();
      const base = points[segmentIndex].clone().lerp(points[segmentIndex + 1], segmentT);
      const twigGeometry = new THREE.CylinderGeometry(twigWidth * 0.8, twigWidth * 1.18, twigLength, 8);
      const twig = new THREE.Mesh(twigGeometry, this.materials.branch);
      twig.position.copy(base).add(twigDirection.clone().multiplyScalar(twigLength * 0.48));
      twig.position.y += width * 0.04;
      twig.quaternion.setFromUnitVectors(up, twigDirection);
      twig.castShadow = this.quality.shadowQuality !== "off";
      twig.receiveShadow = this.quality.shadowQuality !== "off";
      group.add(twig);
    }

    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.branches.push({ ...branch, width: width * 1.45, group });
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
    const centerX = (this.branchDraft.x1 + this.branchDraft.x2) / 2;
    const centerZ = (this.branchDraft.z1 + this.branchDraft.z2) / 2;
    mesh.position.set(centerX, this.getSurfaceY(centerX, centerZ, 0.7), centerZ);
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
      (item) => {
        this.fadeFoodTrails(item.id);
        this.pheromones?.dampen("food", item.x, item.z, 0.78, item.radius + 12);
        this.pheromones?.dampen("trunk", item.x, item.z, 0.46, item.radius + 16);
        this.pheromones?.deposit("avoid", item.x, item.z, 0.52, item.radius + 6);
      },
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
    mesh.position.set(x, this.getSurfaceY(x, z, 0.055), z);
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
      sourceType: options.sourceType ?? null,
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
      if (ant === helper || ant.insideNest || ant.stun <= 0) continue;
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
      if (ant.insideNest) continue;
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
    let insideNest = 0;
    for (const ant of this.ants) {
      if (ant.insideNest) insideNest += 1;
      else if (ant.state === "panic" || ant.state === "wet" || ant.state === "stunned") alert += 1;
      else if (ant.state === "rescue") rescue += 1;
      else explore += 1;
    }
    ui.statExplore.textContent = insideNest > 0 ? `${explore}+${insideNest}` : explore;
    ui.statAlert.textContent = alert;
    ui.statRescue.textContent = rescue;
    ui.statFood.textContent = Math.floor(this.collectedFood);
  }

  updateInspector() {
    const ant = this.selectedAnt;
    if (!ant) {
      let naturalFoodCount = 0;
      let insideNestCount = 0;
      for (const item of this.food) if (item.natural) naturalFoodCount += 1;
      for (const colonyAnt of this.ants) if (colonyAnt.insideNest) insideNestCount += 1;
      ui.inspector.innerHTML = `
        <strong>コロニー貯蔵</strong>
        <div class="trait-grid">
          <span>エネルギー ${Math.floor(this.colonyStores.energy)}</span>
          <span>貯蔵 ${Math.floor(this.colonyStores.storage)}</span>
          <span>育児 ${Math.floor(this.colonyStores.brood)}</span>
          <span>搬入 ${Math.floor(this.collectedFood)}</span>
          <span>自然餌 ${naturalFoodCount}</span>
          <span>餌総数 ${this.food.length}</span>
          <span>巣内 ${insideNestCount}</span>
        </div>
      `;
      return;
    }
    const carryingConfig = ant.carrying > 0 ? getFoodType(ant.carryingFoodType) : null;
    const targetFood = this.getFoodById(ant.targetFoodId);
    const targetConfig = targetFood ? getFoodType(targetFood.type) : null;
    const activity = carryingConfig
      ? `運搬: ${carryingConfig.label}`
      : ant.insideNest
        ? `巣内待機: ${Math.ceil(ant.nestTimer)}秒`
        : targetConfig
          ? `採取: ${targetConfig.label}`
          : "運搬: なし";
    const targetDetail = targetFood
      ? `品質 ${Math.round((targetFood.quality ?? 1) * 100)}% / 協力 ${targetFood.lastHarvesterCount ?? 0}/${targetConfig.requiredHelpers}`
      : carryingConfig
        ? `品質 ${Math.round((ant.carryingFoodQuality ?? 1) * 100)}%`
        : "餌対象なし";
    ui.inspector.innerHTML = `
      <strong>個体 ${ant.id} / ${ROLE_LABELS[ant.role]} / ${STATE_LABELS[ant.state]}</strong>
      <div class="trait-grid">
        <span>好奇心 ${Math.round(ant.traits.curiosity * 100)}</span>
        <span>警戒心 ${Math.round(ant.traits.caution * 100)}</span>
        <span>協調性 ${Math.round(ant.traits.social * 100)}</span>
        <span>粘り ${Math.round(ant.traits.persistence * 100)}</span>
        <span>${activity}</span>
        <span>${targetDetail}</span>
        <span>経路誤差 ${ant.pathError.toFixed(1)}</span>
      </div>
    `;
  }
}

new AntColony3D();
