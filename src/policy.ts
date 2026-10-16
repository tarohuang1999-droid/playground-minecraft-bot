import { THRESHOLDS } from './config/index.ts';

export const RESOURCES = ['MOVE', 'LOOK', 'HAND', 'INVENTORY', 'VOICE'] as const;
export type ResourceChannel = (typeof RESOURCES)[number];
export const ACTION_POLICY = {
  Retreat: { priority: 100, requiredResources: ['MOVE', 'LOOK'] },
  EmergencyEat: { priority: 90, requiredResources: ['HAND', 'INVENTORY'] },
  Combat: { priority: 80, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'] },
  RoutineEat: { priority: 60, requiredResources: ['HAND', 'INVENTORY'] },
  EquipBest: { priority: 50, requiredResources: ['HAND', 'INVENTORY'] },
  CatchUpFollow: { priority: 40, requiredResources: ['MOVE', 'LOOK'] },
  PickupItem: { priority: 30, requiredResources: ['MOVE', 'LOOK'] },
  FarmPlant: { priority: 30, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'] },
  ComeOnce: { priority: 25, requiredResources: ['MOVE', 'LOOK'] },
  ReturnToBase: { priority: 25, requiredResources: ['MOVE', 'LOOK'] },
  UnstickCorner: { priority: 25, requiredResources: ['MOVE', 'LOOK'] },
  DetourWaypoint: { priority: 25, requiredResources: ['MOVE', 'LOOK'] },
  ReturnToRally: { priority: 20, requiredResources: ['MOVE', 'LOOK'] },
  NormalFollow: { priority: 20, requiredResources: ['MOVE', 'LOOK'] },
  SetSpawn: { priority: 15, requiredResources: ['MOVE', 'LOOK', 'HAND'] },
  Chat: { priority: 10, requiredResources: ['VOICE'] },
  Idle: { priority: 0, requiredResources: [] },
} as const satisfies Record<
  string,
  { priority: number; requiredResources: readonly ResourceChannel[] }
>;
export type ActionType = keyof typeof ACTION_POLICY;
export { THRESHOLDS };
