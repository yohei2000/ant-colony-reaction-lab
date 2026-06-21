import { MAX_FRAME_DELTA, NEST_RADIUS, WORLD_RADIUS } from './constants';
import {
  addPheromone,
  clamp,
  seeded01,
  syncRenderedAnts
} from './state';
import {
  getAntCapacity,
  getForageMultiplier,
  getHealPerMinute,
  getRuntimeStats,
  rebalanceSoldiers
} from './upgrades';
import type { AntAgent, ColonyState, GameState, Pheromone, PlacedItem } from './types';

const TWO_PI = Math.PI * 2;
const FOOD_CARRY_SIZE = 0.16;
const ANT_BASE_RADIUS = 0.12;

export function updateGame(state: GameState, dt: number): void {
  if (state.paused) {
    return;
  }
  const clampedDt = Math.min(dt, MAX_FRAME_DELTA);
  state.worldTime += clampedDt;
  updateColonyEconomy(state, clampedDt);
  updatePheromones(state, clampedDt);
  syncRenderedAnts(state);
  updateAntAgents(state, clampedDt);
}

export function applyOfflineProgress(colony: ColonyState, now = Date.now()): void {
  const elapsedSeconds = clamp((now - colony.lastSavedAt) / 1000, 0, 8 * 60 * 60);
  if (elapsedSeconds <= 1) {
    colony.lastSavedAt = now;
    return;
  }
  rebalanceSoldiers(colony);
  const stats = getRuntimeStats(colony);
  const foodGain = stats.foodPerSecond * elapsedSeconds * 0.72;
  colony.food += foodGain;
  colony.lifetimeFood += foodGain;

  const capacity = getAntCapacity(colony);
  let possibleBirths = Math.floor((stats.antsPerMinute * elapsedSeconds) / 60);
  possibleBirths = Math.min(possibleBirths, Math.max(0, capacity - colony.antPopulation), 90);
  for (let index = 0; index < possibleBirths; index += 1) {
    const cost = getHatchFoodCost(colony.antPopulation);
    if (colony.food < cost) {
      break;
    }
    colony.food -= cost;
    colony.antPopulation += 1;
  }

  const healed = Math.min(colony.woundedAnts, Math.floor((getHealPerMinute(colony) * elapsedSeconds) / 60));
  colony.woundedAnts -= healed;
  colony.enemyThreat = clamp(colony.enemyThreat + elapsedSeconds * 0.00018, 0.2, 50);
  rebalanceSoldiers(colony);
  colony.lastSavedAt = now;
}

export function forcePheromoneDecayForSource(state: GameState, sourceId: number): void {
  for (const pheromone of state.pheromones) {
    if (pheromone.sourceId === sourceId) {
      pheromone.decay = Math.max(pheromone.decay, 2.8);
    }
  }
  state.pheromoneRevision++;
}

function updateColonyEconomy(state: GameState, dt: number): void {
  const colony = state.colony;
  rebalanceSoldiers(colony);
  const stats = getRuntimeStats(colony);
  const passiveFood = stats.foodPerSecond * dt;
  colony.food += passiveFood;
  colony.lifetimeFood += passiveFood;
  colony.enemyThreat = clamp(colony.enemyThreat + dt * 0.00012, 0.2, 50);

  if (colony.woundedAnts > 0) {
    const healAmount = (getHealPerMinute(colony) * dt) / 60;
    colony.woundedAnts = Math.max(0, colony.woundedAnts - healAmount);
  }

  const capacity = getAntCapacity(colony);
  if (colony.antPopulation < capacity && colony.food > 8) {
    state.broodProgress += (stats.antsPerMinute * dt) / 60;
    while (state.broodProgress >= 1 && colony.antPopulation < capacity) {
      const cost = getHatchFoodCost(colony.antPopulation);
      if (colony.food < cost) {
        break;
      }
      colony.food -= cost;
      colony.antPopulation += 1;
      state.broodProgress -= 1;
    }
  }
}

function updatePheromones(state: GameState, dt: number): void {
  let removed = false;
  for (let index = state.pheromones.length - 1; index >= 0; index -= 1) {
    const pheromone = state.pheromones[index];
    let decayMultiplier = 1;
    if (pheromone.signal === 'food') {
      const food = findItemById(state.items, pheromone.sourceId);
      if (!food || food.type !== 'food' || food.amount <= 0.05) {
        decayMultiplier = 9.5;
        pheromone.decay = Math.max(pheromone.decay, 2.2);
      } else {
        const foodRatio = clamp(food.amount / food.initialAmount, 0, 1);
        pheromone.strength = Math.min(pheromone.strength, 0.16 + foodRatio * 1.12);
        decayMultiplier = 1.15 - foodRatio * 0.72;
      }
    }
    if (pheromone.signal === 'rescue' && state.colony.woundedAnts <= 0.05) {
      decayMultiplier = 4.5;
    }
    pheromone.strength -= pheromone.decay * decayMultiplier * dt;
    if (pheromone.strength <= 0.025) {
      state.pheromones.splice(index, 1);
      removed = true;
    }
  }
  if (removed) {
    state.pheromoneRevision++;
  }
}

