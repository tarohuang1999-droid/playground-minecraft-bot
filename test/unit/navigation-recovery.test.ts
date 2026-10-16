import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import {
  createNavigation,
  checkLateralSafety,
  startMicroUnstuck,
  stepMicroUnstuck,
  cancelMicroUnstuck,
  findDetourWaypoint,
  checkChannelToTarget,
  createNavigationTaskState,
  NavigationRecoveryCoordinator,
} from '../../src/actions/navigation.ts';
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
    setGoal: (goal: unknown, dynamic?: boolean) => {
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
    const p = pos.floored ? pos.floored() : new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
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
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
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

  // Partial path does not trigger stall or recovery
  const taskState = nav.getTaskState();
  assert.equal(taskState?.recoveryActive ?? false, false);
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
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { canDig: true, allowBridge: true, missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);

  // Simulate in-flight door opening
  nav.doorManager.isInFlight = () => true;
  currentTime += 2000; // Stayed stationary for 2000ms > 1500ms
  adapter.update!(ctx);

  assert.equal(nav.getTaskState()?.recoveryActive, false, 'Door opening in-flight must not trigger stall');
  nav.doorManager.isInFlight = () => false;

  // Simulate arrival: within exitDistance (1.2)
  bot.entity.position = new Vec3(9.5, 64, 0);
  const result = adapter.update!(ctx);
  assert.deepEqual(result, { status: 'SUCCESS' });
  assert.equal(nav.getTaskState()?.recoveryActive, false, 'Arrival must not trigger recovery');

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
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: { missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
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

test('unstickCorner executes two-phase corner disengage (back+side then forward+side) and returns SUCCESS', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(1, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(-1, 63, 0, { name: 'stone', boundingBox: 'block' });

  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'UnstickCorner', runId: 'run-1', actionType: 'UnstickCorner',
    targetId: null, priority: 25, requiredResources: ['MOVE', 'LOOK'], params: { missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.unstickCorner(req);
  adapter.start(ctx);

  // Phase 1 (0-1000ms): disengage engages back and lateral (left)
  assert.equal(bot.controlStates.left, true);
  assert.equal(bot.controlStates.back, true);

  // Phase 2 (1000-2500ms): clearance releases back, engages forward + lateral
  currentTime += 1000;
  adapter.update!(ctx);
  assert.equal(bot.controlStates.back, false);
  assert.equal(bot.controlStates.forward, true);
  assert.equal(bot.controlStates.left, true);

  // Completion at 2500ms: clears controls and returns SUCCESS
  currentTime += 1500;
  const outcome = adapter.update!(ctx);
  assert.equal(outcome?.status, 'SUCCESS');
  assert.equal(bot.controlStates.forward, false);
  assert.equal(bot.controlStates.left, false);
  assert.equal(bot.controlStates.back, false);
  assert.equal(adapter.isStopped!(), true);
});

test('unsafe terrain (cliff, wall, unloaded block) skips lateral micro-unstuck', () => {
  const bot = new FakeRecoveryBot();
  bot.entity.position = new Vec3(0, 64, 0);
  bot.entity.yaw = 0;
  bot.entity.onGround = true;

  // Case 1: Cliff (air below target at y-1)
  bot.setBlock(1, 63, 0, { name: 'air', boundingBox: 'empty' });
  const leftCliff = checkLateralSafety(bot as any, 'left');
  assert.equal(leftCliff.safe, false, 'Must reject lateral move over cliff/void');

  // Case 2: Wall (solid block in foot or head space)
  bot.setBlock(1, 63, 0, { name: 'stone', boundingBox: 'block' }); // ground safe
  bot.setBlock(1, 64, 0, { name: 'cobblestone', boundingBox: 'block' }); // foot blocked by wall
  const leftWall = checkLateralSafety(bot as any, 'left');
  assert.equal(leftWall.safe, false, 'Must reject lateral move into solid wall');

  // Case 3: Unloaded block (blockAt returns null)
  bot.blockAt = () => null;
  const leftUnloaded = checkLateralSafety(bot as any, 'left');
  assert.equal(leftUnloaded.safe, false, 'Must reject lateral move into unloaded terrain');

  // Case 4: Ungrounded bot (falling/jumping)
  bot.entity.onGround = false;
  const ungrounded = checkLateralSafety(bot as any, 'left');
  assert.equal(ungrounded.safe, false, 'Must reject micro-unstuck when bot is not on ground');
});

test('unstickCorner cancel cleans up manual controls', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(1, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(-1, 63, 0, { name: 'stone', boundingBox: 'block' });

  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const req: ActionRequest = {
    nodeId: 'UnstickCorner', runId: 'run-1', actionType: 'UnstickCorner',
    targetId: null, priority: 25, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.unstickCorner(req);
  adapter.start(ctx);
  assert.equal(bot.controlStates.left, true);

  adapter.cancel!();
  assert.equal(bot.controlStates.left, false);
  assert.equal(bot.controlStates.back, false);
  assert.equal(bot.controlStates.forward, false);
  assert.equal(adapter.isStopped!(), true);
});

test('Behavior Tree integrated Recovery: NormalFollow stall triggers DetourWaypoint, retry resumes NormalFollow', () => {
  const available = new Set(['NormalFollow', 'DetourWaypoint']);
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

  // Tick 1: NormalFollow requested
  let snap = board.snapshot(0);
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

  // Tick 2: BT Recovery node catches failure and directly issues DetourWaypoint (stage 1)
  snap = board.snapshot(1);
  res = tree.tick(snap);
  assert.equal(res.status, 'RUNNING');
  assert.equal(res.requests[0]?.actionType, 'DetourWaypoint');
  assert.equal(res.requests[0]?.params.targetX, 10);
  const detourRunId = res.requests[0]!.runId;

  // Simulate DetourWaypoint succeeds (channel opened / arrived at detour)
  board.setRuntime({
    ...snap.runtime,
    results: {
      ...snap.runtime.results,
      [detourRunId]: { status: 'SUCCESS' },
    },
  });

  // Tick 3: Detour succeeded -> resumes NormalFollow again!
  snap = board.snapshot(2);
  res = tree.tick(snap);
  assert.equal(res.status, 'RUNNING');
  assert.equal(res.requests[0]?.actionType, 'NormalFollow');
  const followRunId2 = res.requests[0]!.runId;
  assert.notEqual(followRunId2, followRunId1);
});

test('findDetourWaypoint generates ~6 block perpendicular candidates, evaluates vertical offsets, and skips attempted points', () => {
  const bot = new FakeRecoveryBot();
  const currentPos = { x: 0, y: 64, z: 0 };
  const targetPos = { x: 10, y: 64, z: 0 }; // Vector is (+1, 0)
  const taskState = createNavigationTaskState('m1');

  // Candidate perpendiculars at distance 6:
  // Left: z = -6; Right: z = +6
  // Setup ground at cand1 (0, 63, -6)
  bot.setBlock(0, 63, -6, { name: 'stone', boundingBox: 'block' });

  // 1. Cand on left found
  const candLeft = findDetourWaypoint(bot as any, currentPos, targetPos, taskState);
  assert.ok(candLeft);
  assert.equal(candLeft.side, 'left');
  assert.equal(candLeft.pos.x, 0);
  assert.equal(candLeft.pos.y, 64);
  assert.equal(candLeft.pos.z, -6);

  // 2. If left candidate was already attempted, it should skip it and check right
  taskState.attemptedWaypoints.push(candLeft.pos);
  // Setup ground for right candidate with vertical offset dy = +1 (y=65, ground at y=64)
  bot.setBlock(0, 64, 6, { name: 'stone', boundingBox: 'block' });

  const candRight = findDetourWaypoint(bot as any, currentPos, targetPos, taskState);
  assert.ok(candRight);
  assert.equal(candRight.side, 'right');
  assert.equal(candRight.pos.x, 0);
  assert.equal(candRight.pos.y, 65);
  assert.equal(candRight.pos.z, 6);

  // 3. If both attempted, returns null
  taskState.attemptedWaypoints.push(candRight.pos);
  const candNone = findDetourWaypoint(bot as any, currentPos, targetPos, taskState);
  assert.equal(candNone, null, 'Returns null when all safe candidates have already been attempted');
});

test('checkChannelToTarget probes up to 3 blocks towards target for support and foot/head clearance', () => {
  const bot = new FakeRecoveryBot();
  const fromPos = { x: 0, y: 64, z: 0 };
  const targetPos = { x: 10, y: 64, z: 0 };

  // Case 1: Void/cliff (no support blocks)
  assert.equal(checkChannelToTarget(bot as any, fromPos, targetPos), false);

  // Case 2: Solid support at y-1 for 3 steps, clear at foot and head
  for (let x = 1; x <= 3; x++) {
    bot.setBlock(x, 63, 0, { name: 'stone', boundingBox: 'block' });
  }
  assert.equal(checkChannelToTarget(bot as any, fromPos, targetPos), true);

  // Case 3: Wall at step 2 (foot space occupied)
  bot.setBlock(2, 64, 0, { name: 'cobblestone', boundingBox: 'block' });
  assert.equal(checkChannelToTarget(bot as any, fromPos, targetPos), false);

  // Case 4: Wall removed, but ceiling at step 2 (head space occupied)
  bot.setBlock(2, 64, 0, { name: 'air', boundingBox: 'empty' });
  bot.setBlock(2, 65, 0, { name: 'cobblestone', boundingBox: 'block' });
  assert.equal(checkChannelToTarget(bot as any, fromPos, targetPos), false);
});

test('detourWaypoint navigates to waypoint and restores early when channel clears', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  // Wall blocks straight path at x=2
  for (let z = -2; z <= 2; z++) {
    bot.setBlock(2, 64, z, { name: 'cobblestone', boundingBox: 'block' });
    bot.setBlock(2, 65, z, { name: 'cobblestone', boundingBox: 'block' });
  }
  // Safe ground for detour waypoint at (0, 64, -6)
  bot.setBlock(0, 63, -6, { name: 'stone', boundingBox: 'block' });

  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'DetourWaypoint', runId: 'run-1', actionType: 'DetourWaypoint',
    targetId: 2, priority: 25, requiredResources: ['MOVE', 'LOOK'],
    params: { missionId: 'm1', targetX: 10, targetY: 64, targetZ: 0 },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.detourWaypoint(req);
  adapter.start(ctx);
  assert.equal(bot.goalsSet.length, 1);

  // Bot moves towards waypoint: displacement 3 blocks (0, 64, -3)
  currentTime += 500;
  bot.entity.position = new Vec3(0, 64, -3);
  let res = adapter.update!(ctx);
  assert.equal(res, undefined); // In flight

  // Bot navigates around the wall corner to (4, 64, -4) where channel is clear
  bot.entity.position = new Vec3(4, 64, -4);
  for (let step = 1; step <= 3; step++) {
    const px = Math.round(4 + ((10 - 4) / Math.hypot(6, 4)) * step);
    const pz = Math.round(-4 + ((0 - (-4)) / Math.hypot(6, 4)) * step);
    bot.setBlock(px, 63, pz, { name: 'stone', boundingBox: 'block' });
  }

  // Next update: mid-route probe detects open channel and returns SUCCESS early!
  currentTime += 500;
  res = adapter.update!(ctx);
  assert.equal(res?.status, 'SUCCESS');
  adapter.cancel!();
});

test('detourWaypoint arrival returns SUCCESS and timeout returns FAILURE', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(0, 63, -6, { name: 'stone', boundingBox: 'block' });

  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 2, position: { x: 10, y: 64, z: 0 }, distance: 10 };
  board.setWorld(world);

  const req: ActionRequest = {
    nodeId: 'DetourWaypoint', runId: 'run-1', actionType: 'DetourWaypoint',
    targetId: 2, priority: 25, requiredResources: ['MOVE', 'LOOK'],
    params: { missionId: 'm1', targetX: 10, targetY: 64, targetZ: 0 },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  // Subcase A: Arrived at waypoint (0, 64, -6)
  const adapter = nav.detourWaypoint(req);
  adapter.start(ctx);
  bot.entity.position = new Vec3(0, 64, -5.5); // <= 1.5 blocks
  const arrOutcome = adapter.update!(ctx);
  assert.equal(arrOutcome?.status, 'SUCCESS');
  adapter.cancel!();

  // Subcase B: Timeout after 10s
  const timeoutAdapter = nav.detourWaypoint(req);
  timeoutAdapter.start(ctx);
  currentTime += 10500;
  const timeoutOutcome = timeoutAdapter.update!(ctx);
  assert.equal(timeoutOutcome?.status, 'FAILURE');
  assert.match(timeoutOutcome?.reason ?? '', /timed out/);
  timeoutAdapter.cancel!();
});
