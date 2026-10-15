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

test('micro-unstuck executes two-phase corner disengage (back+side then forward+side) and retries up to 3 times', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(1, 63, 0, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(-1, 63, 0, { name: 'stone', boundingBox: 'block' });

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

  // 1. Initial 1500ms stall: triggers Attempt 1 (Phase 1: Disengage)
  currentTime += 1500;
  adapter.update!(ctx);

  const taskState = nav.getTaskState()!;
  assert.equal(taskState.recoveryActive, true, 'Recovery must activate upon 1500ms stall');
  assert.equal(taskState.microUnstuckAttempts, 1, 'Attempt 1 started');
  assert.equal(taskState.microUnstuckActive, true, 'Micro-unstuck currently active');
  assert.equal(taskState.microUnstuckPhase, 'disengage', 'Phase 1 is disengage');
  assert.equal(bot.stopsCalled, 1, 'Pathfinder stopped before manual control');
  assert.equal(bot.controlStates.back, true, 'Phase 1 engages backward to pull away from corner');
  assert.equal(bot.controlStates.left, true, 'Phase 1 engages lateral direction');

  // 2. Step into Phase 2 (Clearance) after 200ms
  currentTime += 200;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckActive, true);
  assert.equal(taskState.microUnstuckPhase, 'clearance', 'Transitioned to phase 2 clearance');
  assert.equal(bot.controlStates.back, false, 'Back key released in phase 2');
  assert.equal(bot.controlStates.forward, true, 'Forward key engaged in phase 2');
  assert.equal(bot.controlStates.left, true, 'Lateral key retained for outer arc');

  // 3. Step to completion (+250ms, total 450ms)
  currentTime += 250;
  const goalsBeforeFinish = bot.goalsSet.length;
  adapter.update!(ctx);

  assert.equal(taskState.microUnstuckActive, false, 'Attempt 1 finished');
  assert.equal(bot.controlStates.left, false, 'Controls cleared on completion');
  assert.equal(bot.controlStates.forward, false, 'Forward cleared');
  assert.equal(bot.goalsSet.length, goalsBeforeFinish + 1, 'Original goal restored to pathfinder');

  // 4. Stall again within recovery: Attempt 2 triggers (800ms threshold)
  currentTime += 800;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckAttempts, 2, 'Attempt 2 triggered on subsequent stall');
  assert.equal(taskState.microUnstuckActive, true);

  // Complete Attempt 2
  currentTime += 450;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckActive, false, 'Attempt 2 finished');

  // 5. Stall again: Attempt 3 triggers
  currentTime += 800;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckAttempts, 3, 'Attempt 3 triggered on subsequent stall');
  assert.equal(taskState.microUnstuckActive, true);

  // Complete Attempt 3
  currentTime += 450;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckActive, false, 'Attempt 3 finished');
  assert.equal(taskState.microUnstuckDone, true, 'All 3 attempts done');

  // 6. Stall once more after 3 attempts exhausted: must return FAILURE and call onNavigationFailed
  currentTime += 800;
  const failResult = adapter.update!(ctx);
  assert.equal(failResult?.status, 'FAILURE');
  assert.match(failResult?.reason ?? '', /Path obstructed/);
  assert.equal(failedMission, 'm1');
  assert.match(failedReason ?? '', /Path obstructed/);

  adapter.cancel!();
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

test('manual controls and pathfinder never compete, cancel cleans up all listeners and controls', () => {
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
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: { missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);

  assert.equal(bot.listenerCount('path_update'), 1);
  assert.equal(bot.listenerCount('path_reset'), 1);

  // Trigger micro-unstuck
  currentTime += 1500;
  adapter.update!(ctx);
  assert.equal(bot.controlStates.left, true);
  assert.equal(adapter.isStopped!(), false, 'isStopped() false while micro-unstuck active');

  // Cancel while micro-unstuck is active
  adapter.cancel!();

  assert.equal(bot.controlStates.left, false, 'Controls cleared on cancel');
  assert.equal(bot.listenerCount('path_update'), 0, 'path_update listener removed on cancel');
  assert.equal(bot.listenerCount('path_reset'), 0, 'path_reset listener removed on cancel');
  assert.equal(adapter.isStopped!(), true, 'isStopped() true after cancel cleanup');
});