function updateAntAgents(state: GameState, dt: number): void {
  const foodMultiplier = getForageMultiplier(state.colony);
  for (const ant of state.ants) {
    if (ant.pauseTimer > 0) {
      ant.pauseTimer = Math.max(0, ant.pauseTimer - dt);
      continue;
    }

    ant.decisionTimer -= dt;
    ant.wetTimer = Math.max(0, ant.wetTimer - dt);
    ant.panicTimer = Math.max(0, ant.panicTimer - dt);

    let targetX = 0;
    let targetZ = 0;
    let hasTarget = false;

    const nearWater = updateWaterReaction(state, ant);
    const bestFood = ant.carryingFood > 0 ? null : chooseFoodTarget(state, ant);
    const bestTrail = ant.carryingFood > 0 || bestFood ? null : chooseFoodTrail(state, ant);

    if (ant.carryingFood > 0) {
      ant.role = 'return';
      targetX = 0;
      targetZ = 0;
      hasTarget = true;
      if (Math.hypot(ant.x, ant.z) < NEST_RADIUS * 0.72) {
        const delivered = ant.carryingFood * foodMultiplier;
        state.colony.food += delivered;
        state.colony.lifetimeFood += delivered;
        ant.carryingFood = 0;
        ant.targetFoodId = null;
        ant.role = 'forage';
      }
    } else if (nearWater) {
      ant.role = ant.panicTimer > 0 ? 'panic' : 'avoid';
      targetX = ant.x + Math.sin(ant.dir) * 0.4;
      targetZ = ant.z + Math.cos(ant.dir) * 0.4;
      hasTarget = true;
    } else if (state.colony.woundedAnts > 0.5 && ant.personality.nurse > 0.92 && seeded01(ant.id, Math.floor(state.worldTime) + 31) > 0.72) {
      ant.role = 'rescue';
      targetX = seeded01(ant.id, 41) * 0.7 - 0.35;
      targetZ = seeded01(ant.id, 43) * 0.7 - 0.35;
      hasTarget = true;
      if (ant.decisionTimer <= 0) {
        addPheromone(state, 'rescue', ant.x, ant.z, 0.16, null, 0.36);
      }
    } else if (bestFood) {
      ant.role = bestTrail ? 'follow' : 'forage';
      ant.targetFoodId = bestFood.id;
      targetX = bestFood.x;
      targetZ = bestFood.z;
      hasTarget = true;
      if (distanceSq(ant.x, ant.z, bestFood.x, bestFood.z) < (bestFood.radius + 0.12) ** 2) {
        harvestFood(state, ant, bestFood);
      }
    } else if (bestTrail) {
      ant.role = 'follow';
      targetX = bestTrail.x;
      targetZ = bestTrail.z;
      hasTarget = true;
    }

    if (!hasTarget || ant.decisionTimer <= 0) {
      ant.decisionTimer = 0.5 + seeded01(ant.id, Math.floor(state.worldTime * 3) + 53) * 1.4;
      if (!hasTarget) {
        ant.role = ant.role === 'follow' ? 'forage' : 'explore';
      }
      const wander = (seeded01(ant.id, Math.floor(state.worldTime * 11) + 61) - 0.5) * 1.35;
      ant.dir = wrapAngle(ant.dir + wander * ant.personality.curiosity);
    }

    if (hasTarget) {
      steerToward(ant, targetX, targetZ, dt, ant.role === 'panic' ? 7.5 : 4.2);
    }

    applyObstacleAvoidance(state, ant, dt);
    keepInsideWorld(ant, dt);
    moveAnt(ant, dt);

    if (ant.carryingFood > 0 && seeded01(ant.id, Math.floor(state.worldTime * 8) + 71) > 0.76) {
      addPheromone(state, 'food', ant.x, ant.z, 0.045, ant.targetFoodId, 0.32);
    }
  }
}

