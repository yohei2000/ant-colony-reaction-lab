import { SAVE_KEY, SAVE_VERSION } from './constants';
import { applyOfflineProgress } from './simulation';
import { createDefaultColony, createUpgradeLevels } from './state';
import { rebalanceSoldiers, recalculateCombatStats } from './upgrades';
import type { BattleLogEntry, ColonyState, EnemyId } from './types';

export function loadColonyState(now = Date.now()): ColonyState {
  const raw = window.localStorage.getItem(SAVE_KEY);
  if (!raw) {
    return createDefaultColony(now);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ColonyState>;
    const migrated = migrateColonyState(parsed, now);
    applyOfflineProgress(migrated, now);
    return migrated;
  } catch {
    return createDefaultColony(now);
  }
}

export function saveColonyState(colony: ColonyState, now = Date.now()): void {
  colony.lastSavedAt = now;
  window.localStorage.setItem(SAVE_KEY, JSON.stringify(colony));
}

export function migrateColonyState(raw: Partial<ColonyState>, now = Date.now()): ColonyState {
  const isOldLargeSave = (raw.version ?? 0) < SAVE_VERSION && (raw.antPopulation ?? 0) > 48;
  const defaultState = createDefaultColony(now);
  const colony: ColonyState = {
    version: SAVE_VERSION,
    food: finiteNumber(raw.food, defaultState.food),
    lifetimeFood: finiteNumber(raw.lifetimeFood, defaultState.lifetimeFood),
    antPopulation: Math.floor(finiteNumber(raw.antPopulation, defaultState.antPopulation)),
    soldierAnts: Math.floor(finiteNumber(raw.soldierAnts, defaultState.soldierAnts)),
    woundedAnts: Math.floor(finiteNumber(raw.woundedAnts, defaultState.woundedAnts)),
    attackPower: finiteNumber(raw.attackPower, defaultState.attackPower),
    defensePower: finiteNumber(raw.defensePower, defaultState.defensePower),
    nestLevel: Math.floor(finiteNumber(raw.nestLevel, defaultState.nestLevel)),
    territory: Math.floor(finiteNumber(raw.territory, defaultState.territory)),
    enemyThreat: finiteNumber(raw.enemyThreat, defaultState.enemyThreat),
    battleCooldownUntil: finiteNumber(raw.battleCooldownUntil, 0),
    unlockedEnemyColonies: sanitizeEnemies(raw.unlockedEnemyColonies),
    upgrades: createUpgradeLevels(raw.upgrades),
    battleLog: sanitizeBattleLog(raw.battleLog),
    lastSavedAt: finiteNumber(raw.lastSavedAt, now)
  };

  if (isOldLargeSave) {
    const converted = Math.max(12, Math.min(36, Math.round(Math.sqrt(colony.antPopulation) * 3.2)));
    colony.antPopulation = converted;
    colony.soldierAnts = Math.max(2, Math.floor(converted * 0.14));
    colony.woundedAnts = Math.min(3, colony.woundedAnts);
    colony.food = Math.min(Math.max(colony.food * 0.18, 24), 80);
    colony.nestLevel = Math.min(Math.max(1, colony.nestLevel), 3);
  }

  colony.antPopulation = Math.max(12, Math.min(1200, colony.antPopulation));
  colony.soldierAnts = Math.max(1, Math.min(colony.soldierAnts, colony.antPopulation));
  colony.woundedAnts = Math.max(0, Math.min(colony.woundedAnts, colony.antPopulation - 1));
  colony.food = Math.max(0, Math.min(999999, colony.food));
  colony.lifetimeFood = Math.max(colony.food, colony.lifetimeFood);
  colony.nestLevel = Math.max(1, Math.min(24, colony.nestLevel));
  colony.territory = Math.max(0, Math.min(9999, colony.territory));
  colony.enemyThreat = Math.max(0.2, Math.min(50, colony.enemyThreat));
  recalculateCombatStats(colony);
  rebalanceSoldiers(colony);
  return colony;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeEnemies(value: unknown): EnemyId[] {
  const valid: EnemyId[] = ['weak', 'nearby', 'large', 'queenGuard'];
  if (!Array.isArray(value)) {
    return ['weak'];
  }
  const enemies = value.filter((entry): entry is EnemyId => valid.includes(entry));
  return enemies.length > 0 ? [...new Set(enemies)] : ['weak'];
}

function sanitizeBattleLog(value: unknown): BattleLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 5).filter((entry): entry is BattleLogEntry => {
    return Boolean(entry && typeof entry === 'object' && 'enemyId' in entry && 'win' in entry);
  });
}
