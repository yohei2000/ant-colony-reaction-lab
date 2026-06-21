export const SAVE_KEY = 'ant3d.colonyState';
export const SAVE_VERSION = 2;

export const FIXED_DT = 1 / 30;
export const MAX_FIXED_STEPS = 5;
export const MAX_FRAME_DELTA = 0.25;

export const WORLD_RADIUS = 6.4;
export const NEST_RADIUS = 0.54;
export const INITIAL_ANTS = 12;
export const MAX_RENDERED_ANTS = 180;
export const MAX_ITEMS = 80;
export const MAX_PHEROMONES = 260;

export const BASE_CAPACITY = 18;
export const BASE_FOOD_RATE = 0.055;
export const BASE_HATCHES_PER_MINUTE = 0.42;
export const BASE_HEAL_PER_MINUTE = 0.16;

export const TOOL_DEFINITIONS = [
  { id: 'observe', label: '観察', icon: 'observe' },
  { id: 'water', label: '水', icon: 'water' },
  { id: 'object', label: '物', icon: 'object' },
  { id: 'food', label: '餌', icon: 'food' },
  { id: 'branch', label: '枝', icon: 'branch' },
  { id: 'erase', label: '消す', icon: 'erase' }
] as const;