function chooseFoodTarget(state: GameState, ant: AntAgent): PlacedItem | null {
  let best: PlacedItem | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of state.items) {
    if (item.type !== 'food' || item.amount <= 0.05) {
      continue;
    }
    const distance = Math.hypot(item.x - ant.x, item.z - ant.z);
    const targetBias = ant.targetFoodId === item.id ? -1.2 : 0;
    const score = distance - item.amount * 0.018 + targetBias;
    if (score < bestScore && distance < 4.8 + ant.personality.social * 1.6) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function chooseFoodTrail(state: GameState, ant: AntAgent): Pheromone | null {
  let best: Pheromone | null = null;
  let bestScore = 0;
  for (const pheromone of state.pheromones) {
    if (pheromone.signal !== 'food' || pheromone.strength <= 0.08) {
      continue;
    }
    const source = findItemById(state.items, pheromone.sourceId);
    if (!source || source.type !== 'food' || source.amount <= 0.05) {
      continue;
    }
    const dx = pheromone.x - ant.x;
    const dz = pheromone.z - ant.z;
    const distSqValue = dx * dx + dz * dz;
    if (distSqValue > 9) {
      continue;
    }
    const score = pheromone.strength * ant.personality.social - distSqValue * 0.035;
    if (score > bestScore) {
      bestScore = score;
      best = pheromone;
    }
  }
  return best;
}

function harvestFood(state: GameState, ant: AntAgent, food: PlacedItem): void {
  const take = Math.min(food.amount, FOOD_CARRY_SIZE * ant.personality.efficiency);
  food.amount -= take;
  ant.carryingFood = take;
  ant.role = 'return';
  addPheromone(state, 'food', food.x, food.z, 0.22, food.id, 0.58);
  if (food.amount <= 0.05) {
    food.amount = 0;
    forcePheromoneDecayForSource(state, food.id);
    state.itemRevision++;
  }
}

function updateWaterReaction(state: GameState, ant: AntAgent): boolean {
  let touchedWater = false;
  for (const item of state.items) {
    if (item.type !== 'water') {
      continue;
    }
    const distance = Math.hypot(item.x - ant.x, item.z - ant.z);
    if (distance < item.radius + ANT_BASE_RADIUS) {
      touchedWater = true;
      ant.wetTimer = Math.max(ant.wetTimer, 3.2);
      ant.panicTimer = Math.max(ant.panicTimer, 1.15 + (1 - ant.personality.bravery) * 2);
      ant.dir = Math.atan2(ant.x - item.x, ant.z - item.z);
      addPheromone(state, 'alarm', ant.x, ant.z, 0.18, null, 0.34);
      break;
    }
  }
  return touchedWater || ant.wetTimer > 0 || ant.panicTimer > 0;
}

function applyObstacleAvoidance(state: GameState, ant: AntAgent, dt: number): void {
  let avoidX = 0;
  let avoidZ = 0;
  for (const item of state.items) {
    if (item.type === 'food') {
      continue;
    }
    const dx = ant.x - item.x;
    const dz = ant.z - item.z;
    const distance = Math.hypot(dx, dz);
    const influence = item.radius + (item.type === 'branch' ? 0.16 : 0.28);
    if (distance > 0.0001 && distance < influence) {
      const strength = (influence - distance) / influence;
      avoidX += (dx / distance) * strength;
      avoidZ += (dz / distance) * strength;
      if (item.type === 'object' && distance < item.radius + 0.04) {
        ant.pauseTimer = Math.max(ant.pauseTimer, 0.06);
      }
    }
  }
  if (avoidX !== 0 || avoidZ !== 0) {
    const avoidDir = Math.atan2(avoidX, avoidZ);
    ant.dir = turnAngle(ant.dir, avoidDir, dt * 7);
    ant.role = ant.role === 'panic' ? 'panic' : 'avoid';
  }
}

function keepInsideWorld(ant: AntAgent, dt: number): void {
  const dist = Math.hypot(ant.x, ant.z);
  if (dist > WORLD_RADIUS * 0.92) {
    const homeDir = Math.atan2(-ant.x, -ant.z);
    ant.dir = turnAngle(ant.dir, homeDir, dt * 5.8);
  }
}

function steerToward(ant: AntAgent, x: number, z: number, dt: number, strength: number): void {
  const dir = Math.atan2(x - ant.x, z - ant.z);
  ant.dir = turnAngle(ant.dir, dir, dt * strength);
}

function moveAnt(ant: AntAgent, dt: number): void {
  const roleSpeed =
    ant.role === 'panic'
      ? 1.65
      : ant.role === 'return'
        ? 1.18
        : ant.role === 'wet'
          ? 0.72
          : ant.role === 'avoid'
            ? 0.92
            : 1;
  ant.x += Math.sin(ant.dir) * ant.speed * roleSpeed * dt;
  ant.z += Math.cos(ant.dir) * ant.speed * roleSpeed * dt;
}

function getHatchFoodCost(population: number): number {
  return 6 + Math.floor(population / 18) * 2;
}

function findItemById(items: PlacedItem[], id: number | null): PlacedItem | null {
  if (id === null) {
    return null;
  }
  return items.find((item) => item.id === id) ?? null;
}

function distanceSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function turnAngle(current: number, target: number, maxDelta: number): number {
  const delta = wrapAngle(target - current);
  return wrapAngle(current + clamp(delta, -maxDelta, maxDelta));
}

function wrapAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) {
    value -= TWO_PI;
  }
  while (value < -Math.PI) {
    value += TWO_PI;
  }
  return value;
}
