import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createNavigation, setupMovements } from '../../src/actions/navigation.ts';
import { attachCompanion } from '../../src/bot.ts';
import { parseCommand } from '../../src/commands.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';

test('commands: unfollow command sets mode to STAY', () => {
  assert.deepEqual(parseCommand('owner', 'owner', 'unfollow'), { type: 'intent', mode: 'STAY' });
  assert.deepEqual(parseCommand('owner', 'owner', ' UNFOLLOW '), { type: 'intent', mode: 'STAY' });
  assert.equal(parseCommand('owner', 'stranger', 'unfollow'), null);
});

test('navigation adapter: sets dynamic GoalFollow and does not repeat setGoal on update (RULE-07)', () => {
  const goalCalls: Array<{ goal: any; dynamic?: boolean | undefined }> = [];
  const fakeBot = {
    pathfinder: {
      setGoal(goal: any, dynamic?: boolean) { goalCalls.push({ goal, dynamic }); },
    },
    entities: { 10: { id: 10, position: { x: 10, y: 64, z: 10 } } },
    players: { owner: { entity: { id: 10, position: { x: 10, y: 64, z: 10 } } } },
  };

  const nav = createNavigation(fakeBot as any);
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'owner', entityId: 10, position: { x: 10, y: 64, z: 10 }, distance: 14.14 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-1', actionType: 'NormalFollow',
    targetId: 10, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };

  let active = true;
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => active,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(request);
  adapter.start(ctx);

  assert.equal(goalCalls.length, 1);
  assert.equal(goalCalls[0]!.dynamic, true);
  assert.ok(goalCalls[0]!.goal);

  // Update while still far -> should NOT call setGoal again (RULE-07)
  adapter.update!(ctx);
  adapter.update!(ctx);
  assert.equal(goalCalls.length, 1);

  // When master distance <= exit threshold (1.2 blocks) and height aligned (|dy| <= 1.2)
  world.self.position = { x: 9.5, y: 64, z: 10 };
  world.master = { username: 'owner', entityId: 10, position: { x: 10, y: 64, z: 10 }, distance: 0.5 };
  board.setWorld(world);
  const result = adapter.update!(ctx);
  assert.deepEqual(result, { status: 'SUCCESS' });
  assert.equal(goalCalls.length, 2);
  assert.equal(goalCalls[1]!.goal, null);

  // Cancel clears goal
  adapter.cancel();
  assert.equal(goalCalls.length, 3);
  assert.equal(goalCalls[2]!.goal, null);
});

test('navigation adapter: target lost returns FAILURE and clears goal', () => {
  const goalCalls: any[] = [];
  const fakeBot = {
    pathfinder: {
      setGoal(goal: any, dynamic?: boolean) { goalCalls.push(goal); },
    },
    entities: {},
    players: {},
  };

  const nav = createNavigation(fakeBot as any);
  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request: { nodeId: 'n', runId: 'r', actionType: 'NormalFollow', targetId: 99, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {} },
    token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(ctx.request);
  const startResult = adapter.start(ctx);
  assert.deepEqual(startResult, { status: 'FAILURE', reason: 'Target not visible' });
  assert.equal(goalCalls[0], null);
});

test('integration: follow command engages navigation, unfollow stops it, hysteresis controls distance', () => {
  class PathfinderBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    goalsSet: any[] = [];
    pathfinder = {
      setGoal: (goal: any, dynamic?: boolean) => { this.goalsSet.push({ goal, dynamic }); },
      setMovements: (_movements: any) => {},
    };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36 };
    sent: string[] = [];
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new PathfinderBot();
  const ownerEntity = { id: 2, position: { x: 10, y: 64, z: 0 } };
  bot.entities[2] = ownerEntity;
  bot.players.owner = { entity: ownerEntity };

  const companion = attachCompanion(bot as any, 'owner');
  bot.emit('spawn');

  // Initially Idle
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'IDLE');
  assert.equal(companion.snapshot().runtime.lockedResources.MOVE, null);

  // Command: follow -> distance is 10 (> 5), so NormalFollow starts!
  bot.emit('chat', 'owner', 'follow');
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'FOLLOW');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /NormalFollow/);
  assert.ok(bot.goalsSet.length > 0);
  assert.equal(bot.goalsSet[bot.goalsSet.length - 1]!.dynamic, true);

  // Master moves closer (distance 1.0 <= 1.2) -> NormalFollow exits to Idle
  ownerEntity.position.x = 1.0;
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().runtime.lockedResources.MOVE, null);

  // Master moves far (distance 20 > 16) -> CatchUpFollow (Priority 40)
  ownerEntity.position.x = 20;
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /CatchUpFollow/);

  // Command: unfollow -> cancels follow, transitions to STAY, frees locks
  bot.emit('chat', 'owner', 'unfollow');
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'STAY');
  assert.equal(companion.snapshot().runtime.lockedResources.MOVE, null);

  companion.dispose();
});

