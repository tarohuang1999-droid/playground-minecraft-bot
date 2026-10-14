export const RESOURCES = ['MOVE', 'LOOK', 'HAND', 'INVENTORY', 'VOICE'] as const;
export type ResourceChannel = typeof RESOURCES[number];
export const ACTION_POLICY = {
  Retreat: { priority: 100, requiredResources: ['MOVE', 'LOOK'] },
  EmergencyEat: { priority: 90, requiredResources: ['HAND', 'INVENTORY'] },
  Combat: { priority: 80, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'] },
  RoutineEat: { priority: 60, requiredResources: ['HAND', 'INVENTORY'] },
  EquipBest: { priority: 50, requiredResources: ['HAND', 'INVENTORY'] },
  CatchUpFollow: { priority: 40, requiredResources: ['MOVE', 'LOOK'] },
  PickupItem: { priority: 30, requiredResources: ['MOVE', 'LOOK'] },
  NormalFollow: { priority: 20, requiredResources: ['MOVE', 'LOOK'] },
  Chat: { priority: 10, requiredResources: ['VOICE'] },
  Idle: { priority: 0, requiredResources: [] },
} as const satisfies Record<string, { priority: number; requiredResources: readonly ResourceChannel[] }>;
export type ActionType = keyof typeof ACTION_POLICY;
export const THRESHOLDS = {
  followEnter: 2.2, followExit: 1.2, catchUpEnter: 16, catchUpExit: 5,
  retreatHealth: 6, retreatEnter: 12, retreatExit: 18, retreatSafeMs: 3000,
  combatEnter: 8, combatExit: 16, combatMasterLimit: 24,
  routineFood: 16, emergencyFood: 6, emergencyHealth: 10,
  pickupRadius: 5, pickupMasterLimit: 10, failureCooldownMs: 30_000,
  observationRadius: 32, chatIntervalMs: 1000, chatQueueLimit: 5,
} as const;
