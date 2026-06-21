import {
  INITIAL_ANTS,
  MAX_ITEMS,
  MAX_PHEROMONES,
  MAX_RENDERED_ANTS,
  NEST_RADIUS,
  SAVE_VERSION,
  WORLD_RADIUS
} from './constants';
import { getRuntimeStats, rebalanceSoldiers, recalculateCombatStats } from './upgrades';
import type {
  AntAgent,
  AntPersonality,
  ColonyState,
  GameState,
  ItemType,
  Pheromone,
  PheromoneSignal,
  PlacedItem,
  ToolType,
  UpgradeLevels,
  UpgradeId
} from './types';

const UPGRADE_IDS: UpgradeId[] = [
  'foragerTrails',
  'broodNursery',
  'storageChambers',
  'queenCare',
  'soldierTraining',
  'mandibleStrength',
  'nestGuard',
  'tacticalPheromone'
];

export function createUpgradeLevels(seed?: Partial<Record<UpgradeId, number>>): UpgradeLevels {
  const levels = {} as UpgradeLevels;
  for (const id of UPGRADE_IDS) {
    levels[id] = Math.max(0, Math.floor(seed?.[id] ?? 0));
  }
  return levels;
}

export function createDefaultColony(now = Date.now()): ColonyState {
  const colony: ColonyState = {
    version: SAVE_VERSION,
    food: 28,
    lifetimeFood: 28,
    antPopulation: INITIAL_ANTS,
    soldierAnts: 2,
    woundedAnts: 0,
    attackPower: 1,
    defensePower: 1,
    nestLevel: 1,
    territory: 0,
    enemyThreat: 0.8,
    battleCooldownUntil: 0,
    unlockedEnemyColonies: ['weak'],
    upgrades: createUpgradeLevels(),
    battleLog: [],
    lastSavedAt: now
  };
  recalculateCombatStats(colony);
  rebalanceSoldiers(colony);
  return colony;
}

export function createGameState(colony = createDefaultColony()): GameState {
  const state: GameState = {
    colony,
    ants: [],
    items: [],
    pheromones: [],
    selectedTool: 'observe',
    paused: false,
    worldTime: 0,
    broodProgress: 0,
    itemRevision: 0,
    pheromoneRevision: 0,
    nextAntId: 1,
    nextItemId: 1,
    nextPheromoneId: 1
  };
  seedStartingItems(state);
  syncRenderedAnts(state);
  return state;
}

export function syncRenderedAnts(state: GameState): void {
  const target = Math.min(MAX_RENDERED_ANTS, Math.max(0, Math.floor(state.colony.antPopulation)));
  while (state.ants.length < target) {
    state.ants.push(createAnt(state.nextAntId++, state.ants.length));
  }
  if (state.ants.length > target) {
    state.ants.length = target;
  }
}

export function createAnt(id: number, index: number): AntAgent {
  const angle = index * 2.399963 + id * 0.37;
  const radius = NEST_RADIUS * (0.35 + ((index * 53) % 100) / 210);
  return {
    id,
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius,
    dir: angle + Math.PI * 0.5,
    speed: 0.32 + seeded01(id, 11) * 0.18,
    role: index % 4 === 0 ? 'forage' : 'explore',
    carryingFood: 0,
    targetFoodId: null,
    wetTimer: 0,
    panicTimer: 0,
    pauseTimer: 0,
    decisionTimer: seeded01(id, 19) * 2,
    personality: createPersonality(id)
  };
}

export function createPersonality(seed: number): AntPersonality {
  return {
    curiosity: 0.75 + seeded01(seed, 3) * 0.55,
    bravery: 0.65 + seeded01(seed, 5) * 0.7,
    social: 0.7 + seeded01(seed, 7) * 0.65,
    efficiency: 0.75 + seeded01(seed, 13) * 0.5,
    nurse: 0.55 + seeded01(seed, 17) * 0.65
  };
}