test('recovery deadline (15s) expires with FAILURE, and normal movement (>=5s, >=6 blocks) clears recovery', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });

  const nav = createNavigation(bot as any, undefined, { clock: { now: () => currentTime } });
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

  // Enter recovery on stall
  currentTime += 1500;
  adapter.update!(ctx);
  const taskState = nav.getTaskState()!;
  assert.equal(taskState.recoveryActive, true);

  // Subcase A: Normal movement succeeds: moves >= 6 blocks over >= 5000ms
  for (let i = 1; i <= 6; i++) {
    currentTime += 1000;
    bot.entity.position = new Vec3(i + 1, 64, 0);
    adapter.update!(ctx);
  }

  assert.equal(taskState.recoveryActive, false, 'Recovery successfully cleared after >=5s and >=6 blocks net move');

  // Subcase B: Stall again and exceed 15s deadline
  currentTime += 1500;
  adapter.update!(ctx);
  assert.equal(taskState.recoveryActive, true);

  currentTime += 16000; // Past 15000ms deadline
  const failResult = adapter.update!(ctx);
  assert.equal(failResult?.status, 'FAILURE');
  assert.match(failResult?.reason ?? '', /Path obstructed/);

  adapter.cancel!();
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

test('wall obstruction triggers detour waypoint, mid-route probe restores goal early when channel clears', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  // Wall blocks straight path at x=2, spanning z=-2 to z=+2
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
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: { missionId: 'm1' },
  };
  const ctx: ActionContext = {
    request: req, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true, getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(req);
  adapter.start(ctx);

  // Fast forward past 3 micro-unstuck attempts
  const taskState = nav.getTaskState()!;
  taskState.microUnstuckAttempts = 3;
  taskState.microUnstuckDone = true;

  // Stall: triggers Detour Waypoint Attempt 1
  currentTime += 1500;
  adapter.update!(ctx);

  assert.equal(taskState.waypointAttempts, 1, 'Waypoint attempt 1 consumed immediately');
  assert.ok(taskState.activeWaypoint, 'Active waypoint set');
  assert.equal(taskState.activeWaypoint!.z, -6, 'Chose left waypoint at z = -6');
  assert.equal(taskState.waypointPhase, 'navigating');

  // Bot moves towards waypoint: net displacement 3 blocks (0, 64, -3), channel still blocked
  currentTime += 600;
  bot.entity.position = new Vec3(0, 64, -3);
  adapter.update!(ctx);
  assert.equal(taskState.waypointPhase, 'navigating', 'Still navigating to waypoint as channel is blocked');

  // Bot navigates around the wall corner to (4, 64, -4)
  // Channel towards target (10, 64, 0) is now open: provide ground at steps
  bot.entity.position = new Vec3(4, 64, -4);
  for (let step = 1; step <= 3; step++) {
    const px = Math.round(4 + ((10 - 4) / Math.hypot(6, 4)) * step);
    const pz = Math.round(-4 + ((0 - (-4)) / Math.hypot(6, 4)) * step);
    bot.setBlock(px, 63, pz, { name: 'stone', boundingBox: 'block' });
  }

  // Next update >= 500ms later: mid-route probe detects open channel and restores original goal
  currentTime += 600;
  const goalsBeforeProbe = bot.goalsSet.length;
  adapter.update!(ctx);

  assert.equal(taskState.activeWaypoint, null, 'Active waypoint cleared on channel open');
  assert.equal(taskState.waypointPhase, 'none', 'Waypoint phase reset');
  assert.equal(bot.goalsSet.length, goalsBeforeProbe + 1, 'Original goal restored');

  adapter.cancel!();
});

test('detour waypoints exhaust after 3 attempts, reporting FAILURE and transitioning intent to STAY', () => {
  let currentTime = 1000;
  let failedReason: string | null = null;
  let failedMission: string | null = null;

  const bot = new FakeRecoveryBot();
  bot.setBlock(0, 63, 0, { name: 'stone', boundingBox: 'block' });
  // Ground for left candidate (0, 64, -6) and right candidate (0, 64, 6)
  bot.setBlock(0, 63, -6, { name: 'stone', boundingBox: 'block' });
  bot.setBlock(0, 63, 6, { name: 'stone', boundingBox: 'block' });

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

  const taskState = nav.getTaskState()!;
  taskState.microUnstuckAttempts = 3;
  taskState.microUnstuckDone = true;

  // Waypoint Attempt 1
  currentTime += 1500;
  adapter.update!(ctx);
  assert.equal(taskState.waypointAttempts, 1);
  assert.equal(taskState.activeWaypoint?.z, -6);

  // Stall heading to Waypoint 1 -> clears waypoint, triggers Waypoint Attempt 2
  currentTime += 800;
  adapter.update!(ctx);
  assert.equal(taskState.waypointAttempts, 2);
  assert.equal(taskState.activeWaypoint?.z, 6, 'Attempt 2 selects right waypoint (skipping left)');

  // Stall heading to Waypoint 2 -> clears waypoint, triggers Waypoint Attempt 3 (no new candidate)
  currentTime += 800;
  const result = adapter.update!(ctx);
  assert.equal(taskState.waypointAttempts, 3);
  assert.equal(result?.status, 'FAILURE', 'Exhausted detour waypoints reports FAILURE');
  assert.match(result?.reason ?? '', /Path obstructed/);
  assert.equal(failedMission, 'm1');
  assert.match(failedReason ?? '', /Path obstructed/);

  adapter.cancel!();
});
