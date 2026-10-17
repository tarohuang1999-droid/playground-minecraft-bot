import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { goals, pathfinder } from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import {
  NavigationExecutionBoundary,
  createNavigationTaskState,
  setupMovements,
  getDoorClearCenter,
  sanitizeDoorWaypoints,
  type NavigationRunContext,
} from '../../src/actions/navigation.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import type { ActionRequest } from '../../src/execution/types.ts';
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

  const block = (name: string, type: number) => ({ name, type }) as any;

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
    dig: async (_b: any) => {
      serverDigs++;
    },
    placeBlock: async (_ref: any, _face: any) => {
      serverPlaces++;
    },
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
  await assert.rejects(() => fakeBot.dig({ name: 'diamond_ore' }), /not in dig whitelist/);
  assert.equal(serverDigs, 1);
  assert.equal(taskState.digQuota, 2); // Quota was not deducted because check failed before dispatch

  // 3. Complete remaining 2 digs
  await fakeBot.dig({ name: 'cobblestone' });
  await fakeBot.dig({ name: 'sand' });
  assert.equal(serverDigs, 3);
  assert.equal(taskState.digQuota, 0);

  // 4. 4th dig rejected due to quota exhausted
  await assert.rejects(() => fakeBot.dig({ name: 'dirt' }), /dig quota exhausted/);
  assert.equal(serverDigs, 3);

  // 5. Place blocks: 3 allowed, 4th rejected
  await fakeBot.placeBlock({}, {});
  await fakeBot.placeBlock({}, {});
  await fakeBot.placeBlock({}, {});
  assert.equal(serverPlaces, 3);
  assert.equal(taskState.placeQuota, 0);

  await assert.rejects(() => fakeBot.placeBlock({}, {}), /place quota exhausted/);
  assert.equal(serverPlaces, 3);

  // 6. Non-whitelisted placed item rejected
  taskState.placeQuota = 1;
  fakeBot.heldItem = { name: 'diamond_block' };
  await assert.rejects(() => fakeBot.placeBlock({}, {}), /not in place whitelist/);
  assert.equal(serverPlaces, 3);

  boundary.uninstall(fakeBot);
});

