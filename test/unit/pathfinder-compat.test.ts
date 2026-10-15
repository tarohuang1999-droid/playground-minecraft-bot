import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { goals, Movements, pathfinder } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import {
  DIG_WHITELIST,
  PLACE_WHITELIST,
  NavigationExecutionBoundary,
  createNavigationTaskState,
  setupMovements,
  type NavigationRunContext,
} from '../../src/actions/navigation.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import type { ActionAdapter, ActionContext, ActionRequest, ActionResult } from '../../src/execution/types.ts';
import { createBlackboard } from '../../src/blackboard.ts';

const mcData = (minecraftData as any)('1.20.4');

function createMockBot() {
  const bot: any = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0), onGround: true };
  bot.entities = {};
  bot.game = { minY: -64, height: 384 };
  bot.inventory = {
    items: () => [
      { type: mcData.itemsByName.dirt.id, count: 64 },
      { type: mcData.itemsByName.cobblestone.id, count: 32 },
      { type: mcData.itemsByName.diamond.id, count: 10 },
    ],
  };
  bot.heldItem = null;
  bot.registry = mcData;
  bot.blockAt = (p: any) => ({
    type: 0,
    name: 'air',
    boundingBox: 'empty',
    shapes: [],
    position: p,
  });
  bot.clearControlStates = () => {};
  pathfinder(bot);
  return bot;
}

test('Movements: canDig=false rejects all blocks; canDig=true strictly enforces DIG_WHITELIST', () => {
  const bot = createMockBot();

  const block = (name: string, type: number) => ({ name, type } as any);

  // 1. canDig = false (default)
  const mOff = setupMovements(bot, undefined, { canDig: false, allowBridge: false });
  assert.ok(mOff);
  assert.equal(mOff.canDig, false);
  assert.equal(mOff.safeToBreak(block('dirt', mcData.blocksByName.dirt.id)), false);
  assert.equal(mOff.safeToBreak(block('grass_block', mcData.blocksByName.grass_block.id)), false);
  assert.equal(mOff.safeToBreak(block('cobblestone', mcData.blocksByName.cobblestone.id)), false);

  // 2. canDig = true
  const mOn = setupMovements(bot, undefined, { canDig: true, allowBridge: false });
  assert.ok(mOn);
  assert.equal(mOn.canDig, true);

  // Whitelisted blocks should be safe to break
  assert.equal(mOn.safeToBreak(block('dirt', mcData.blocksByName.dirt.id)), true);
  assert.equal(mOn.safeToBreak(block('grass_block', mcData.blocksByName.grass_block.id)), true);
  assert.equal(mOn.safeToBreak(block('cobblestone', mcData.blocksByName.cobblestone.id)), true);
  assert.equal(mOn.safeToBreak(block('sand', mcData.blocksByName.sand.id)), true);
  assert.equal(mOn.safeToBreak(block('gravel', mcData.blocksByName.gravel.id)), true);
  assert.equal(mOn.safeToBreak(block('oak_leaves', mcData.blocksByName.oak_leaves.id)), true);

  // Non-whitelisted blocks MUST be rejected
  assert.equal(mOn.safeToBreak(block('diamond_ore', mcData.blocksByName.diamond_ore.id)), false);
  assert.equal(mOn.safeToBreak(block('iron_door', mcData.blocksByName.iron_door.id)), false);
  assert.equal(mOn.safeToBreak(block('oak_door', mcData.blocksByName.oak_door.id)), false);
  assert.equal(mOn.safeToBreak(block('chest', mcData.blocksByName.chest.id)), false);
  assert.equal(mOn.safeToBreak(block('bedrock', mcData.blocksByName.bedrock.id)), false);
});