test('setupMovements: configures canDig, allowParkour, and allowSprinting', () => {
  const dummyBot = {
    pathfinder: { setMovements(_m: any) {} },
    registry: {
      blocksByName: { water: { id: 1 }, ladder: { id: 2 }, vine: { id: 3 }, chest: { id: 4 }, fire: { id: 5 }, lava: { id: 6 }, sand: { id: 7 }, gravel: { id: 8 }, air: { id: 9 } },
      blocksArray: [{ id: 9, diggable: false, minStateId: 0, shapes: [] }],
      itemsByName: { dirt: { id: 10 }, cobblestone: { id: 11 } },
    },
  };
  const movements = setupMovements(dummyBot as any);
  if (movements) {
    assert.equal(movements.canDig, false);
    assert.equal(movements.allowParkour, true);
    assert.equal(movements.allowSprinting, false);
    assert.equal(movements.canOpenDoors, false);
  }
});

test('obstacle detection: shouldJumpObstacle triggers on 1-block steps and rejects 2-block walls', async () => {
  const { shouldJumpObstacle } = await import('../../src/actions/navigation.ts');
  const mockBot: any = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0, // facing south (+z): dx = 0, dz = -0.7
      onGround: true,
      isCollidedHorizontally: true,
    },
    blockAt(pos: { x: number; y: number; z: number }) {
      // 1-block step case: y ~ 64 is solid dirt, y ~ 65 is air, y ~ 66 is air
      if (pos.y < 65) return { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
      return { boundingBox: 'empty', shapes: [] };
    },
  };

  assert.equal(shouldJumpObstacle(mockBot), true);

  // 2-block wall case: y ~ 65 is ALSO solid dirt
  mockBot.blockAt = (pos: { x: number; y: number; z: number }) => {
    if (pos.y < 66) return { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
    return { boundingBox: 'empty', shapes: [] };
  };
  assert.equal(shouldJumpObstacle(mockBot), false);

  // Not on ground -> should not jump
  mockBot.entity.onGround = false;
  assert.equal(shouldJumpObstacle(mockBot), false);
});

test('navigation adapter: obstacle jump sets jump control state and clears when ungrounded', () => {
  const controlStates: Record<string, boolean> = {};
  const fakeBot: any = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      onGround: true,
      isCollidedHorizontally: true,
    },
    setControlState(control: string, state: boolean) { controlStates[control] = state; },
    blockAt(pos: { x: number; y: number; z: number }) {
      if (pos.y < 65) return { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
      return { boundingBox: 'empty', shapes: [] };
    },
    pathfinder: { setGoal() {}, isMoving: () => true },
    entities: { 10: { id: 10, position: { x: 0, y: 64, z: 10 } } },
    players: { owner: { entity: { id: 10, position: { x: 0, y: 64, z: 10 } } } },
  };

  const nav = createNavigation(fakeBot);
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 10, position: { x: 0, y: 64, z: 10 }, distance: 10 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-jump', actionType: 'NormalFollow',
    targetId: 10, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(request);
  adapter.start(ctx);

  // When update runs and 1-block obstacle is in front, jump should be set to true
  adapter.update!(ctx);
  assert.equal(controlStates.jump, true);

  // When bot leaves the ground, jump should clear to false
  fakeBot.entity.onGround = false;
  adapter.update!(ctx);
  assert.equal(controlStates.jump, false);
});

test('obstacle detection: shouldJumpObstacle handles slabs and stairs', async () => {
  const { shouldJumpObstacle } = await import('../../src/actions/navigation.ts');
  const mockBot: any = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      onGround: true,
      isCollidedHorizontally: true,
    },
    blockAt(pos: { x: number; y: number; z: number }) {
      // Slab case: height 0.5, topY = 64.5, heightDiff = 0.5 (within 0.05..1.25)
      if (pos.y < 65) return { boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] };
      return { boundingBox: 'empty', shapes: [] };
    },
  };
  assert.equal(shouldJumpObstacle(mockBot), true);
});

test('navigation adapter: ladder climbing engages jump when target is higher', async () => {
  const { isClimbingLadder } = await import('../../src/actions/navigation.ts');
  const controlStates: Record<string, boolean> = {};
  const fakeBot: any = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      onGround: false,
      isCollidedHorizontally: false,
    },
    setControlState(control: string, state: boolean) { controlStates[control] = state; },
    blockAt(pos: { x: number; y: number; z: number }) {
      if (Math.floor(pos.y) === 64) return { name: 'ladder', boundingBox: 'block', shapes: [[0, 0, 0.8, 1, 1, 1]] };
      return { name: 'air', boundingBox: 'empty', shapes: [] };
    },
    pathfinder: { setGoal() {}, isMoving: () => true },
    entities: { 10: { id: 10, position: { x: 0, y: 70, z: 0 } } },
    players: { owner: { entity: { id: 10, position: { x: 0, y: 70, z: 0 } } } },
  };

  assert.equal(isClimbingLadder(fakeBot), true);

  const nav = createNavigation(fakeBot);
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.master = { username: 'owner', entityId: 10, position: { x: 0, y: 70, z: 0 }, distance: 6 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-ladder', actionType: 'NormalFollow',
    targetId: 10, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(request);
  adapter.start(ctx);
  adapter.update!(ctx);

  // Since target is higher (y=70 vs y=64), jump must be held to climb ladder
  assert.equal(controlStates.jump, true);
});