test('NavigationExecutionBoundary: rejects inactive navigation context and passes through when null (RULE-11)', async () => {
  const boundary = new NavigationExecutionBoundary();
  let serverDigs = 0;
  let serverPlaces = 0;

  const fakeBot: any = {
    dig: async (_b: any) => {
      serverDigs++;
    },
    placeBlock: async (_ref: any, _face: any) => {
      serverPlaces++;
    },
    heldItem: { name: 'wheat_seeds' },
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

  // 1. Simulate delayed callback when run context is no longer active
  active = false;
  await assert.rejects(() => fakeBot.dig({ name: 'dirt' }), /navigation run is not active/);
  assert.equal(serverDigs, 0);

  await assert.rejects(() => fakeBot.placeBlock({}, {}), /navigation run is not active/);
  assert.equal(serverPlaces, 0);

  // 2. When activeContext is null (non-navigation action like FarmPlant), pass through to original methods
  boundary.setActiveContext(null);
  await fakeBot.placeBlock({}, {});
  assert.equal(serverPlaces, 1);

  boundary.uninstall(fakeBot);
});

test('Executor: cancellation confirmation holds locks until isStopped() is true', () => {
  let isStoppedVal = false;
  let cancelled = false;

  const arbiter = createArbiter();
  const executor = createExecutor(arbiter, {
    NormalFollow: () => ({
      start() {},
      cancel() {
        cancelled = true;
      },
      isStopped: () => isStoppedVal,
    }),
  });

  const snapshot = createBlackboard('owner').snapshot(0);
  const req1: ActionRequest = {
    nodeId: 'n1',
    runId: 'run-1',
    actionType: 'NormalFollow',
    targetId: null,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
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
    nodeId: 'n1',
    runId: 'run-1',
    actionType: 'NormalFollow',
    targetId: null,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
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

test('Movements: getMoveDiagonal prohibits diagonal moves when either orthogonal side is obstructed (corner clearance)', () => {
  const bot = createMockBot();
  const movements = setupMovements(bot, undefined, { canDig: false, allowBridge: false });
  assert.ok(movements);

  const worldMap = new Map<string, any>();
  const setBlock = (x: number, y: number, z: number, b: any) => {
    worldMap.set(`${x},${y},${z}`, {
      position: new Vec3(x, y, z),
      shapes: b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [],
      ...b,
    });
  };

  bot.blockAt = (p: any) => {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    return (
      worldMap.get(key) ?? {
        name: 'air',
        type: 0,
        boundingBox: 'empty',
        shapes: [],
        position: p,
      }
    );
  };

  // Node at (0, 64, 0). Ground at y=63.
  const node: any = { x: 0, y: 64, z: 0, remainingBlocks: 0 };
  const stone = { name: 'stone', type: mcData.blocksByName.stone.id, boundingBox: 'block' };

  // Ground under origin, destination (1, 63, 1), side 1 (0, 63, 1), and side 2 (1, 63, 0)
  setBlock(0, 63, 0, stone);
  setBlock(1, 63, 1, stone);
  setBlock(0, 63, 1, stone);
  setBlock(1, 63, 0, stone);

  // Scenario 1: Side 1 (0, 64, 1) has a solid block (corner obstacle)
  setBlock(0, 64, 1, stone);
  const neighbors1: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, neighbors1);
  assert.equal(neighbors1.length, 0, 'Must not generate diagonal move when Side 1 is blocked');

  // Scenario 2: Side 1 is clear, but Side 2 (1, 64, 0) is blocked
  worldMap.delete('0,64,1');
  setBlock(1, 64, 0, stone);
  const neighbors2: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, neighbors2);
  assert.equal(neighbors2.length, 0, 'Must not generate diagonal move when Side 2 is blocked');

  // Scenario 3: Both orthogonal sides are completely clear air
  worldMap.delete('1,64,0');
  const neighbors3: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, neighbors3);
  assert.equal(
    neighbors3.length,
    1,
    'Should generate diagonal move when both orthogonal sides have turning clearance'
  );
  assert.equal(neighbors3[0].x, 1);
  assert.equal(neighbors3[0].y, 64);
  assert.equal(neighbors3[0].z, 1);
});

test('Movements: getMoveDiagonal prohibits diagonal moves when any adjacent, origin, or target block is a door', () => {
  const bot = createMockBot();
  const movements = setupMovements(bot, undefined, { canDig: false, allowBridge: false });
  assert.ok(movements);

  const worldMap = new Map<string, any>();
  const setBlock = (x: number, y: number, z: number, b: any) => {
    worldMap.set(`${x},${y},${z}`, {
      position: new Vec3(x, y, z),
      shapes: b.boundingBox === 'block' ? (b.shapes ?? [[0, 0, 0, 1, 1, 1]]) : [],
      ...b,
    });
  };

  bot.blockAt = (p: any) => {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    return (
      worldMap.get(key) ?? {
        name: 'air',
        type: 0,
        boundingBox: 'empty',
        shapes: [],
        position: p,
      }
    );
  };

  const node: any = { x: 0, y: 64, z: 0, remainingBlocks: 0 };
  const stone = { name: 'stone', type: mcData.blocksByName.stone.id, boundingBox: 'block' };
  const openDoor = {
    name: 'oak_door',
    type: mcData.blocksByName.oak_door.id,
    boundingBox: 'block',
    shapes: [[0, 0, 0, 0.1875, 1, 1]],
    _properties: { open: true },
  };

  // Base ground safe
  setBlock(0, 63, 0, stone);
  setBlock(1, 63, 1, stone);
  setBlock(0, 63, 1, stone);
  setBlock(1, 63, 0, stone);

  // 1. Side 1 is an open door: must prohibit diagonal move (door occupies lateral space)
  setBlock(0, 64, 1, openDoor);
  const res1: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, res1);
  assert.equal(res1.length, 0, 'Must prohibit diagonal move when Side 1 has a door');

  // 2. Side 2 is an open door
  worldMap.delete('0,64,1');
  setBlock(1, 64, 0, openDoor);
  const res2: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, res2);
  assert.equal(res2.length, 0, 'Must prohibit diagonal move when Side 2 has a door');

  // 3. Destination is a door: cannot enter doorway diagonally
  worldMap.delete('1,64,0');
  setBlock(1, 64, 1, openDoor);
  const res3: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, res3);
  assert.equal(res3.length, 0, 'Must prohibit diagonal move when destination is a door');

  // 4. Origin is a door: cannot exit doorway diagonally
  worldMap.delete('1,64,1');
  setBlock(0, 64, 0, openDoor);
  const res4: any[] = [];
  movements.getMoveDiagonal(node, { x: 1, z: 1 } as any, res4);
  assert.equal(res4.length, 0, 'Must prohibit diagonal move when origin is a door');
});