test('Movements: scaffoldingBlocks strictly follows PLACE_WHITELIST and allowBridge flag', () => {
  const bot = createMockBot();

  // 1. allowBridge = false -> scaffoldingBlocks is empty, count is 0
  const mNoBridge = setupMovements(bot, undefined, { canDig: false, allowBridge: false });
  assert.ok(mNoBridge);
  assert.deepEqual(mNoBridge.scafoldingBlocks, []);
  assert.equal(mNoBridge.countScaffoldingItems(), 0);
  assert.equal(mNoBridge.allow1by1towers, false);

  // 2. allowBridge = true -> scaffoldingBlocks contains only dirt & cobblestone
  const mBridge = setupMovements(bot, undefined, { canDig: false, allowBridge: true });
  assert.ok(mBridge);
  const expectedIds = [mcData.itemsByName.dirt.id, mcData.itemsByName.cobblestone.id];
  assert.deepEqual(mBridge.scafoldingBlocks, expectedIds);
  assert.equal(mBridge.countScaffoldingItems(), 64 + 32); // dirt (64) + cobblestone (32), excluding diamond (10)
  assert.equal(mBridge.allow1by1towers, false);
});

test('A* sliced generator: getPathFromTo can be stepped slice-by-slice without synchronous blocking loop', () => {
  const bot = createMockBot();
  const m = setupMovements(bot, undefined, { canDig: false, allowBridge: false })!;
  const goal = new goals.GoalNear(10, 64, 10, 1);

  // Obtain generator from pathfinder plugin
  const generator = bot.pathfinder.getPathFromTo(m, bot.entity.position, goal, {
    tickTimeout: 5,
    timeout: 50,
  });

  assert.equal(typeof generator.next, 'function');
  const slice1 = generator.next();
  assert.equal(slice1.done, false);
  assert.ok(slice1.value);
  assert.ok(slice1.value.result);
  assert.ok(['partial', 'success', 'noPath', 'timeout'].includes(slice1.value.result.status));
});

test('NavigationExecutionBoundary: enforces whitelist, authorization, and max 3 quota without refund', async () => {
  const boundary = new NavigationExecutionBoundary();
  let serverDigs = 0;
  let serverPlaces = 0;

  const fakeBot: any = {
    dig: async (_b: any) => { serverDigs++; },
    placeBlock: async (_ref: any, _face: any) => { serverPlaces++; },
    heldItem: { name: 'dirt' },
  };

  boundary.install(fakeBot);

  const taskState = createNavigationTaskState('mission-1', true, true);
  let active = true;

  const runCtx: NavigationRunContext = {
    token: 1,
    generation: 0,
    canDig: true,
    allowBridge: true,
    taskState,
    isActive: () => active,
  };

  boundary.setActiveContext(runCtx);

  // 1. Whitelisted dig succeeds and decrements quota
  await fakeBot.dig({ name: 'dirt' });
  assert.equal(serverDigs, 1);
  assert.equal(taskState.digQuota, 2);

  // 2. Non-whitelisted block is rejected and does not reach server
  await assert.rejects(
    () => fakeBot.dig({ name: 'diamond_ore' }),
    /not in dig whitelist/
  );
  assert.equal(serverDigs, 1);
  assert.equal(taskState.digQuota, 2); // Quota was not deducted because check failed before dispatch

  // 3. Complete remaining 2 digs
  await fakeBot.dig({ name: 'cobblestone' });
  await fakeBot.dig({ name: 'sand' });
  assert.equal(serverDigs, 3);
  assert.equal(taskState.digQuota, 0);

  // 4. 4th dig rejected due to quota exhausted
  await assert.rejects(
    () => fakeBot.dig({ name: 'dirt' }),
    /dig quota exhausted/
  );
  assert.equal(serverDigs, 3);

  // 5. Place blocks: 3 allowed, 4th rejected
  await fakeBot.placeBlock({}, {});
  await fakeBot.placeBlock({}, {});
  await fakeBot.placeBlock({}, {});
  assert.equal(serverPlaces, 3);
  assert.equal(taskState.placeQuota, 0);

  await assert.rejects(
    () => fakeBot.placeBlock({}, {}),
    /place quota exhausted/
  );
  assert.equal(serverPlaces, 3);

  // 6. Non-whitelisted placed item rejected
  taskState.placeQuota = 1;
  fakeBot.heldItem = { name: 'diamond_block' };
  await assert.rejects(
    () => fakeBot.placeBlock({}, {}),
    /not in place whitelist/
  );
  assert.equal(serverPlaces, 3);

  boundary.uninstall(fakeBot);
});

