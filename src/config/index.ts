import { navigationConfig, DIG_WHITELIST, PLACE_WHITELIST } from './navigation.config.ts';
import { combatConfig } from './combat.config.ts';
import { survivalConfig } from './survival.config.ts';
import { workConfig, CROP_REGISTRY, type CropDefinition } from './work.config.ts';
import { systemConfig } from './system.config.ts';

export {
  navigationConfig,
  DIG_WHITELIST,
  PLACE_WHITELIST,
  combatConfig,
  survivalConfig,
  workConfig,
  CROP_REGISTRY,
  type CropDefinition,
  systemConfig,
};

export const THRESHOLDS = {
  followEnter: navigationConfig.followEnter,
  followExit: navigationConfig.followExit,
  catchUpEnter: navigationConfig.catchUpEnter,
  catchUpExit: navigationConfig.catchUpExit,
  retreatHealth: combatConfig.retreatHealth,
  retreatEnter: combatConfig.retreatEnter,
  retreatExit: combatConfig.retreatExit,
  retreatSafeMs: combatConfig.retreatSafeMs,
  retreatMobCount: combatConfig.retreatMobCount,
  combatEnter: combatConfig.combatEnter,
  combatExit: combatConfig.combatExit,
  combatMasterLimit: combatConfig.combatMasterLimit,
  routineFood: survivalConfig.routineFood,
  emergencyFood: survivalConfig.emergencyFood,
  emergencyHealth: survivalConfig.emergencyHealth,
  pickupRadius: workConfig.pickupRadius,
  pickupMasterLimit: workConfig.pickupMasterLimit,
  pickupGoalDistance: workConfig.pickupGoalDistance,
  pickupNearStepDistance: workConfig.pickupNearStepDistance,
  pickupTimeoutMs: workConfig.pickupTimeoutMs,
  failureCooldownMs: workConfig.failureCooldownMs,
  bedSearchRadius: survivalConfig.bed.searchRadius,
  bedReachDistance: survivalConfig.bed.reachDistance,
  sleepReachDistance: survivalConfig.bed.sleepReachDistance,
  bedFailureCooldownMs: survivalConfig.bed.failureCooldownMs,
  observationRadius: systemConfig.observationRadius,
  chatIntervalMs: systemConfig.chatIntervalMs,
  chatQueueLimit: systemConfig.chatQueueLimit,
} as const;