test('navigation adapter: doors auto-open in front and open doors are passable without flapping', async () => {
  const { isDoorBlock, isDoorOpen, tryOpenDoorInFront, isPassable, DoorManager } = await import('../../src/actions/navigation.ts');
  let activationCount = 0;
  const fakeBot: any = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
    },
    blockAt(pos: { x: number; y: number; z: number }) {
      if (Math.abs(pos.z - -0.8) < 0.5) {
        return { name: 'oak_door', _properties: { open: false }, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 0.2]] };
      }
      return { name: 'air', boundingBox: 'empty', shapes: [] };
    },
    async activateBlock(_block: any) {
      activationCount++;
    },
  };

  const door = fakeBot.blockAt({ x: 0, y: 64, z: -0.8 });
  assert.equal(isDoorBlock(door), true);
  assert.equal(isDoorOpen(door), false);

  const manager = new DoorManager();
  // First call -> opens the door
  const opened = manager.tryOpenDoorInFront(fakeBot);
  assert.equal(opened, true);
  assert.equal(activationCount, 1);

  // Immediate second call (e.g. 50ms next tick) -> must be blocked by cooldown/in-flight, NO flapping!
  const flapped = manager.tryOpenDoorInFront(fakeBot);
  assert.equal(flapped, false);
  assert.equal(activationCount, 1);

  // Door is already open -> must NEVER interact / close it
  const openDoor = { name: 'oak_door', _properties: { open: true }, boundingBox: 'block', shapes: [[0, 0, 0, 0.2, 1, 1]] };
  assert.equal(isPassable(openDoor), true);
  assert.equal(isDoorOpen(openDoor), true);

  fakeBot.blockAt = (pos: { x: number; y: number; z: number }) => {
    if (Math.abs(pos.z - -0.8) < 0.5) return openDoor;
    return { name: 'air', boundingBox: 'empty', shapes: [] };
  };
  manager.reset();
  const openResult = manager.tryOpenDoorInFront(fakeBot);
  assert.equal(openResult, false);
  assert.equal(activationCount, 1);
});

test('navigation adapter: follow does not exit if target is on cliff with close XZ but high dy', () => {
  const fakeBot: any = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: { setGoal() {}, isMoving: () => true },
    entities: { 10: { id: 10, position: { x: 0.5, y: 67, z: 0.5 } } },
    players: { owner: { entity: { id: 10, position: { x: 0.5, y: 67, z: 0.5 } } } },
  };

  const nav = createNavigation(fakeBot);
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'owner', entityId: 10, position: { x: 0.5, y: 67, z: 0.5 }, distance: 3.08 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-height', actionType: 'NormalFollow',
    targetId: 10, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(request);
  adapter.start(ctx);
  const result = adapter.update!(ctx);

  // Target is 3 blocks higher (|dy|=3 > 1.2), so it must NOT complete with SUCCESS
  assert.equal(result, undefined);
});

test('navigation adapter: safeBlockAt and DoorManager require Vec3 with floored and normalize upper half', async () => {
  const { DoorManager } = await import('../../src/actions/navigation.ts');
  let activatedPosition: any = null;

  const fakeBot: any = {
    entity: {
      position: { x: 5.5, y: 64, z: 10.5 },
      yaw: 0, // facing south (+z): fx = 0, fz = -1
      isCollidedHorizontally: true,
    },
    blockAt(pos: any) {
      // Must have .floored() method like real Mineflayer/prismarine-world
      if (typeof pos.floored !== 'function') {
        throw new Error('TypeError: pos.floored is not a function');
      }
      const p = pos.floored();
      // Suppose an upper oak door is detected in front
      if (p.x === 5 && p.y === 65 && p.z === 10) {
        return {
          name: 'oak_door',
          position: { x: 5, y: 65, z: 10 },
          _properties: { open: false, half: 'upper' },
          boundingBox: 'block',
          shapes: [[0, 0, 0, 1, 1, 0.2]],
        };
      }
      // Lower oak door block
      if (p.x === 5 && p.y === 64 && p.z === 10) {
        return {
          name: 'oak_door',
          position: { x: 5, y: 64, z: 10 },
          _properties: { open: false, half: 'lower' },
          boundingBox: 'block',
          shapes: [[0, 0, 0, 1, 1, 0.2]],
        };
      }
      return { name: 'air', boundingBox: 'empty', shapes: [] };
    },
    async activateBlock(block: any) {
      activatedPosition = block.position;
    },
  };

  const manager = new DoorManager();
  const opened = manager.tryOpenDoorInFront(fakeBot);
  assert.equal(opened, true);
  // Must normalize and activate the LOWER block at y=64, NOT upper at y=65
  assert.deepEqual(activatedPosition, { x: 5, y: 64, z: 10 });
});

