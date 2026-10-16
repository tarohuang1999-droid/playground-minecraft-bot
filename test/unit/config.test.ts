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

test('Config Invariants: navigation and combat hysteresis prevent oscillation', () => {
  // Exit thresholds must strictly be lower/higher than enter thresholds to ensure hysteresis
  assert.ok(
    navigationConfig.followExit < navigationConfig.followEnter,
    'followExit must be less than followEnter'
  );
  assert.ok(
    navigationConfig.catchUpExit < navigationConfig.catchUpEnter,
    'catchUpExit must be less than catchUpEnter'
  );
  assert.ok(
    combatConfig.combatEnter < combatConfig.combatExit,
    'combatEnter must be less than combatExit'
  );
  assert.ok(
    THRESHOLDS.retreatEnter < THRESHOLDS.retreatExit,
    'retreatEnter must be less than retreatExit'
  );
});

test('Config Invariants: survival thresholds follow logical emergency ordering', () => {
  assert.ok(
    survivalConfig.emergencyFood < survivalConfig.routineFood,
    'emergencyFood must be strictly less than routineFood'
  );
  assert.ok(
    survivalConfig.sleepMinTime < survivalConfig.sleepMaxTime,
    'sleepMinTime must precede sleepMaxTime'
  );
});

test('Config Invariants: execution intervals, whitelists and crop registry validity', () => {
  assert.ok(navigationConfig.stallThresholdMs > 0);
  assert.ok(systemConfig.chatIntervalMs > 0);
  assert.ok(systemConfig.chatQueueLimit > 0);
  assert.ok(workConfig.pickupRadius > 0);
  assert.ok(DIG_WHITELIST.size > 0);
  assert.ok(PLACE_WHITELIST.size > 0);
  assert.ok(Object.keys(CROP_REGISTRY).length > 0);
});

test('Config Invariants: composite THRESHOLDS maintains backward compatibility', () => {
  assert.equal(THRESHOLDS.followEnter, navigationConfig.followEnter);
  assert.equal(THRESHOLDS.followExit, navigationConfig.followExit);
  assert.equal(THRESHOLDS.retreatHealth, combatConfig.retreatHealth);
  assert.equal(THRESHOLDS.routineFood, survivalConfig.routineFood);
  assert.equal(THRESHOLDS.pickupRadius, workConfig.pickupRadius);
  assert.equal(THRESHOLDS.observationRadius, systemConfig.observationRadius);
});
