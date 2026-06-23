import * as THREE from "three";

const ui = {
  world: document.querySelector("#world3d"),
  buttons: [...document.querySelectorAll(".tool-button")],
  activeToolLabel: document.querySelector("#activeToolLabel"),
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
};

const ANT_FORMATION_PARAMS = {
  hardRadius: 0.82,
  personalRadius: 2.05,
  sameDirectionRadius: 5.2,
  laneWidth: 1.15,
  sideBySideForwardRange: 1.85,
  followGap: 3.05,
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
  gradient.addColorStop(0, "#5f3f20");
  gradient.addColorStop(0.38, "#9a6935");
  gradient.addColorStop(0.72, "#6f471f");
  gradient.addColorStop(1, "#b47c43");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 192);

  for (let i = 0; i < 90; i += 1) {
    const y = Math.random() * 192;
    const alpha = rand(0.1, 0.34);
    context.strokeStyle = Math.random() > 0.45 ? `rgba(42,25,13,${alpha})` : `rgba(233,174,101,${alpha * 0.7})`;
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
    context.fillStyle = "rgba(39,22,12,0.28)";
    context.beginPath();
    context.ellipse(x, y, rand(5, 18), rand(2, 7), rand(-0.6, 0.6), 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(202,132,65,0.24)";
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
    let pathErrorSum = 0;
    for (const ant of this.sim.ants) {
      if (ant.state === "return") returnCount += 1;
      else if (ant.state === "searchNest") searchNestCount += 1;
      pathErrorSum += ant.pathError ?? 0;
    }
    const averagePathError = this.sim.ants.length > 0 ? pathErrorSum / this.sim.ants.length : 0;
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
      `pathError ${averagePathError.toFixed(1)}`,
      `pheromone ${this.sim.pheromones?.mode ?? "off"} ${this.sim.pheromones?.resolution ?? 0}`,
    ].join("\n");
    this.elapsed = 0;
    this.frames = 0;
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
    this.gridScratch = { gx: 0, gz: 0 };
    this.gradientScratch = { x: 0, z: 0 };
    this.antennaeScratch = { left: 0, right: 0, front: 0, peak: 0, turn: 0, strength: 0 };

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
    this.geometry = new THREE.PlaneGeometry(this.fieldSize, this.fieldSize, 1, 1);
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
    this.overlay.position.y = 0.055;
    this.overlay.renderOrder = 2;
    this.overlay.visible = false;
    this.overlay.matrixAutoUpdate = false;
    this.overlay.updateMatrix();
    sim.scene.add(this.overlay);
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
    this.overlay = null;
    this.geometry = null;
    this.material = null;
    this.texture = null;
  }

  update(dt) {
    let changed = false;
    for (const channel of PHEROMONE_FIELD_CHANNELS) {
      const field = this.fields[channel];
      const decayFactor = Math.exp(-PHEROMONE_FIELD_PARAMS[channel].decay * dt);
      for (let i = 0; i < field.length; i += 1) {
        const value = field[i];
        if (value <= 0) continue;
        const next = value * decayFactor;
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
    scratch.set(field);
    for (let z = 1; z < r - 1; z += 1) {
      const row = z * r;
      for (let x = 1; x < r - 1; x += 1) {
        const i = row + x;
        scratch[i] = field[i] * keep + (field[i - 1] + field[i + 1] + field[i - r] + field[i + r]) * blend * 0.25;
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
    const grid = this.worldToGrid(x, z);
    const cellRadius = Math.ceil(radius * this.invCellSize) + 1;
    const minX = clamp(Math.floor(grid.gx) - cellRadius, 0, this.resolution - 1);
    const maxX = clamp(Math.floor(grid.gx) + cellRadius, 0, this.resolution - 1);
    const minZ = clamp(Math.floor(grid.gz) - cellRadius, 0, this.resolution - 1);
    const maxZ = clamp(Math.floor(grid.gz) + cellRadius, 0, this.resolution - 1);
    const sigma = Math.max(this.cellSize * 0.75, radius * 0.45);
    const sigma2 = sigma * sigma;

    for (let gz = minZ; gz <= maxZ; gz += 1) {
      const wz = (gz + 0.5) * this.cellSize - this.fieldRadius;
      const dz = wz - z;
      const row = gz * this.resolution;
      for (let gx = minX; gx <= maxX; gx += 1) {
        const wx = (gx + 0.5) * this.cellSize - this.fieldRadius;
        const dx = wx - x;
        const dist2Value = dx * dx + dz * dz;
        if (dist2Value > radius * radius) continue;
        const falloff = Math.exp(-dist2Value / (2 * sigma2));
        const index = row + gx;
        field[index] = Math.min(this.maxValue, field[index] + strength * falloff);
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
    const point = this.findSpawnPoint(spawnRadius);
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

  findSpawnPoint(spawnRadius) {
    const usableRadius = this.sim.worldRadius - spawnRadius - 4;
    if (usableRadius <= this.sim.nest.radius + spawnRadius + 8) return null;
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
    else if (this.state === "harvest") this.updateHarvest(dt, sim, steering);
    else if (this.state === "return") this.updateReturn(dt, sim, steering);
    else if (this.state === "searchNest") this.updateSearchNest(dt, sim, steering);
    else if (this.state === "rescue") this.updateRescue(dt, sim, steering);
    else this.updateExplore(dt, sim, steering, sensed);

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

    const angularNoise = rand(-HOMING_PARAMS.pathAngularNoise, HOMING_PARAMS.pathAngularNoise) + this.pathDrift * clamp(distance / 12, 0, 1.5);
    const distanceScale = this.pathDistanceBias * (1 + rand(-HOMING_PARAMS.pathDistanceNoise, HOMING_PARAMS.pathDistanceNoise));
    const sin = Math.sin(angularNoise);
    const cos = Math.cos(angularNoise);
    const estimatedDX = (dx * cos - dz * sin) * distanceScale;
    const estimatedDZ = (dx * sin + dz * cos) * distanceScale;

    this.pathX += estimatedDX;
    this.pathZ += estimatedDZ;
    this.pathError = clamp(
      this.pathError + distance * HOMING_PARAMS.pathErrorGain * (1 + Math.abs(angularNoise) * 10),
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
    this.setState("explore");
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
      const turnAngle = this.angle - bestTurn * 0.45;
      const gain = clamp(bestStrength, 0, 0.65) * 0.28;
      steering.x += Math.sin(turnAngle) * gain;
      steering.z += Math.cos(turnAngle) * gain;
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
      const effectiveDetectRadius = config.detectRadius * (0.74 + this.traits.curiosity * 0.46) * (0.78 + quality * 0.22);
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
      const effectiveRange = config.detectRadius * (0.72 + this.traits.curiosity * 0.42);
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
        const turnAngle = this.angle - foodSignal.turn * 0.85;
        const gain =
          clamp(foodSignal.strength, 0, 1.2) *
          PHEROMONE_PARAMS.foodFollowGain *
          (0.75 + this.traits.curiosity * 0.65) *
          (0.82 + this.traits.social * 0.28);
        steering.x += Math.sin(turnAngle) * gain;
        steering.z += Math.cos(turnAngle) * gain;
      }

      const trunkSignal = sim.pheromones.sampleAntennae("trunk", this.x, this.z, this.angle, this.trunkAntennaeOptions);
      if (trunkSignal.strength > 0) {
        const turnAngle = this.angle - trunkSignal.turn * 0.6;
        const gain = clamp(trunkSignal.strength, 0, 0.75) * PHEROMONE_PARAMS.foodFollowGain * (0.18 + this.traits.social * 0.16);
        steering.x += Math.sin(turnAngle) * gain;
        steering.z += Math.cos(turnAngle) * gain;
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

    if (this.homeTimer > 9 + this.traits.persistence * 7 || this.energy < 0.2) {
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

    this.wander += (Math.random() - 0.5) * dt * (2.3 + this.traits.curiosity * 3.2) + this.turnBias * dt;
    steering.x += Math.sin(this.wander) * (0.58 + this.traits.curiosity * 0.5);
    steering.z += Math.cos(this.wander) * (0.58 + this.traits.curiosity * 0.5);

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
    if (realNestDistance < sim.nest.radius * HOMING_PARAMS.nestArriveRadiusMultiplier) {
      this.completeNestArrival(sim);
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
    if (realNestDistance < sim.nest.radius * HOMING_PARAMS.nestArriveRadiusMultiplier) {
      this.completeNestArrival(sim);
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
          if (other === this) continue;
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

          if (forwardOffset > 0 && forwardOffset < ANT_FORMATION_PARAMS.followGap && absLateral < ANT_FORMATION_PARAMS.laneWidth) {
            const strength = (1 - forwardOffset / ANT_FORMATION_PARAMS.followGap) * (1 - absLateral / ANT_FORMATION_PARAMS.laneWidth) * 0.48;
            sx -= forwardX * strength;
            sz -= forwardZ * strength;
            count += 1;
          } else if (
            absForward < ANT_FORMATION_PARAMS.sideBySideForwardRange &&
            absLateral > ANT_FORMATION_PARAMS.laneWidth &&
            absLateral < ANT_FORMATION_PARAMS.personalRadius + 1.35
          ) {
            const sideSign = lateralOffset >= 0 ? 1 : -1;
            const orderSign = this.id > other.id ? -1 : 1;
            const sideBySideStrength =
              (1 - absForward / ANT_FORMATION_PARAMS.sideBySideForwardRange) *
              (1 - (absLateral - ANT_FORMATION_PARAMS.laneWidth) / (ANT_FORMATION_PARAMS.personalRadius + 1.35 - ANT_FORMATION_PARAMS.laneWidth));
            sx += rightX * sideSign * sideBySideStrength * 0.18 + forwardX * orderSign * sideBySideStrength * 0.34;
            sz += rightZ * sideSign * sideBySideStrength * 0.18 + forwardZ * orderSign * sideBySideStrength * 0.34;
            count += 1;
          } else if (d < ANT_FORMATION_PARAMS.personalRadius) {
            const strength = (1 - d / ANT_FORMATION_PARAMS.personalRadius) * 0.24;
            sx += awayX * strength;
            sz += awayZ * strength;
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
    speed *= sim.timeScale;

    this.x += Math.sin(this.angle) * speed * dt;
    this.z += Math.cos(this.angle) * speed * dt;
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
    this.paused = false;
    this.timeScale = 1;
    this.worldRadius = 156;
    this.fieldMargin = 14;
    this.nest = { x: -42, z: 12, radius: 12 };
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

    this.cameraTarget = new THREE.Vector3(this.nest.x * 0.55, 0, this.nest.z * 0.55);
    this.cameraRenderTarget = this.cameraTarget.clone();
    this.cameraYaw = -0.62;
    this.cameraPitch = 1.05;
    this.targetCameraYaw = this.cameraYaw;
    this.targetCameraPitch = this.cameraPitch;
    this.cameraDistance = this.getDefaultCameraDistance();
    this.targetCameraDistance = this.cameraDistance;

    this.sharedGeometries = new Set();
    this.sharedMaterials = new Set();
    this.dynamicObjects = new Set();

    this.assetService.preloadProceduralAssets();
    this.createSharedAssets();
    this.antRenderer = new AntRenderSystem(this, Number(ui.antCount.max));
    this.createWorld();
    this.pheromones = new PheromoneFieldSystem(this);
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
      nestDark: new THREE.MeshBasicMaterial({ color: 0x1d140e }),
      antDefault: new THREE.MeshStandardMaterial({ color: 0x18130f, roughness: 0.72 }),
      antAppendage: new THREE.MeshStandardMaterial({ color: 0x12100d, roughness: 0.82 }),
      food: new THREE.MeshStandardMaterial({ color: 0xd9a63f, roughness: 0.62 }),
      stone: new THREE.MeshStandardMaterial({ color: 0x777c75, roughness: 0.86 }),
      branch: new THREE.MeshStandardMaterial({
        color: 0x9a6a35,
        map: this.assetService.get("branchBarkTexture"),
        bumpMap: this.assetService.get("branchBumpTexture"),
        bumpScale: 0.18,
        roughness: 0.94,
      }),
      branchDark: new THREE.MeshStandardMaterial({
        color: 0x5d371c,
        map: this.assetService.get("branchBarkTexture"),
        bumpMap: this.assetService.get("branchBumpTexture"),
        bumpScale: 0.24,
        roughness: 0.98,
      }),
      branchTip: new THREE.MeshStandardMaterial({
        color: 0xc38644,
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
    ground.position.y = -0.03;
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
        ui.activeToolLabel.textContent = this.tool === "food" ? `餌: ${getFoodType(this.activeFoodType).label}` : button.dataset.label;
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

    const canvas = this.renderer.domElement;
    this.input = new InputManager(this, canvas);
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
    this.foodSpawner?.reset();
    this.selectedAnt = null;
    const count = Number(ui.antCount.value);
    for (let i = 0; i < count; i += 1) this.ants.push(new Ant3D(i + 1, this));
    this.updateStats();
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

  getDefaultCameraDistance() {
    return window.innerWidth < 680 ? this.worldRadius * 1.85 : this.worldRadius * 1.74;
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
    this.foodSpawner?.update(dt);
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
    if (d > this.worldRadius + this.fieldMargin) return null;
    return { x: hit.x, z: hit.z };
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
    group.position.set(x, 0, z);
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
    group.position.set(x, 0, z);
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
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.dynamicObjects.add(group);
    this.food.push(item);
    return item;
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
    const center = new THREE.Vector3((branch.x1 + branch.x2) / 2, width * 0.95, (branch.z1 + branch.z2) / 2);
    const group = new THREE.Group();

    const contactShadow = new THREE.Mesh(this.geometries.waterCircle, this.materials.branchShadow.clone());
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.rotation.z = -Math.atan2(dz, dx);
    contactShadow.position.set(center.x, 0.024, center.z);
    contactShadow.scale.set(length * 0.52, width * 2.1, 1);
    group.add(contactShadow);

    const start = new THREE.Vector3(branch.x1, width * 0.92, branch.z1);
    const end = new THREE.Vector3(branch.x2, width * 0.92, branch.z2);
    const segmentCount = clamp(Math.floor(length / 10), 4, 8);
    const points = [];
    const bendPhase = rand(0, Math.PI * 2);
    for (let i = 0; i <= segmentCount; i += 1) {
      const t = i / segmentCount;
      const endpointFade = Math.sin(t * Math.PI);
      const wobble = side.clone().multiplyScalar(endpointFade * Math.sin(t * Math.PI * 2 + bendPhase) * width * rand(0.12, 0.34));
      const lift = Math.sin(t * Math.PI) * width * rand(0.02, 0.12);
      points.push(start.clone().lerp(end, t).add(wobble).add(new THREE.Vector3(0, lift, 0)));
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
      let naturalFoodCount = 0;
      for (const item of this.food) if (item.natural) naturalFoodCount += 1;
      ui.inspector.innerHTML = `
        <strong>コロニー貯蔵</strong>
        <div class="trait-grid">
          <span>エネルギー ${Math.floor(this.colonyStores.energy)}</span>
          <span>貯蔵 ${Math.floor(this.colonyStores.storage)}</span>
          <span>育児 ${Math.floor(this.colonyStores.brood)}</span>
          <span>搬入 ${Math.floor(this.collectedFood)}</span>
          <span>自然餌 ${naturalFoodCount}</span>
          <span>餌総数 ${this.food.length}</span>
        </div>
      `;
      return;
    }
    const carryingConfig = ant.carrying > 0 ? getFoodType(ant.carryingFoodType) : null;
    const targetFood = this.getFoodById(ant.targetFoodId);
    const targetConfig = targetFood ? getFoodType(targetFood.type) : null;
    const activity = carryingConfig
      ? `運搬: ${carryingConfig.label}`
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