export function addPlacedItem(
  state: GameState,
  type: ItemType,
  x: number,
  z: number,
  radiusOverride?: number
): PlacedItem | null {
  if (state.items.length >= MAX_ITEMS) {
    state.items.shift();
  }
  const radius =
    radiusOverride ??
    (type === 'water' ? 0.48 : type === 'object' ? 0.35 : type === 'branch' ? 0.56 : 0.38);
  const amount = type === 'food' ? 24 : type === 'water' ? 1 : 0;
  const item: PlacedItem = {
    id: state.nextItemId++,
    type,
    x: clamp(x, -WORLD_RADIUS, WORLD_RADIUS),
    z: clamp(z, -WORLD_RADIUS, WORLD_RADIUS),
    radius,
    amount,
    initialAmount: Math.max(amount, 1),
    rotation: seeded01(state.nextItemId, 23) * Math.PI * 2,
    bridge: type === 'branch'
  };
  state.items.push(item);
  state.itemRevision++;
  if (type === 'water') {
    addPheromone(state, 'water', item.x, item.z, 0.75, item.id, 0.72);
  }
  if (type === 'food') {
    addPheromone(state, 'food', item.x, item.z, 0.46, item.id, 0.72);
  }
  return item;
}

export function eraseAt(state: GameState, x: number, z: number): boolean {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    const distance = Math.hypot(item.x - x, item.z - z) - item.radius;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  if (bestIndex >= 0 && bestDistance < 0.42) {
    const [removed] = state.items.splice(bestIndex, 1);
    for (const pheromone of state.pheromones) {
      if (pheromone.sourceId === removed.id) {
        pheromone.decay = Math.max(pheromone.decay, 2.4);
      }
    }
    state.itemRevision++;
    state.pheromoneRevision++;
    return true;
  }
  return false;
}

export function addPheromone(
  state: GameState,
  signal: PheromoneSignal,
  x: number,
  z: number,
  strength: number,
  sourceId: number | null,
  radius = 0.44
): Pheromone {
  const existing = findNearbyPheromone(state, signal, x, z, sourceId, radius * 0.7);
  if (existing) {
    existing.strength = clamp(existing.strength + strength * 0.55, 0, 1.4);
    existing.radius = Math.max(existing.radius, radius);
    state.pheromoneRevision++;
    return existing;
  }
  if (state.pheromones.length >= MAX_PHEROMONES) {
    state.pheromones.sort((a, b) => a.strength - b.strength);
    state.pheromones.shift();
  }
  const pheromone: Pheromone = {
    id: state.nextPheromoneId++,
    signal,
    x: clamp(x, -WORLD_RADIUS, WORLD_RADIUS),
    z: clamp(z, -WORLD_RADIUS, WORLD_RADIUS),
    strength: clamp(strength, 0, 1.4),
    sourceId,
    radius,
    decay: signal === 'alarm' ? 0.55 : signal === 'water' ? 0.24 : 0.16
  };
  state.pheromones.push(pheromone);
  state.pheromoneRevision++;
  return pheromone;
}

export function setSelectedTool(state: GameState, tool: ToolType): void {
  state.selectedTool = tool;
}

export function getDisplayColonyStats(state: GameState) {
  return getRuntimeStats(state.colony);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function seeded01(seed: number, salt: number): number {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453123;
  return value - Math.floor(value);
}

function seedStartingItems(state: GameState): void {
  addPlacedItem(state, 'food', 2.1, -1.15, 0.42);
  addPlacedItem(state, 'branch', -1.25, 1.1, 0.62);
}

function findNearbyPheromone(
  state: GameState,
  signal: PheromoneSignal,
  x: number,
  z: number,
  sourceId: number | null,
  radius: number
): Pheromone | null {
  const radiusSq = radius * radius;
  for (const pheromone of state.pheromones) {
    if (pheromone.signal !== signal || pheromone.sourceId !== sourceId) {
      continue;
    }
    const dx = pheromone.x - x;
    const dz = pheromone.z - z;
    if (dx * dx + dz * dz <= radiusSq) {
      return pheromone;
    }
  }
  return null;
}
