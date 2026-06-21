import {
  BASE_CAPACITY,
  BASE_FOOD_RATE,
  BASE_HATCHES_PER_MINUTE,
  BASE_HEAL_PER_MINUTE
} from './constants';
import type { ColonyState, RuntimeStats, UpgradeCategory, UpgradeId } from './types';

export interface UpgradeDefinition {
  id: UpgradeId;
  name: string;
  category: UpgradeCategory;
  maxLevel: number;
  description: string;
  baseCost: number;
  costScale: number;
  requires: Partial<{
    ants: number;
    lifetimeFood: number;
    territory: number;
    nestLevel: number;
  }>;
}

export const UPGRADE_DEFINITIONS: UpgradeDefinition[] = [
  {
    id: 'foragerTrails',
    name: 'Forager Trails',
    category: 'growth',
    maxLevel: 6,
    description: '採餌効率と餌フェロモン追従を上げる',
    baseCost: 24,
    costScale: 1.58,
    requires: { ants: 12 }
  },
  {
    id: 'broodNursery',
    name: 'Brood Nursery',
    category: 'growth',
    maxLevel: 5,
    description: '孵化速度と看護回復を上げる',
    baseCost: 36,
    costScale: 1.65,
    requires: { lifetimeFood: 38 }
  },
  {
    id: 'storageChambers',
    name: 'Storage Chambers',
    category: 'growth',
    maxLevel: 6,
    description: '収容上限を伸ばし、巣Lvを押し上げる',
    baseCost: 42,
    costScale: 1.72,
    requires: { ants: 14 }
  },
  {
    id: 'queenCare',
    name: 'Queen Care',
    category: 'growth',
    maxLevel: 5,
    description: '産卵基礎力を上げる',
    baseCost: 58,
    costScale: 1.84,
    requires: { ants: 18, nestLevel: 1 }
  },
  {
    id: 'soldierTraining',
    name: 'Soldier Training',
    category: 'combat',
    maxLevel: 5,
    description: '兵隊比率と攻撃力を上げる',
    baseCost: 72,
    costScale: 1.76,
    requires: { ants: 22, lifetimeFood: 120 }
  },
  {
    id: 'mandibleStrength',
    name: 'Mandible Strength',
    category: 'combat',
    maxLevel: 5,
    description: '兵隊1匹あたりのダメージを上げる',
    baseCost: 92,
    costScale: 1.82,
    requires: { ants: 30, territory: 1 }
  },
  {
    id: 'nestGuard',
    name: 'Nest Guard',
    category: 'combat',
    maxLevel: 5,
    description: '防御力と負傷回復を上げる',
    baseCost: 84,
    costScale: 1.78,
    requires: { ants: 26, nestLevel: 2 }
  },
  {
    id: 'tacticalPheromone',
    name: 'Tactical Pheromone',
    category: 'combat',
    maxLevel: 4,
    description: '指揮効率と採餌補正を上げる',
    baseCost: 128,
    costScale: 1.9,
    requires: { ants: 34, territory: 3, lifetimeFood: 260 }
  }
];

export function getUpgradeLevel(colony: ColonyState, id: UpgradeId): number {
  return colony.upgrades[id] ?? 0;
}

export function getUpgradeCost(colony: ColonyState, definition: UpgradeDefinition): number {
  const level = getUpgradeLevel(colony, definition.id);
  return Math.ceil(definition.baseCost * Math.pow(definition.costScale, level));
}

export function getMissingRequirements(
  colony: ColonyState,
  definition: UpgradeDefinition
): string[] {
  const missing: string[] = [];
  const level = getUpgradeLevel(colony, definition.id);
  if (level >= definition.maxLevel) {
    return ['最大レベル'];
  }
  if (colony.food < getUpgradeCost(colony, definition)) {
    missing.push(`食料 ${Math.ceil(getUpgradeCost(colony, definition) - colony.food)}`);
  }
  if (definition.requires.ants && colony.antPopulation < definition.requires.ants) {
    missing.push(`蟻 ${definition.requires.ants}`);
  }
  if (
    definition.requires.lifetimeFood &&
    colony.lifetimeFood < definition.requires.lifetimeFood
  ) {
    missing.push(`累計食料 ${definition.requires.lifetimeFood}`);
  }
  if (definition.requires.territory && colony.territory < definition.requires.territory) {
    missing.push(`領土 ${definition.requires.territory}`);
  }
  if (definition.requires.nestLevel && colony.nestLevel < definition.requires.nestLevel) {
    missing.push(`巣Lv ${definition.requires.nestLevel}`);
  }
  return missing;
}

