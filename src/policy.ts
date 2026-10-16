import { THRESHOLDS } from './config/index.ts';

export const RESOURCES = ['MOVE', 'LOOK', 'HAND', 'INVENTORY', 'VOICE'] as const;
export type ResourceChannel = (typeof RESOURCES)[number];

export const MODE_PRIORITY = {
  SURVIVAL: 70,
  COMBAT: 60,
  FARM: 25,
  WORK: 20,
  FOLLOW: 15,
  NAVIGATION: 15,
  MAINTENANCE: 0,
  IDLE: 0,
} as const;

export type ActionMode = keyof typeof MODE_PRIORITY;

export const ACTION_POLICY = {
  Retreat: { mode: 'SURVIVAL', priority: 30, requiredResources: ['MOVE', 'LOOK'] },
  EmergencyEat: { mode: 'SURVIVAL', priority: 20, requiredResources: ['HAND', 'INVENTORY'] },
  Combat: {
    mode: 'COMBAT',
    priority: 20,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
  },
  RoutineEat: { mode: 'MAINTENANCE', priority: 60, requiredResources: ['HAND', 'INVENTORY'] },
  CatchUpFollow: { mode: 'FOLLOW', priority: 25, requiredResources: ['MOVE', 'LOOK'] },
  FarmPlant: {
    mode: 'FARM',
    priority: 15,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
  },
  PickupItem: { mode: 'WORK', priority: 10, requiredResources: ['MOVE', 'LOOK'] },
  ComeOnce: { mode: 'NAVIGATION', priority: 10, requiredResources: ['MOVE', 'LOOK'] },
  ReturnToBase: { mode: 'NAVIGATION', priority: 10, requiredResources: ['MOVE', 'LOOK'] },
  UnstickCorner: { mode: 'NAVIGATION', priority: 10, requiredResources: ['MOVE', 'LOOK'] },
  DetourWaypoint: { mode: 'NAVIGATION', priority: 10, requiredResources: ['MOVE', 'LOOK'] },
  NormalFollow: { mode: 'FOLLOW', priority: 5, requiredResources: ['MOVE', 'LOOK'] },
  EquipBest: { mode: 'MAINTENANCE', priority: 15, requiredResources: ['HAND', 'INVENTORY'] },
  SetSpawn: { mode: 'MAINTENANCE', priority: 15, requiredResources: ['MOVE', 'LOOK', 'HAND'] },
  Chat: { mode: 'MAINTENANCE', priority: 10, requiredResources: ['VOICE'] },
  Idle: { mode: 'IDLE', priority: 0, requiredResources: [] },
} as const satisfies Record<
  string,
  { mode: ActionMode; priority: number; requiredResources: readonly ResourceChannel[] }
>;

export type ActionType = keyof typeof ACTION_POLICY;

export function calculateActionPriority(actionType: ActionType): number {
  const policy = ACTION_POLICY[actionType];
  if (!policy) return 0;
  return MODE_PRIORITY[policy.mode] + policy.priority;
}

export { THRESHOLDS };
