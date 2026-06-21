import { resolveBattle } from './game/battle';
import { loadColonyState, migrateColonyState, saveColonyState } from './game/persistence';
import { addPlacedItem, createDefaultColony, createGameState } from './game/state';
import { applyOfflineProgress, updateGame } from './game/simulation';
import { getRuntimeStats, purchaseUpgrade } from './game/upgrades';
import type { GameState } from './game/types';
import type { CanvasSample, RendererInfoSnapshot, RenderSurface } from './render/renderSurface';

export interface Ant3dDebugApi {
  getSnapshot: () => Record<string, unknown>;
  getRendererInfo: () => RendererInfoSnapshot;
  sampleCanvas: () => CanvasSample;
  getCameraOrbit: () => { yaw: number; pitch: number; distance: number };
  simulateSeconds: (seconds: number) => Record<string, unknown>;
  testPheromoneDecay: () => Record<string, unknown>;
  testIdleGrowth: () => Record<string, unknown>;
  testUpgradeEffects: () => Record<string, unknown>;
  testBattleOutcomes: () => Record<string, unknown>;
  testSaveRestore: () => Record<string, unknown>;
  testMigration: () => Record<string, unknown>;
  pause: () => void;
  resume: () => void;
}

declare global {
  interface Window {
    __ANT3D_DEBUG__?: Ant3dDebugApi;
  }
}

