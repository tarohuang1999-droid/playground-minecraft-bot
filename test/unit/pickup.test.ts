import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createPerception, type PerceptionSource } from '../../src/perception.ts';
import { createNavigation } from '../../src/actions/navigation.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';
import { THRESHOLDS } from '../../src/policy.ts';

test('pickup perception: detects drops within 5 blocks and skips distant, non-item or cooldown entities', () => {
  const fakeBot: PerceptionSource = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    players: { dakaz: { entity: { id: 2, position: { x: 2, y: 64, z: 2 } } } },
    entities: {
      1: { id: 1, position: { x: 0, y: 64, z: 0 } }, // self
      10: {
        id: 10,
        name: 'item',
        position: { x: 2, y: 64, z: 0 },
        getDroppedItem: () => ({ name: 'iron_ingot' }),
      }, // within 5 blocks
      11: { id: 11, name: 'Item', position: { x: 0, y: 64, z: 4.5 }, displayName: 'diamond' }, // within 5 blocks
      12: { id: 12, name: 'item', position: { x: 8, y: 64, z: 0 } }, // > 5 blocks (pickupRadius is 5)
      13: { id: 13, name: 'zombie', position: { x: 1, y: 64, z: 0 } }, // not an item
      14: { id: 14, name: 'item', position: { x: 1, y: 64, z: 1 } }, // cooldown item
    },
    inventory: { emptySlotCount: () => 5 },
  };

  const perception = createPerception(fakeBot, 'dakaz');
  const now = Date.now();
  const world = perception.sample({ 14: now + 10_000 });

  assert.equal(world.nearbyDrops.length, 2);
  assert.equal(world.nearbyDrops[0]?.entityId, 10);
  assert.equal(world.nearbyDrops[0]?.itemName, 'iron_ingot');
  assert.equal(world.nearbyDrops[1]?.entityId, 11);
  assert.equal(world.nearbyDrops[1]?.itemName, 'diamond');
  assert.equal(world.inventory.freeSlots, 5);
});

test('work subtree: triggers PickupItem in non-follow (STAY/IDLE) state when nearby drop exists', () => {
  const available = new Set(['NormalFollow', 'CatchUpFollow', 'PickupItem', 'Idle']);
  const tree = createCompanionTree(available);
  const board = createBlackboard('dakaz');

  // STAY mode, item 2 blocks away
  board.setIntent('STAY', 100);
  const world = createWorld('dakaz');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.inventory.freeSlots = 3;
  world.nearbyDrops = [
    {
      entityId: 101,
      name: 'item',
      itemName: 'bread',
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
    },
  ];
  board.setWorld(world);

  const snapshot = board.snapshot(100);
  const tickResult = tree.tick(snapshot);

  assert.equal(tickResult.status, 'RUNNING');
  const pickupReq = tickResult.requests.find(r => r.actionType === 'PickupItem');
  assert.ok(pickupReq, 'PickupItem should be requested in STAY mode');
  assert.equal(pickupReq?.targetId, 101);
  assert.equal(pickupReq?.priority, 30);
});

test('work subtree: in FOLLOW mode, PickupItem (30) preempts NormalFollow (20) if master is within 10 blocks', () => {
  const available = new Set(['NormalFollow', 'CatchUpFollow', 'PickupItem', 'Idle']);
  const tree = createCompanionTree(available);
  const board = createBlackboard('dakaz');

  board.setIntent('FOLLOW', 100);
  const world = createWorld('dakaz');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'dakaz', entityId: 2, position: { x: 4, y: 64, z: 0 }, distance: 4 };
  world.inventory.freeSlots = 2;
  world.nearbyDrops = [
    {
      entityId: 202,
      name: 'item',
      itemName: 'apple',
      position: { x: 1, y: 64, z: 1 },
      distance: 1.41,
    },
  ];
  board.setWorld(world);

  const snapshot = board.snapshot(100);
  const tickResult = tree.tick(snapshot);

  const pickupReq = tickResult.requests.find(r => r.actionType === 'PickupItem');
  const followReq = tickResult.requests.find(r => r.actionType === 'NormalFollow');
  assert.ok(pickupReq, 'PickupItem should preempt NormalFollow');
  assert.equal(
    followReq,
    undefined,
    'NormalFollow should not be requested when PickupItem is active'
  );
  assert.equal(pickupReq?.targetId, 202);
});

