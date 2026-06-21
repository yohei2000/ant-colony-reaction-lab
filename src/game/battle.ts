import { clamp } from './state';
import { getRuntimeStats, rebalanceSoldiers } from './upgrades';
import type { BattleLogEntry, ColonyState, EnemyId, TacticId } from './types';

export interface EnemyColony {
  id: EnemyId;
  name: string;
  power: number;
  defense: number;
  rewardFood: number;
  rewardTerritory: number;
  unlocks?: EnemyId;
}

export interface TacticDefinition {
  id: TacticId;
  name: string;
  powerMultiplier: number;
  rewardMultiplier: number;
  lossMultiplier: number;
}

export interface BattlePreview {
  enemy: EnemyColony;
  tactic: TacticDefinition;
  assignedSoldiers: number;
  availableSoldiers: number;
  playerPower: number;
  enemyPower: number;
  winChance: number;
  rewardFood: number;
  rewardTerritory: number;
  expectedWounded: number;
  cooldownRemainingMs: number;
}

export interface BattleResult extends BattlePreview {
  win: boolean;
  log: BattleLogEntry;
}

export const ENEMY_COLONIES: EnemyColony[] = [
  {
    id: 'weak',
    name: '弱小コロニー',
    power: 4,
    defense: 3,
    rewardFood: 36,
    rewardTerritory: 1,
    unlocks: 'nearby'
  },
  {
    id: 'nearby',
    name: '近隣コロニー',
    power: 11,
    defense: 8,
    rewardFood: 72,
    rewardTerritory: 2,
    unlocks: 'large'
  },
  {
    id: 'large',
    name: '大型コロニー',
    power: 24,
    defense: 18,
    rewardFood: 146,
    rewardTerritory: 4,
    unlocks: 'queenGuard'
  },
  {
    id: 'queenGuard',
    name: '女王防衛コロニー',
    power: 45,
    defense: 36,
    rewardFood: 300,
    rewardTerritory: 8
  }
];

export const TACTICS: TacticDefinition[] = [
  {
    id: 'cautious',
    name: '慎重',
    powerMultiplier: 0.88,
    rewardMultiplier: 0.78,
    lossMultiplier: 0.55
  },
  {
    id: 'standard',
    name: '標準',
    powerMultiplier: 1,
    rewardMultiplier: 1,
    lossMultiplier: 1
  },
  {
    id: 'assault',
    name: '強襲',
    powerMultiplier: 1.18,
    rewardMultiplier: 1.35,
    lossMultiplier: 1.55
  }
];

const BATTLE_COOLDOWN_MS = 90_000;

export function getEnemy(id: EnemyId): EnemyColony {
  return ENEMY_COLONIES.find((enemy) => enemy.id === id) ?? ENEMY_COLONIES[0];
}

export function getTactic(id: TacticId): TacticDefinition {
  return TACTICS.find((tactic) => tactic.id === id) ?? TACTICS[1];
}

export function getUnlockedEnemies(colony: ColonyState): EnemyColony[] {
  return ENEMY_COLONIES.filter((enemy) => colony.unlockedEnemyColonies.includes(enemy.id));
}

export function getAvailableSoldiers(colony: ColonyState): number {
  return getRuntimeStats(colony).availableSoldiers;
}

export function previewBattle(
  colony: ColonyState,
  enemyId: EnemyId,
  assignedSoldiers: number,
  tacticId: TacticId,
  now = Date.now()
): BattlePreview {
  rebalanceSoldiers(colony);
  const enemy = getEnemy(enemyId);
  const tactic = getTactic(tacticId);
  const availableSoldiers = getAvailableSoldiers(colony);
  const assigned = Math.max(0, Math.min(Math.floor(assignedSoldiers), availableSoldiers));
  const playerPower = assigned * colony.attackPower * tactic.powerMultiplier;
  const enemyPower = enemy.power + enemy.defense + colony.enemyThreat * 1.7;
  const winChance = clamp(playerPower / Math.max(1, playerPower + enemyPower), 0.08, 0.92);
  const rewardFood = Math.ceil(enemy.rewardFood * tactic.rewardMultiplier);
  const rewardTerritory = Math.max(1, Math.round(enemy.rewardTerritory * tactic.rewardMultiplier));
  const expectedWounded = Math.max(
    1,
    Math.ceil(assigned * tactic.lossMultiplier * (0.16 + (1 - winChance) * 0.3))
  );
  return {
    enemy,
    tactic,
    assignedSoldiers: assigned,
    availableSoldiers,
    playerPower,
    enemyPower,
    winChance,
    rewardFood,
    rewardTerritory,
    expectedWounded,
    cooldownRemainingMs: Math.max(0, colony.battleCooldownUntil - now)
  };
}

export function resolveBattle(
  colony: ColonyState,
  enemyId: EnemyId,
  assignedSoldiers: number,
  tacticId: TacticId,
  now = Date.now(),
  randomValue = Math.random(),
  ignoreCooldown = false
): BattleResult | null {
  if (!ignoreCooldown && colony.battleCooldownUntil > now) {
    return null;
  }
  if (!colony.unlockedEnemyColonies.includes(enemyId)) {
    return null;
  }
  const preview = previewBattle(colony, enemyId, assignedSoldiers, tacticId, now);
  if (preview.assignedSoldiers <= 0) {
    return null;
  }

  const win = randomValue <= preview.winChance;
  let foodDelta = 0;
  let territoryDelta = 0;
  let woundedDelta = 0;
  let threatDelta = 0;

  if (win) {
    foodDelta = preview.rewardFood;
    territoryDelta = preview.rewardTerritory;
    woundedDelta = Math.max(1, Math.round(preview.expectedWounded * 0.55));
    threatDelta = -Math.max(0.25, preview.enemy.power * 0.035);
    colony.food += foodDelta;
    colony.lifetimeFood += foodDelta;
    colony.territory += territoryDelta;
    colony.enemyThreat = clamp(colony.enemyThreat + threatDelta, 0.2, 50);
    if (preview.enemy.unlocks && !colony.unlockedEnemyColonies.includes(preview.enemy.unlocks)) {
      colony.unlockedEnemyColonies.push(preview.enemy.unlocks);
    }
  } else {
    foodDelta = -Math.min(colony.food, Math.ceil(preview.enemy.rewardFood * 0.28));
    woundedDelta = Math.max(1, Math.round(preview.expectedWounded * 1.2));
    threatDelta = Math.max(0.35, preview.enemy.power * 0.055);
    colony.food += foodDelta;
    colony.enemyThreat = clamp(colony.enemyThreat + threatDelta, 0.2, 50);
  }

  colony.woundedAnts = Math.min(colony.antPopulation - 1, colony.woundedAnts + woundedDelta);
  colony.battleCooldownUntil = now + BATTLE_COOLDOWN_MS;
  const log: BattleLogEntry = {
    id: `${now}-${preview.enemy.id}-${preview.tactic.id}`,
    at: now,
    enemyId: preview.enemy.id,
    tacticId: preview.tactic.id,
    assignedSoldiers: preview.assignedSoldiers,
    win,
    winChance: preview.winChance,
    foodDelta,
    territoryDelta,
    woundedDelta,
    threatDelta
  };
  colony.battleLog = [log, ...colony.battleLog].slice(0, 5);
  rebalanceSoldiers(colony);
  return { ...preview, win, log };
}