export function installDebugApi(state: GameState, renderer: RenderSurface): void {
  window.__ANT3D_DEBUG__ = {
    getSnapshot: () => ({
      antPopulation: state.colony.antPopulation,
      renderedAnts: state.ants.length,
      food: state.colony.food,
      nestLevel: state.colony.nestLevel,
      territory: state.colony.territory,
      enemyThreat: state.colony.enemyThreat,
      soldierAnts: state.colony.soldierAnts,
      woundedAnts: state.colony.woundedAnts,
      selectedTool: state.selectedTool,
      itemCount: state.items.length,
      pheromoneCount: state.pheromones.length,
      unlockedEnemyColonies: [...state.colony.unlockedEnemyColonies],
      battleCooldownUntil: state.colony.battleCooldownUntil,
      stats: getRuntimeStats(state.colony)
    }),
    getRendererInfo: () => renderer.getInfo(),
    sampleCanvas: () => renderer.sampleCanvas(),
    getCameraOrbit: () => renderer.getCameraOrbit(),
    simulateSeconds: (seconds: number) => {
      const steps = Math.min(9000, Math.max(0, Math.floor(seconds * 30)));
      for (let index = 0; index < steps; index += 1) {
        updateGame(state, 1 / 30);
      }
      return {
        antPopulation: state.colony.antPopulation,
        food: state.colony.food,
        pheromoneCount: state.pheromones.length
      };
    },
    testPheromoneDecay: () => {
      const testState = createGameState(createDefaultColony());
      testState.items.length = 0;
      testState.pheromones.length = 0;
      const food = addPlacedItem(testState, 'food', 1.2, 0.4, 0.36);
      if (!food) {
        return { ok: false };
      }
      for (let index = 0; index < 60; index += 1) {
        updateGame(testState, 1 / 30);
      }
      const before = sumFoodPheromone(testState, food.id);
      food.amount = 0;
      for (let index = 0; index < 150; index += 1) {
        updateGame(testState, 1 / 30);
      }
      const after = sumFoodPheromone(testState, food.id);
      return { before, after, weakened: after < before * 0.35 };
    },
    testIdleGrowth: () => {
      const colony = createDefaultColony(Date.now() - 90 * 60 * 1000);
      colony.food = 80;
      const beforeFood = colony.food;
      const beforeAnts = colony.antPopulation;
      applyOfflineProgress(colony, Date.now());
      return {
        beforeFood,
        afterFood: colony.food,
        beforeAnts,
        afterAnts: colony.antPopulation,
        grew: colony.food > beforeFood && colony.antPopulation > beforeAnts
      };
    },
    testUpgradeEffects: () => {
      const colony = createDefaultColony();
      colony.food = 1000;
      colony.lifetimeFood = 1000;
      colony.antPopulation = 40;
      colony.territory = 5;
      const before = getRuntimeStats(colony);
      purchaseUpgrade(colony, 'foragerTrails');
      purchaseUpgrade(colony, 'broodNursery');
      purchaseUpgrade(colony, 'storageChambers');
      const after = getRuntimeStats(colony);
      return {
        before,
        after,
        improved:
          after.foodPerSecond > before.foodPerSecond &&
          after.antsPerMinute > before.antsPerMinute &&
          after.capacity > before.capacity
      };
    },
    testBattleOutcomes: () => {
      const victoryColony = createDefaultColony();
      victoryColony.food = 200;
      victoryColony.lifetimeFood = 500;
      victoryColony.antPopulation = 48;
      victoryColony.soldierAnts = 22;
      const beforeVictoryFood = victoryColony.food;
      const beforeVictoryTerritory = victoryColony.territory;
      const victory = resolveBattle(victoryColony, 'weak', 8, 'assault', Date.now(), 0, true);

      const defeatColony = createDefaultColony();
      defeatColony.food = 160;
      defeatColony.antPopulation = 36;
      defeatColony.soldierAnts = 12;
      const beforeDefeatThreat = defeatColony.enemyThreat;
      const beforeDefeatWounded = defeatColony.woundedAnts;
      const defeat = resolveBattle(defeatColony, 'weak', 4, 'standard', Date.now(), 1, true);

      const cooldownBlocked = resolveBattle(
        victoryColony,
        'weak',
        2,
        'standard',
        Date.now() + 1000,
        0,
        false
      );
      const previewAvailable = getRuntimeStats(defeatColony).availableSoldiers;
      const overAssigned = resolveBattle(
        defeatColony,
        'weak',
        previewAvailable + 999,
        'standard',
        Date.now(),
        0,
        true
      );
      const assignedClamped = overAssigned
        ? overAssigned.assignedSoldiers <= previewAvailable
        : false;
      return {
        victoryFoodDelta: victoryColony.food - beforeVictoryFood,
        victoryTerritoryDelta: victoryColony.territory - beforeVictoryTerritory,
        defeatThreatDelta: defeatColony.enemyThreat - beforeDefeatThreat,
        defeatWoundedDelta: defeatColony.woundedAnts - beforeDefeatWounded,
        cooldownBlocked: cooldownBlocked === null,
        assignedClamped,
        ok:
          Boolean(victory?.win) &&
          victoryColony.food > beforeVictoryFood &&
          victoryColony.territory > beforeVictoryTerritory &&
          defeat?.win === false &&
          defeatColony.enemyThreat > beforeDefeatThreat &&
          defeatColony.woundedAnts > beforeDefeatWounded &&
          cooldownBlocked === null &&
          assignedClamped
      };
    },
    testSaveRestore: () => {
      const previous = window.localStorage.getItem('ant3d.colonyState');
      const colony = createDefaultColony();
      colony.food = 123.45;
      colony.territory = 7;
      colony.unlockedEnemyColonies = ['weak', 'nearby'];
      saveColonyState(colony, Date.now());
      const restored = loadColonyState(Date.now());
      if (previous) {
        window.localStorage.setItem('ant3d.colonyState', previous);
      } else {
        window.localStorage.removeItem('ant3d.colonyState');
      }
      return {
        restoredFood: restored.food,
        restoredTerritory: restored.territory,
        restoredEnemies: restored.unlockedEnemyColonies,
        ok:
          Math.abs(restored.food - colony.food) < 0.01 &&
          restored.territory === colony.territory &&
          restored.unlockedEnemyColonies.includes('nearby')
      };
    },
    testMigration: () => {
      const migrated = migrateColonyState({
        version: 1,
        food: 9999,
        lifetimeFood: 9999,
        antPopulation: 170,
        soldierAnts: 40,
        nestLevel: 8
      });
      return {
        antPopulation: migrated.antPopulation,
        food: migrated.food,
        ok: migrated.antPopulation <= 42 && migrated.antPopulation >= 12
      };
    },
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
    }
  };
}

function sumFoodPheromone(state: GameState, sourceId: number): number {
  return state.pheromones
    .filter((pheromone) => pheromone.signal === 'food' && pheromone.sourceId === sourceId)
    .reduce((sum, pheromone) => sum + pheromone.strength, 0);
}
