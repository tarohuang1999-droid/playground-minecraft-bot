import assert from 'node:assert/strict';
import test from 'node:test';
import {
  navigationConfig,
  combatConfig,
  survivalConfig,
  workConfig,
  systemConfig,
  THRESHOLDS,
  DIG_WHITELIST,
  PLACE_WHITELIST,
  CROP_REGISTRY,
} from '../../src/config/index.ts';

test('Config: navigationConfig contains all pathfinding and movement policies', () => {
  assert.equal(navigationConfig.followEnter, 2.2);
  assert.equal(navigationConfig.followExit, 1.2);
  assert.equal(navigationConfig.catchUpEnter, 16);
  assert.equal(navigationConfig.catchUpExit, 5);
  assert.equal(navigationConfig.stallThresholdMs, 1500);
  assert.equal(navigationConfig.recoveryMaxRetries, 2);
  assert.equal(navigationConfig.defaultCanDig, false);
  assert.equal(navigationConfig.defaultAllowBridge, false);
  assert.equal(navigationConfig.allowParkour, false);
  assert.ok(DIG_WHITELIST.has('dirt'));
  assert.ok(PLACE_WHITELIST.has('cobblestone'));
});

test('Config: combatConfig contains combat and retreat thresholds', () => {
  assert.equal(combatConfig.combatEnter, 8);
  assert.equal(combatConfig.combatExit, 16);
  assert.equal(combatConfig.retreatHealth, 6);
  assert.equal(combatConfig.retreatMobCount, 3);
  assert.equal(combatConfig.retreatSafeMs, 3000);
});

test('Config: survivalConfig contains eating thresholds and sleep boundaries', () => {
  assert.equal(survivalConfig.routineFood, 16);
  assert.equal(survivalConfig.emergencyFood, 6);
  assert.equal(survivalConfig.emergencyHealth, 10);
  assert.equal(survivalConfig.sleepMinTime, 12541);
  assert.equal(survivalConfig.sleepMaxTime, 23458);
});

test('Config: workConfig defines hunting, farming, and box constraints', () => {
  assert.equal(workConfig.pickupRadius, 5);
  assert.equal(workConfig.failureCooldownMs, 30_000);
  assert.deepEqual(workConfig.huntTargetAnimals, ['chicken', 'pig', 'cow', 'sheep']);
  assert.equal(workConfig.huntWorkDiameter, 50);
  assert.equal(workConfig.huntWorkRadius, 25);
  assert.equal(workConfig.huntMaxDurationMs, 1_200_000);

  assert.equal(workConfig.farmWorkDiameter, 50);
  assert.equal(workConfig.farmWorkRadius, 25);
  assert.equal(workConfig.farmMaxDurationMs, 1_200_000);
  assert.equal(workConfig.avoidJumpingOnFarmland, true);

  assert.ok(CROP_REGISTRY.wheat);
  assert.equal(CROP_REGISTRY.wheat.seedItem, 'wheat_seeds');
  assert.equal(CROP_REGISTRY.wheat.matureAge, 7);
  assert.ok(CROP_REGISTRY.beetroot);
  assert.equal(CROP_REGISTRY.beetroot.matureAge, 3);

  assert.equal(workConfig.boxMaxInteractionDistance, 3.5);
  assert.ok(workConfig.defaultPreservedItems.includes('bread'));
});

test('Config: systemConfig defines runner intervals and storage paths', () => {
  assert.equal(systemConfig.tickIntervalMs, 100);
  assert.equal(systemConfig.fenceTickMs, 50);
  assert.equal(systemConfig.chatIntervalMs, 1000);
  assert.equal(systemConfig.chatQueueLimit, 5);
  assert.equal(systemConfig.observationRadius, 32);
  assert.equal(systemConfig.stateStorageFile, 'data/state.json');
});

test('Config: backward compatibility composite THRESHOLDS matches domain configs', () => {
  assert.equal(THRESHOLDS.followEnter, navigationConfig.followEnter);
  assert.equal(THRESHOLDS.followExit, navigationConfig.followExit);
  assert.equal(THRESHOLDS.retreatHealth, combatConfig.retreatHealth);
  assert.equal(THRESHOLDS.routineFood, survivalConfig.routineFood);
  assert.equal(THRESHOLDS.pickupRadius, workConfig.pickupRadius);
  assert.equal(THRESHOLDS.observationRadius, systemConfig.observationRadius);
});
