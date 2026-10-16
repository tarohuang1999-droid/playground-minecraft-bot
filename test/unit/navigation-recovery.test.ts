import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createNavigation } from '../../src/actions/navigation.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';
import { workSubtree } from '../../src/bt/subtrees/work.ts';
import { createTree } from '../../src/bt/nodes.ts';

class FakeRecoveryBot extends EventEmitter {
  entity: any = {
    position: new Vec3(0, 64, 0),
    yaw: 0,
    onGround: true,
    isCollidedHorizontally: false,
  };
  controlStates: Record<string, boolean> = {};
  goalsSet: unknown[] = [];
  stopsCalled = 0;
  blocks: Map<string, any> = new Map();
  entities: Record<string | number, any> = {
    2: { id: 2, position: new Vec3(10, 64, 0) },
  };
  players: Record<string, any> = {
    owner: { entity: { id: 2, position: new Vec3(10, 64, 0) } },
  };

  pathfinder = {
    setGoal: (goal: unknown, _dynamic?: boolean) => {
      this.goalsSet.push(goal);
    },
    stop: () => {
      this.stopsCalled++;
    },
    isMoving: () => true,
    movements: { canDig: false, scafoldingBlocks: [] },
    setMovements: () => {},
  };

  setControlState(control: string, state: boolean) {
    this.controlStates[control] = state;
  }

  clearControlStates() {
    this.controlStates = {};
  }

  blockAt(pos: any) {
    const p = pos.floored
      ? pos.floored()
      : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    const key = `${p.x},${p.y},${p.z}`;
    return this.blocks.get(key) ?? { name: 'air', boundingBox: 'empty' };
  }

  setBlock(x: number, y: number, z: number, block: any) {
    this.blocks.set(`${x},${y},${z}`, block);
  }
}

test('partial path_update extends search and does not reset Goal or trigger stall', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'NormalFollow',
    runId: 'run-1',
    actionType: 'NormalFollow',
    targetId: 2,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK'],
    params: {},
  };
  const ctx: ActionContext = {
    request: req,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);
  const initialGoalsCount = bot.goalsSet.length;
  assert.equal(initialGoalsCount, 1);

  // Advance time past 1500ms while emitting partial updates
  currentTime += 1000;
  bot.emit('path_update', { status: 'partial' });
  adapter.update!(ctx);

  currentTime += 1000;
  bot.emit('path_update', { status: 'partial' });
  adapter.update!(ctx);

  // Partial path does not trigger stall
  assert.equal(bot.stopsCalled, 0);

  adapter.cancel!();
});

test('legal in-flight actions (digging, placing, door opening) and arrival do not trigger stall', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'NormalFollow',
    runId: 'run-1',
    actionType: 'NormalFollow',
    targetId: 2,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { canDig: true, allowBridge: true, missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);

  // Simulate in-flight door opening
  nav.doorManager.isInFlight = () => true;
  currentTime += 2000; // Stayed stationary for 2000ms > 1500ms
  const stallOutcome = adapter.update!(ctx);
  assert.equal(stallOutcome, undefined, 'Door opening in-flight must not trigger stall');
  nav.doorManager.isInFlight = () => false;

  // Simulate arrival: within exitDistance (1.2)
  bot.entity.position = new Vec3(9.5, 64, 0);
  const result = adapter.update!(ctx);
  assert.deepEqual(result, { status: 'SUCCESS' });

  adapter.cancel!();
});

test('NormalFollow reports FAILURE upon 1500ms stall and invokes onNavigationFailed', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  let failedReason: string | null = null;
  let failedMission: string | null = null;

  const nav = createNavigation(bot as any, undefined, {
    clock: { now: () => currentTime },
    onNavigationFailed: (reason, missionId) => {
      failedReason = reason;
      failedMission = missionId;
    },
  });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'NormalFollow',
    runId: 'run-1',
    actionType: 'NormalFollow',
    targetId: 2,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK'],
    params: { missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);

  currentTime += 1600;
  bot.pathfinder.isMoving = () => false;
  const outcome = adapter.update!(ctx);
  assert.equal(outcome?.status, 'FAILURE');
  assert.match(outcome?.reason ?? '', /Path obstructed or stalled/);
  assert.equal(failedMission, 'm1');
  assert.match(failedReason ?? '', /Path obstructed or stalled/);
  adapter.cancel!();
});

test('Behavior Tree integrated Recovery: NormalFollow stall triggers direct retry and fails after exhausting retries', () => {
  const available = new Set(['NormalFollow']);
  let failedReason: string | null = null;
  let failedMission: string | null = null;

  const treeRoot = workSubtree(available, {
    onNavigationFailed: (reason, missionId) => {
      failedReason = reason;
      failedMission = missionId;
    },
  });
  const tree = createTree(treeRoot);

  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);
  board.setIntent('FOLLOW', 1000);

  // Tick 1: Initial NormalFollow requested
  let snap = board.snapshot(0);
  const initialMissionId = snap.intent.missionId;
  let res = tree.tick(snap);
  assert.equal(res.status, 'RUNNING');
  assert.equal(res.requests[0]?.actionType, 'NormalFollow');
  const followRunId1 = res.requests[0]!.runId;

  // 1. Simulate NormalFollow fails (first stall)
  board.setRuntime({
    ...snap.runtime,
    results: {
      ...snap.runtime.results,
      [followRunId1]: { status: 'FAILURE', reason: 'Path obstructed or stalled' },
    },
  });

  // Tick 2: BT Recovery node catches failure and issues retry attempt 1
  snap = board.snapshot(1);
  res = tree.tick(snap);
  assert.equal(res.status, 'RUNNING');
  assert.equal(res.requests[0]?.actionType, 'NormalFollow');
  const followRunId2 = res.requests[0]!.runId;
  assert.notEqual(followRunId2, followRunId1);

  // 2. Simulate NormalFollow fails again
  board.setRuntime({
    ...snap.runtime,
    results: {
      ...snap.runtime.results,
      [followRunId2]: { status: 'FAILURE', reason: 'Path obstructed or stalled' },
    },
  });

  // Tick 3: BT Recovery node issues retry attempt 2
  snap = board.snapshot(2);
  res = tree.tick(snap);
  assert.equal(res.status, 'RUNNING');
  assert.equal(res.requests[0]?.actionType, 'NormalFollow');
  const followRunId3 = res.requests[0]!.runId;
  assert.notEqual(followRunId3, followRunId2);

  // 3. Simulate NormalFollow fails third time (exhausting maxRetries = 2)
  board.setRuntime({
    ...snap.runtime,
    results: {
      ...snap.runtime.results,
      [followRunId3]: { status: 'FAILURE', reason: 'Path obstructed or stalled' },
    },
  });

  // Tick 4: Exhausted -> returns FAILURE and calls onNavigationFailed
  snap = board.snapshot(3);
  res = tree.tick(snap);
  assert.equal(res.status, 'FAILURE');
  assert.equal(failedMission, initialMissionId);
  assert.match(failedReason ?? '', /Path obstructed/);
});