test('work subtree: CatchUpFollow (40) preempts PickupItem (30) when master is far (> 16 blocks)', () => {
  const available = new Set(['NormalFollow', 'CatchUpFollow', 'PickupItem', 'Idle']);
  const tree = createCompanionTree(available);
  const board = createBlackboard('dakaz');

  board.setIntent('FOLLOW', 100);
  const world = createWorld('dakaz');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'dakaz', entityId: 2, position: { x: 20, y: 64, z: 0 }, distance: 20 };
  world.inventory.freeSlots = 2;
  world.nearbyDrops = [
    {
      entityId: 202,
      name: 'item',
      itemName: 'apple',
      position: { x: 1, y: 64, z: 1 },
      distance: 1.41,
    },
  ];
  board.setWorld(world);

  const snapshot = board.snapshot(100);
  const tickResult = tree.tick(snapshot);

  const catchUpReq = tickResult.requests.find(r => r.actionType === 'CatchUpFollow');
  const pickupReq = tickResult.requests.find(r => r.actionType === 'PickupItem');
  assert.ok(catchUpReq, 'CatchUpFollow should be chosen over PickupItem');
  assert.equal(pickupReq, undefined, 'PickupItem must not be requested when master is far');
});

test('work subtree: resumes NormalFollow immediately after item is picked up', () => {
  const available = new Set(['NormalFollow', 'CatchUpFollow', 'PickupItem', 'Idle']);
  const tree = createCompanionTree(available);
  const board = createBlackboard('dakaz');

  board.setIntent('FOLLOW', 100);
  const world = createWorld('dakaz');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'dakaz', entityId: 2, position: { x: 4, y: 64, z: 0 }, distance: 4 };
  world.inventory.freeSlots = 2;
  world.nearbyDrops = [
    {
      entityId: 303,
      name: 'item',
      itemName: 'emerald',
      position: { x: 1, y: 64, z: 0 },
      distance: 1,
    },
  ];
  board.setWorld(world);

  // Round 1: Item present -> PickupItem
  let snapshot = board.snapshot(100);
  let res = tree.tick(snapshot);
  assert.ok(res.requests.some(r => r.actionType === 'PickupItem'));

  // Round 2: Item picked up (nearbyDrops is now empty)
  world.nearbyDrops = [];
  board.setWorld(world);
  snapshot = board.snapshot(200);
  res = tree.tick(snapshot);

  const followReq = res.requests.find(r => r.actionType === 'NormalFollow');
  assert.ok(followReq, 'Should seamlessly resume NormalFollow after item is collected');
  assert.equal(followReq?.targetId, 2);
});

test('pickup adapter: sets GoalNear on start, returns SUCCESS when item entity disappears', () => {
  const goalsSet: Array<{ goal: any; dynamic?: boolean | undefined }> = [];
  const fakeBot = {
    pathfinder: {
      setGoal(goal: any, dynamic?: boolean) {
        goalsSet.push({ goal, dynamic });
      },
    },
    entities: {
      50: { id: 50, position: { x: 3, y: 64, z: 3 } },
    },
  };

  const nav = createNavigation(fakeBot as any);
  const board = createBlackboard('dakaz');
  const world = createWorld('dakaz');
  world.self.position = { x: 0, y: 64, z: 0 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'PickupItem',
    runId: 'run-p1',
    actionType: 'PickupItem',
    targetId: 50,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK'],
    params: { itemName: 'gold_ingot' },
  };

  let active = true;
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => active,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.pickupItem(request);
  adapter.start(ctx);

  assert.equal(goalsSet.length, 1);
  assert.equal(goalsSet[0]?.dynamic, false);
  assert.ok(goalsSet[0]?.goal);

  // Still present -> stays running (no return value)
  const stillRunning = adapter.update!(ctx);
  assert.equal(stillRunning, undefined);

  // Item collected -> entity removed from bot.entities
  delete (fakeBot.entities as any)[50];
  const finished = adapter.update!(ctx);
  assert.deepEqual(finished, { status: 'SUCCESS' });
});

test('pickup timeout and failure triggers 30-second cooldown in executor', () => {
  const arbiter = createArbiter();
  let failNow = false;
  const adapters = {
    PickupItem: () => ({
      start() {},
      update() {
        if (failNow) return { status: 'FAILURE' as const, reason: 'Timeout' };
      },
      cancel() {},
    }),
    Idle: () => ({ start() {}, cancel() {} }),
  };

  const executor = createExecutor(arbiter, adapters);
  const board = createBlackboard('dakaz');
  const snapshot = board.snapshot(100);

  const request: ActionRequest = {
    nodeId: 'PickupItem',
    runId: 'pickup-run-1',
    actionType: 'PickupItem',
    targetId: 777,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK'],
    params: {},
  };

  // Reconcile and start
  executor.reconcile([request], snapshot, 100);
  assert.ok(executor.runtime().activeRuns['pickup-run-1']);

  // Next round: Action fails
  failNow = true;
  executor.reconcile([request], snapshot, 150);
  executor.flushResults(150);

  let runtime = executor.runtime();
  assert.equal(runtime.activeRuns['pickup-run-1']?.status, 'STOPPING');
  assert.equal(runtime.cooldowns[777], 150 + THRESHOLDS.failureCooldownMs);

  executor.advanceTick();
  runtime = executor.runtime();
  assert.equal(runtime.activeRuns['pickup-run-1'], undefined);
});
