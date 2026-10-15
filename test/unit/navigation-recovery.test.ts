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

test('micro-unstuck triggers on 1500ms stall, executes for exactly 500ms, and restores Goal', () => {
  let currentTime = 1000;
  const bot = new FakeRecoveryBot();
  // Setup safe terrain around bot at (0, 64, 0)
  // yaw = 0 -> facing south (+z). left is east (+x), right is west (-x)
  // Left target at (0.5, 64, 0): support at (0, 63, 0)
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

  // Stationary for 1500ms
  currentTime += 1500;
  adapter.update!(ctx);

  const taskState = nav.getTaskState()!;
  assert.equal(taskState.recoveryActive, true, 'Recovery must activate upon 1500ms stall');
  assert.equal(taskState.microUnstuckDone, true, 'Micro-unstuck marked done');
  assert.equal(taskState.microUnstuckActive, true, 'Micro-unstuck currently active');
  assert.equal(bot.stopsCalled, 1, 'Pathfinder must be stopped before manual control');
  assert.equal(bot.controlStates.left, true, 'Left lateral control engaged');

  // Step while micro-unstuck is in-flight (200ms elapsed < 500ms)
  currentTime += 200;
  adapter.update!(ctx);
  assert.equal(taskState.microUnstuckActive, true);
  assert.equal(bot.controlStates.left, true);

  // 500ms elapsed: micro-unstuck completes
  currentTime += 300;
  const goalsBeforeFinish = bot.goalsSet.length;
  adapter.update!(ctx);

  assert.equal(taskState.microUnstuckActive, false, 'Micro-unstuck finished after 500ms');
  assert.equal(bot.controlStates.left, false, 'Manual control state cleared');
  assert.equal(bot.goalsSet.length, goalsBeforeFinish + 1, 'Original goal restored once to pathfinder');

  // Stalling again does NOT repeat micro-unstuck within the same recovery session
  currentTime += 1600;
  adapter.update!(ctx);
  assert.equal(bot.controlStates.left, false, 'Micro-unstuck must run at most 1 time per recovery');

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