test('Door clearance: getDoorClearCenter shifts body target away from open door leaf into passage center', () => {
  // Leaf along negative X (0 .. 0.1875) -> clear center x: (0.1875 + 1.0)/2 = 0.59375
  const doorNegX = { shapes: [[0, 0, 0, 0.1875, 1, 1]] };
  const cNegX = getDoorClearCenter(doorNegX);
  assert.equal(cNegX.offsetX, 0.59375);
  assert.equal(cNegX.offsetZ, 0.5);

  // Leaf along positive X (0.8125 .. 1.0) -> clear center x: 0.8125/2 = 0.40625
  const doorPosX = { shapes: [[0.8125, 0, 0, 1.0, 1, 1]] };
  const cPosX = getDoorClearCenter(doorPosX);
  assert.equal(cPosX.offsetX, 0.40625);
  assert.equal(cPosX.offsetZ, 0.5);

  // Leaf along negative Z (0 .. 0.1875) -> clear center z: 0.59375
  const doorNegZ = { shapes: [[0, 0, 0, 1, 1, 0.1875]] };
  const cNegZ = getDoorClearCenter(doorNegZ);
  assert.equal(cNegZ.offsetX, 0.5);
  assert.equal(cNegZ.offsetZ, 0.59375);

  // Leaf along positive Z (0.8125 .. 1.0) -> clear center z: 0.40625
  const doorPosZ = { shapes: [[0, 0, 0.8125, 1, 1, 1.0]] };
  const cPosZ = getDoorClearCenter(doorPosZ);
  assert.equal(cPosZ.offsetX, 0.5);
  assert.equal(cPosZ.offsetZ, 0.40625);
});

test('Door waypoints: sanitizeDoorWaypoints repositions corrupted door waypoints to floor and passage center', () => {
  const bot = createMockBot();
  const openDoor = {
    name: 'oak_door',
    type: mcData.blocksByName.oak_door.id,
    boundingBox: 'block',
    shapes: [[0, 0, 0, 0.1875, 1, 1]],
    position: new Vec3(10, 64, 20),
  };

  bot.blockAt = (p: any) => {
    if (
      Math.floor(p.x) === 10 &&
      (Math.floor(p.y) === 64 || Math.floor(p.y) === 65) &&
      Math.floor(p.z) === 20
    ) {
      return openDoor;
    }
    return { name: 'air', boundingBox: 'empty', shapes: [], position: p };
  };

  // Simulate pathfinder output where door waypoint was elevated to y=65 and shifted towards door leaf (x=10.296875)
  const path = [
    { x: 10.5, y: 64, z: 19.5 },
    { x: 10.296875, y: 65, z: 20.5 },
    { x: 10.5, y: 64, z: 21.5 },
  ];

  sanitizeDoorWaypoints(bot, path);

  // Door waypoint at index 1 is corrected: y=64 (ground level) and x=10.59375 (center of open passage)
  assert.equal(path[1]!.y, 64);
  assert.equal(path[1]!.x, 10.59375);
  assert.equal(path[1]!.z, 20.5);
});