export function canPurchaseUpgrade(
  colony: ColonyState,
  definition: UpgradeDefinition
): boolean {
  return getMissingRequirements(colony, definition).length === 0;
}

export function purchaseUpgrade(colony: ColonyState, id: UpgradeId): boolean {
  const definition = UPGRADE_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition || !canPurchaseUpgrade(colony, definition)) {
    return false;
  }
  const cost = getUpgradeCost(colony, definition);
  colony.food = Math.max(0, colony.food - cost);
  colony.upgrades[id] += 1;
  if (id === 'storageChambers') {
    colony.nestLevel = Math.max(colony.nestLevel, 1 + Math.ceil(colony.upgrades[id] / 2));
  }
  recalculateCombatStats(colony);
  return true;
}

export function getAntCapacity(colony: ColonyState): number {
  const storage = getUpgradeLevel(colony, 'storageChambers');
  return BASE_CAPACITY + colony.nestLevel * 10 + storage * 12 + colony.territory * 3;
}

export function getForageMultiplier(colony: ColonyState): number {
  return (
    1 +
    getUpgradeLevel(colony, 'foragerTrails') * 0.18 +
    getUpgradeLevel(colony, 'tacticalPheromone') * 0.11 +
    colony.territory * 0.012
  );
}

export function getHatchMultiplier(colony: ColonyState): number {
  return (
    1 +
    getUpgradeLevel(colony, 'broodNursery') * 0.22 +
    getUpgradeLevel(colony, 'queenCare') * 0.24 +
    colony.nestLevel * 0.04
  );
}

export function getHealMultiplier(colony: ColonyState): number {
  return (
    1 +
    getUpgradeLevel(colony, 'broodNursery') * 0.16 +
    getUpgradeLevel(colony, 'nestGuard') * 0.24
  );
}

export function getSoldierRatio(colony: ColonyState): number {
  return Math.min(0.38, 0.13 + getUpgradeLevel(colony, 'soldierTraining') * 0.035);
}

export function recalculateCombatStats(colony: ColonyState): void {
  colony.attackPower =
    1 +
    getUpgradeLevel(colony, 'soldierTraining') * 0.12 +
    getUpgradeLevel(colony, 'mandibleStrength') * 0.18 +
    getUpgradeLevel(colony, 'tacticalPheromone') * 0.08;
  colony.defensePower =
    1 +
    getUpgradeLevel(colony, 'nestGuard') * 0.17 +
    getUpgradeLevel(colony, 'storageChambers') * 0.03;
}

export function rebalanceSoldiers(colony: ColonyState): void {
  const desired = Math.max(1, Math.floor(colony.antPopulation * getSoldierRatio(colony)));
  if (colony.soldierAnts < desired) {
    colony.soldierAnts = desired;
  }
  colony.soldierAnts = Math.min(colony.soldierAnts, colony.antPopulation);
}

export function getRuntimeStats(colony: ColonyState): RuntimeStats {
  const wounded = Math.min(colony.woundedAnts, colony.antPopulation);
  const availableSoldiers = Math.max(0, colony.soldierAnts - Math.ceil(wounded * 0.45));
  const workingAnts = Math.max(0, colony.antPopulation - colony.soldierAnts - wounded);
  const nurseAnts = Math.min(
    workingAnts,
    Math.floor(workingAnts * 0.1) + getUpgradeLevel(colony, 'broodNursery')
  );
  const foodPerSecond =
    BASE_FOOD_RATE *
    Math.max(1, workingAnts) *
    getForageMultiplier(colony) *
    (1 - Math.min(0.34, colony.enemyThreat * 0.018));
  const antsPerMinute =
    BASE_HATCHES_PER_MINUTE *
    getHatchMultiplier(colony) *
    Math.max(0.35, Math.min(1.25, colony.food / 45));
  return {
    foodPerSecond,
    antsPerMinute,
    capacity: getAntCapacity(colony),
    workingAnts,
    availableSoldiers,
    nurseAnts
  };
}

export function getHealPerMinute(colony: ColonyState): number {
  const stats = getRuntimeStats(colony);
  return BASE_HEAL_PER_MINUTE * getHealMultiplier(colony) * (1 + stats.nurseAnts * 0.08);
}
