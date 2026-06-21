export type ToolType = 'observe' | 'water' | 'object' | 'food' | 'branch' | 'erase';

export type ItemType = 'water' | 'object' | 'food' | 'branch';

export type AntRole =
  | 'explore'
  | 'forage'
  | 'return'
  | 'avoid'
  | 'panic'
  | 'rescue'
  | 'wet'
  | 'follow';

export type PheromoneSignal = 'food' | 'alarm' | 'rescue' | 'water';

export type UpgradeId =
  | 'foragerTrails'
  | 'broodNursery'
  | 'storageChambers'
  | 'queenCare'
  | 'soldierTraining'
  | 'mandibleStrength'
  | 'nestGuard'
  | 'tacticalPheromone';

export type UpgradeCategory = 'growth' | 'combat';

export type EnemyId = 'weak' | 'nearby' | 'large' | 'queenGuard';
export type TacticId = 'cautious' | 'standard' | 'assault';

export interface Vec2 {
  x: number;
  z: number;
}

export interface AntPersonality {
  curiosity: number;
  bravery: number;
  social: number;
  efficiency: number;
  nurse: number;
}

export interface AntAgent {
  id: number;
  x: number;
  z: number;
  dir: number;
  speed: number;
  role: AntRole;
  carryingFood: number;
  targetFoodId: number | null;
  wetTimer: number;
  panicTimer: number;
  pauseTimer: number;
  decisionTimer: number;
  personality: AntPersonality;
}

export interface PlacedItem {
  id: number;
  type: ItemType;
  x: number;
  z: number;
  radius: number;
  amount: number;
  initialAmount: number;
  rotation: number;
  bridge: boolean;
}

export interface Pheromone {
  id: number;
  signal: PheromoneSignal;
  x: number;
  z: number;
  strength: number;
  sourceId: number | null;
  radius: number;
  decay: number;
}

export interface BattleLogEntry {
  id: string;
  at: number;
  enemyId: EnemyId;
  tacticId: TacticId;
  assignedSoldiers: number;
  win: boolean;
  winChance: number;
  foodDelta: number;
  territoryDelta: number;
  woundedDelta: number;
  threatDelta: number;
}

export type UpgradeLevels = Record<UpgradeId, number>;

export interface ColonyState {
  version: number;
  food: number;
  lifetimeFood: number;
  antPopulation: number;
  soldierAnts: number;
  woundedAnts: number;
  attackPower: number;
  defensePower: number;
  nestLevel: number;
  territory: number;
  enemyThreat: number;
  battleCooldownUntil: number;
  unlockedEnemyColonies: EnemyId[];
  upgrades: UpgradeLevels;
  battleLog: BattleLogEntry[];
  lastSavedAt: number;
}

export interface RuntimeStats {
  foodPerSecond: number;
  antsPerMinute: number;
  capacity: number;
  workingAnts: number;
  availableSoldiers: number;
  nurseAnts: number;
}

export interface GameState {
  colony: ColonyState;
  ants: AntAgent[];
  items: PlacedItem[];
  pheromones: Pheromone[];
  selectedTool: ToolType;
  paused: boolean;
  worldTime: number;
  broodProgress: number;
  itemRevision: number;
  pheromoneRevision: number;
  nextAntId: number;
  nextItemId: number;
  nextPheromoneId: number;
}