test('NavigationExecutionBoundary: pending delayed callbacks after cancellation/session reset are rejected', async () => {
  const boundary = new NavigationExecutionBoundary();
  let serverDigs = 0;

  const fakeBot: any = {
    dig: async (_b: any) => { serverDigs++; },
    placeBlock: async (_ref: any, _face: any) => {},
    heldItem: { name: 'dirt' },
  };

  boundary.install(fakeBot);

  const taskState = createNavigationTaskState('mission-2', true, true);
  let active = true;

  const runCtx: NavigationRunContext = {
    token: 1,
    generation: 0,
    canDig: true,
    allowBridge: true,
    taskState,
    isActive: () => active,
  };

  boundary.setActiveContext(runCtx);

  // Simulate delayed callback after cancellation
  active = false; // run cancelled
  boundary.setActiveContext(null);

  await assert.rejects(
    () => fakeBot.dig({ name: 'dirt' }),
    /navigation run is not active/
  );
  assert.equal(serverDigs, 0);

  await assert.rejects(
    () => fakeBot.placeBlock({}, {}),
    /navigation run is not active/
  );

  boundary.uninstall(fakeBot);
});

test('Executor: cancellation confirmation holds locks until isStopped() is true', () => {
  let isStoppedVal = false;
  let cancelled = false;

  const arbiter = createArbiter();
  const executor = createExecutor(arbiter, {
    NormalFollow: () => ({
      start() {},
      cancel() { cancelled = true; },
      isStopped: () => isStoppedVal,
    }),
  });

  const snapshot = createBlackboard('owner').snapshot(0);
  const req1: ActionRequest = {
    nodeId: 'n1', runId: 'run-1', actionType: 'NormalFollow', targetId: null,
    priority: 20, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'], params: {},
  };

  // Start run-1
  executor.reconcile([req1], snapshot, 0);
  assert.equal(executor.runtime().lockedResources.MOVE, 'run-1');

  // Preempt with another action -> stops run-1
  executor.reconcile([], snapshot, 10);
  assert.equal(cancelled, true);

  // Tick 1: isStopped is false -> lock NOT released yet!
  executor.advanceTick(50);
  assert.equal(executor.runtime().lockedResources.MOVE, 'run-1');

  // Tick 2: still false -> lock NOT released
  executor.advanceTick(100);
  assert.equal(executor.runtime().lockedResources.MOVE, 'run-1');

  // Now async side-effect finishes -> isStopped is true
  isStoppedVal = true;
  executor.advanceTick(150);
  // Released!
  assert.equal(executor.runtime().lockedResources.MOVE, null);
});

test('Executor: cancellation confirmation timeout (1000ms) transitions to FAULTED without releasing locks', () => {
  let isStoppedVal = false;

  const arbiter = createArbiter();
  const executor = createExecutor(arbiter, {
    NormalFollow: () => ({
      start() {},
      cancel() {},
      isStopped: () => isStoppedVal,
    }),
  });

  const snapshot = createBlackboard('owner').snapshot(0);
  const req1: ActionRequest = {
    nodeId: 'n1', runId: 'run-1', actionType: 'NormalFollow', targetId: null,
    priority: 20, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'], params: {},
  };

  executor.reconcile([req1], snapshot, 0);
  executor.reconcile([], snapshot, 10); // Trigger stop

  // Advance 21 ticks (exceeding 20 ticks / 1000ms)
  for (let t = 0; t < 21; t++) {
    executor.advanceTick(10 + t * 50);
  }

  // Should be FAULTED and locks retained to protect safety
  assert.ok(executor.fault());
  assert.match(executor.fault()!, /cancellation confirmation timed out/);
  assert.equal(executor.runtime().lockedResources.MOVE, 'run-1');
});
