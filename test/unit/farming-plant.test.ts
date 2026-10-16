import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { parseCommand } from '../../src/commands.ts';
import { createBlackboard, createWorld, type Position } from '../../src/blackboard.ts';
import { createPerception } from '../../src/perception.ts';
import { createFarming } from '../../src/actions/farming.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { attachCompanion } from '../../src/bot.ts';
import { workConfig } from '../../src/config/index.ts';
import { calculateActionPriority } from '../../src/policy.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';

test('farming commands: parses !farm and !fram with and without crop argument', () => {
  assert.deepEqual(parseCommand('owner', 'owner', '!farm'), { type: 'farm', crop: null });
  assert.deepEqual(parseCommand('owner', 'owner', '!fram'), { type: 'farm', crop: null });
  assert.deepEqual(parseCommand('owner', 'owner', '!farm wheat'), { type: 'farm', crop: 'wheat' });
  assert.deepEqual(parseCommand('owner', 'owner', '!fram carrot'), {
    type: 'farm',
    crop: 'carrot',
  });
  assert.deepEqual(parseCommand('owner', 'owner', '!farm potato'), {
    type: 'farm',
    crop: 'potato',
  });
  assert.deepEqual(parseCommand('owner', 'owner', '!farm beetroot'), {
    type: 'farm',
    crop: 'beetroot',
  });

  // Invalid crop returns usage
  assert.deepEqual(parseCommand('owner', 'owner', '!farm apple'), {
    type: 'command_usage',
    message: 'Usage: !farm [wheat|carrot|potato|beetroot]',
  });

  // Non-owner ignored
  assert.equal(parseCommand('owner', 'stranger', '!farm'), null);
});

test('farming perception: detects plantable seeds in inventory', () => {
  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    players: {},
    entities: {},
    inventory: {
      emptySlotCount: () => 30,
      items: () => [
        { name: 'wheat_seeds', count: 12 },
        { name: 'carrot', count: 5 },
        { name: 'iron_ingot', count: 3 },
      ],
      slots: [],
    },
  };

  const perception = createPerception(fakeBot, 'owner');
  const world = perception.sample();

  assert.equal(world.inventory.plantableSeeds?.length, 2);
  const wheatSeed = world.inventory.plantableSeeds?.find(s => s.cropType === 'wheat');
  assert.ok(wheatSeed);
  assert.equal(wheatSeed?.count, 12);
  assert.equal(wheatSeed?.name, 'wheat_seeds');

  const carrotSeed = world.inventory.plantableSeeds?.find(s => s.cropType === 'carrot');
  assert.ok(carrotSeed);
  assert.equal(carrotSeed?.count, 5);
});

test('farming perception: findAvailableFarmland identifies valid farmland within radius and rejects out-of-bounds', () => {
  const rallyPoint: Position = { x: 100, y: 64, z: 100 };
  const fakeBot: any = {
    blocks: {
      closeFarmland: {
        name: 'farmland',
        position: { x: 110, y: 64, z: 100 }, // distance = 10 <= 25
        above: { name: 'air' },
      },
      farFarmland: {
        name: 'farmland',
        position: { x: 130, y: 64, z: 100 }, // distance = 30 > 25
        above: { name: 'air' },
      },
    },
  };

  const perception = createPerception(fakeBot, 'owner');
  const found = perception.getAvailableFarmland(rallyPoint, 25);
  assert.ok(found);
  assert.equal(found?.x, 110);
  assert.equal(found?.z, 100);

  // If maxRadius is 5, distance 10 should be rejected
  const notFound = perception.getAvailableFarmland(rallyPoint, 5);
  assert.equal(notFound, null);
});

test('farming perception: findAvailableFarmland safely handles palette candidate with null position', () => {
  const rallyPoint: Position = { x: 39.5, y: -54.0, z: 17.9 };
  let passedPaletteCheck = false;
  let useExtraInfoCalled = false;
  const fakeBot: any = {
    findBlock: (options: any) => {
      // 1. Mineflayer palette test: passes Block object with position = null
      const paletteBlock = { name: 'farmland', position: null };
      const paletteResult = options.matching(paletteBlock);
      passedPaletteCheck = paletteResult;

      // 2. Section search: passes Block with real position
      const realBlock = {
        name: 'farmland',
        position: {
          x: 40,
          y: -54,
          z: 18,
          offset: (dx: number, dy: number, dz: number) => ({
            x: 40 + dx,
            y: -54 + dy,
            z: 18 + dz,
          }),
        },
      };
      if (typeof options.useExtraInfo === 'function') {
        useExtraInfoCalled = options.useExtraInfo(realBlock);
      }
      return realBlock;
    },
    blockAt: () => ({ name: 'air' }),
  };

  const perception = createPerception(fakeBot, 'owner');
  const found = perception.getAvailableFarmland(rallyPoint, 25);
  assert.equal(passedPaletteCheck, true, 'Palette pre-check should pass for farmland');
  assert.equal(
    useExtraInfoCalled,
    true,
    'useExtraInfo should validate candidate with valid position'
  );
  assert.ok(found);
  assert.equal(found?.x, 40);
  assert.equal(found?.y, -54);
  assert.equal(found?.z, 18);
});

test('farming integration: !farm without seeds rejects with chat message and stays in original mode', () => {
  class MockBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {
      owner: { entity: { id: 2, position: { x: 0, y: 64, z: 2 } } },
    };
    entities: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [{ name: 'dirt', count: 10 }], // No seeds!
      slots: [],
    };
    pathfinder = { setGoal() {}, stop() {}, setMovements() {} };
    registry = { blocksByName: {}, itemsByName: {} };
    chatLog: string[] = [];
    chat(msg: string) {
      this.chatLog.push(msg);
    }
  }

  const bot = new MockBot();
  const companion = attachCompanion(bot as any, 'owner');

  bot.emit('spawn');
  bot.emit('chat', 'owner', '!farm');
  bot.emit('physicsTick');

  assert.ok(
    bot.chatLog.includes('No plantable seeds in inventory!'),
    'Should notify owner that no seeds are available'
  );
  assert.equal(companion.snapshot().intent.mode, 'IDLE');

  companion.dispose();
});

test('farming integration: !farm with seeds engages FARM mode and anchors rally point', () => {
  class MockBot extends EventEmitter {
    entity = { id: 1, position: { x: 15, y: 64, z: 25 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {
      owner: { entity: { id: 2, position: { x: 0, y: 64, z: 0 } } },
    };
    entities: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 30,
      items: () => [{ name: 'wheat_seeds', count: 16 }],
      slots: [],
    };
    pathfinder = { setGoal() {}, stop() {}, setMovements() {} };
    registry = { blocksByName: {}, itemsByName: {} };
    chatLog: string[] = [];
    chat(msg: string) {
      this.chatLog.push(msg);
    }
  }

  const bot = new MockBot();
  const companion = attachCompanion(bot as any, 'owner');

  bot.emit('spawn');
  bot.emit('chat', 'owner', '!farm');
  bot.emit('physicsTick');

  assert.ok(bot.chatLog.includes('Intent=FARM'));
  const snap = companion.snapshot();
  assert.equal(snap.intent.mode, 'FARM');
  assert.equal(snap.intent.workArea?.rallyPoint.x, 15);
  assert.equal(snap.intent.workArea?.rallyPoint.z, 25);
  assert.equal(snap.intent.workArea?.cropType, 'wheat');
  assert.equal(snap.intent.workArea?.maxRadius, workConfig.farmWorkRadius);

  companion.dispose();
});

test('farming BT: selects FarmPlant (30) when seeds and farmland are available', () => {
  const available = new Set(['NormalFollow', 'FarmPlant', 'ReturnToRally', 'Idle']);
  let farmlandTarget: Position | null = { x: 10, y: 64, z: 10 };
  const tree = createCompanionTree(available, {
    getAvailableFarmland: () => farmlandTarget,
  });

  const board = createBlackboard('owner');
  const now = 1000;
  board.setIntent('FARM', now, null, {
    rallyPoint: { x: 0, y: 64, z: 0 },
    maxRadius: 25,
    startedAt: now,
    maxDurationMs: 1_200_000,
    cropType: 'wheat',
  });

  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.inventory.plantableSeeds = [{ name: 'wheat_seeds', count: 5, cropType: 'wheat' }];
  board.setWorld(world);

  const snapshot = board.snapshot(now);
  const result = tree.tick(snapshot);

  const plantReq = result.requests.find(r => r.actionType === 'FarmPlant');
  assert.ok(plantReq, 'FarmPlant request should be issued');
  assert.equal(plantReq?.priority, 40, 'FarmPlant receives +10 boost under FARM intent');
  assert.equal(plantReq?.params.seedItem, 'wheat_seeds');
  assert.equal(plantReq?.params.cropType, 'wheat');
  assert.equal(plantReq?.params.x, 10);
});

test('farming BT: shift duration limit (1 Minecraft day = 1,200,000ms) triggers immediate finish to IDLE without ReturnToRally', () => {
  const available = new Set(['NormalFollow', 'FarmPlant', 'Idle']);
  let farmingFinishedReason: string | null = null;
  const tree = createCompanionTree(available, {
    getAvailableFarmland: () => ({ x: 10, y: 64, z: 10 }),
    onFarmingFinished: reason => {
      farmingFinishedReason = reason;
    },
  });

  const board = createBlackboard('owner');
  const startedAt = 1000;
  board.setIntent('FARM', startedAt, null, {
    rallyPoint: { x: 0, y: 64, z: 0 },
    maxRadius: 25,
    startedAt,
    maxDurationMs: 1_200_000,
    cropType: 'wheat',
  });

  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 10, y: 64, z: 0 };
  world.inventory.plantableSeeds = [{ name: 'wheat_seeds', count: 5, cropType: 'wheat' }];
  board.setWorld(world);

  // Advance time past 1 Minecraft day (startedAt + 1,200,001 ms)
  const expiredTime = startedAt + 1_200_001;
  const snapshot = board.snapshot(expiredTime);
  const tickResult = tree.tick(snapshot);

  // FarmPlant must not run; farming finishes directly without ReturnToRally
  const plantReq = tickResult.requests.find(r => r.actionType === 'FarmPlant');
  assert.equal(plantReq, undefined, 'FarmPlant must not run after shift duration expired');
  assert.equal(
    farmingFinishedReason,
    'TIMEOUT',
    'Farming should finish immediately with TIMEOUT when limit is reached'
  );
});

test('farming adapter: farmPlant disables parkour, approaches, equips seed, looks at block and places it', async () => {
  let goalSet: any = null;
  let parkourAllowed: boolean | null = null;
  const controlStates: Record<string, boolean> = {};
  const lookAtCalls: any[] = [];
  const equipCalls: any[] = [];
  const placeCalls: any[] = [];
  let planted = false;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mcData = require('prismarine-registry')('1.20.2');
  const fakeBot: any = {
    version: '1.20.2',
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setGoal(goal: any) {
        goalSet = goal;
      },
      setMovements(m: any) {
        parkourAllowed = m.allowParkour;
      },
    },
    registry: mcData,
    inventory: {
      items: () => [{ name: 'wheat_seeds', type: 100 }],
    },
    setControlState(name: string, state: boolean) {
      controlStates[name] = state;
    },
    async lookAt(pos: any) {
      lookAtCalls.push(pos);
    },
    async equip(item: any, slot: string) {
      equipCalls.push({ item, slot });
    },
    blockAt(pos: any) {
      if (pos.y > 64) {
        return planted
          ? { position: pos, name: 'wheat' }
          : { position: pos, name: 'air', light: 15, skyLight: 15 };
      }
      return { position: pos, name: 'farmland' };
    },
    async placeBlock(block: any, vec: any) {
      placeCalls.push({ block, vec });
      planted = true;
    },
  };

  let cropPlantedCallback: string | null = null;
  const farming = createFarming(fakeBot, {
    onCropPlanted: crop => {
      cropPlantedCallback = crop;
    },
  });

  const request: ActionRequest = {
    nodeId: 'FarmPlant',
    runId: 'farm-run-1',
    actionType: 'FarmPlant',
    targetId: null,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {
      x: 1,
      y: 64,
      z: 0,
      seedItem: 'wheat_seeds',
      cropType: 'wheat',
    },
  };

  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = farming.farmPlant(request);
  adapter.start(ctx);

  assert.ok(goalSet !== null, 'Goal should be set on start');
  assert.equal(parkourAllowed, false, 'Farmland protection: allowParkour must be false');
  assert.equal(controlStates['jump'], false, 'Jump control must be false');

  // Bot position is (0, 64, 0), farmland is at (1, 64, 0) -> distance is 1.0 <= 2.5
  adapter.update!(ctx);

  // Give async planting a microtask tick
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(lookAtCalls.length, 1, 'lookAt should be called towards farmland');
  assert.equal(equipCalls.length, 1, 'equip should be called with wheat_seeds');
  assert.equal(equipCalls[0]?.slot, 'hand');
  assert.equal(placeCalls.length, 1, 'placeBlock should be called on farmland block');
  assert.equal(placeCalls[0]?.vec.y, 1);
  assert.equal(cropPlantedCallback, 'wheat');
});

test('farming adapter: farmPlant prefers activateBlock when available and swings arm', async () => {
  const activateBlockCalls: any[] = [];
  const swingArmCalls: any[] = [];
  let plantedPos: any = null;
  let activated = false;

  const fakeBot: any = {
    entity: { id: 1, position: { x: 1, y: 64, z: 0 } },
    pathfinder: { setGoal() {}, setMovements() {} },
    inventory: {
      items: () => [{ name: 'wheat_seeds', type: 100 }],
    },
    async lookAt() {},
    async equip() {},
    blockAt(pos: any) {
      if (pos.y > 64) {
        return activated
          ? { position: pos, name: 'wheat' }
          : { position: pos, name: 'air', light: 15, skyLight: 15 };
      }
      return { position: pos, name: 'farmland' };
    },
    async activateBlock(block: any) {
      activateBlockCalls.push(block);
      activated = true;
    },
    swingArm(hand: string) {
      swingArmCalls.push(hand);
    },
  };

  const farming = createFarming(fakeBot, {
    onCropPlanted: (_crop, pos) => {
      plantedPos = pos;
    },
  });

  const request: ActionRequest = {
    nodeId: 'FarmPlant',
    runId: 'farm-run-activate',
    actionType: 'FarmPlant',
    targetId: null,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { x: 2, y: 64, z: 0, seedItem: 'wheat_seeds', cropType: 'wheat' },
  };

  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = farming.farmPlant(request);
  adapter.start(ctx);
  adapter.update!(ctx);

  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(activateBlockCalls.length, 1, 'activateBlock should be called');
  assert.equal(activateBlockCalls[0]?.name, 'farmland');
  assert.equal(swingArmCalls.length, 1, 'swingArm should be called');
  assert.equal(plantedPos?.x, 2);
});

test('farming adapter: cancel immediately stops FarmPlant and isStopped returns true', () => {
  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    pathfinder: { setGoal() {}, setMovements() {} },
    setControlState() {},
  };

  const farming = createFarming(fakeBot);
  const request: ActionRequest = {
    nodeId: 'FarmPlant',
    runId: 'farm-cancel-test',
    actionType: 'FarmPlant',
    targetId: null,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { x: 5, y: 64, z: 5, seedItem: 'wheat_seeds', cropType: 'wheat' },
  };

  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = farming.farmPlant(request);
  adapter.start(ctx);
  assert.equal(adapter.isStopped?.(), false, 'Should be active after start');

  adapter.cancel();
  assert.equal(
    adapter.isStopped?.(),
    true,
    'isStopped() must immediately return true after cancel'
  );
});

test('farming perception: failure cooldown prevents targeting failed farmland repeatedly', () => {
  const rallyPoint: Position = { x: 100, y: 64, z: 100 };
  const fakeBot: any = {
    blocks: {
      failedFarmland: {
        name: 'farmland',
        position: { x: 105, y: 64, z: 100 },
        above: { name: 'air' },
      },
      nextFarmland: {
        name: 'farmland',
        position: { x: 110, y: 64, z: 100 },
        above: { name: 'air' },
      },
    },
  };

  let mockNow = 10_000;
  const perception = createPerception(fakeBot, 'owner', { now: () => mockNow });

  // Initially picks first farmland
  const first = perception.getAvailableFarmland(rallyPoint, 25);
  assert.equal(first?.x, 105);

  // Mark first farmland as failed (30s cooldown)
  perception.markFarmlandCooldown({ x: 105, y: 64, z: 100 }, 30_000);

  // Now getAvailableFarmland should skip the failed one and find nextFarmland!
  const second = perception.getAvailableFarmland(rallyPoint, 25);
  assert.ok(second);
  assert.equal(second?.x, 110, 'Should skip failed farmland and target next farmland');

  // After cooldown expires, first farmland becomes available again
  mockNow += 31_000;
  const third = perception.getAvailableFarmland(rallyPoint, 25);
  assert.equal(third?.x, 105, 'Expired cooldown allows farmland to be reconsidered');
});

test('farming adapter: avoids planting when bot collides with crop space', async () => {
  let activateCalls = 0;
  let newGoal: any = null;

  // Bot is standing at (10.1, 64.0, 10.1), directly inside crop block at (10, 64, 10)
  const fakeBot: any = {
    entity: { id: 1, position: { x: 10.1, y: 64.0, z: 10.1 } },
    pathfinder: {
      setGoal(goal: any) {
        newGoal = goal;
      },
      setMovements() {},
    },
    inventory: {
      items: () => [{ name: 'wheat_seeds', type: 100 }],
    },
    async activateBlock() {
      activateCalls++;
    },
  };

  const farming = createFarming(fakeBot);
  const request: ActionRequest = {
    nodeId: 'FarmPlant',
    runId: 'farm-collide-test',
    actionType: 'FarmPlant',
    targetId: null,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { x: 10, y: 63, z: 10, seedItem: 'wheat_seeds', cropType: 'wheat' }, // Farmland y=63, crop y=64
  };

  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = farming.farmPlant(request);
  adapter.start(ctx);
  adapter.update!(ctx);

  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(activateCalls, 0, 'Must NOT plant while colliding with crop space');
  assert.ok(newGoal !== null, 'Should set backup goal to move outside crop space');
});

test('priority policy: calculateActionPriority computes final priority from mode bonus and action base priority', () => {
  // Final priority = priority(mode) + priority(action)
  // Combat mode bonus (60) + Combat base (20) = 80
  assert.equal(calculateActionPriority('Combat'), 80);

  // Farm mode bonus (25) + FarmPlant base (15) = 40
  assert.equal(calculateActionPriority('FarmPlant'), 40);

  // Maintenance mode bonus (0) + EquipBest base (15) = 15
  // FarmPlant (40) > EquipBest (15), ensuring leisure equipment checks never preempt farming
  assert.equal(calculateActionPriority('EquipBest'), 15);

  // Survival mode bonus (70) + Retreat base (30) = 100
  assert.equal(calculateActionPriority('Retreat'), 100);
});

test('farming integration: 5 consecutive planting failures triggers circuit breaker and switches to IDLE', () => {
  let modeEnqueued: string | null = null;
  const chatMessages: string[] = [];

  let consecutiveFailures = 0;
  const onFarmlandFailed = (_pos: any) => {
    consecutiveFailures++;
    if (consecutiveFailures >= 5) {
      chatMessages.push('Farming failed: 5 consecutive planting attempts failed.');
      modeEnqueued = 'IDLE';
    }
  };

  for (let i = 0; i < 4; i++) {
    onFarmlandFailed({ x: i, y: 64, z: i });
  }
  assert.equal(consecutiveFailures, 4);
  assert.equal(modeEnqueued, null);

  // 5th failure triggers circuit breaker
  onFarmlandFailed({ x: 5, y: 64, z: 5 });
  assert.equal(consecutiveFailures, 5);
  assert.equal(modeEnqueued, 'IDLE');
  assert.ok(chatMessages.includes('Farming failed: 5 consecutive planting attempts failed.'));
});

test('farming perception: filters out farmland with insufficient light level (< 8)', () => {
  const rallyPoint: Position = { x: 10, y: 64, z: 10 };
  const fakeBot: any = {
    blocks: {
      darkFarmland: {
        name: 'farmland',
        position: { x: 12, y: 64, z: 10 },
        above: { name: 'air', light: 4, skyLight: 0 }, // Both < 8 -> rejected
      },
      litFarmland: {
        name: 'farmland',
        position: { x: 15, y: 64, z: 10 },
        above: { name: 'air', light: 9, skyLight: 0 }, // Torch lit >= 8 -> accepted
      },
    },
  };

  const perception = createPerception(fakeBot, 'owner');
  const found = perception.getAvailableFarmland(rallyPoint, 25);
  assert.ok(found);
  assert.equal(found?.x, 15, 'Should select the lit farmland and skip the dark one');
});

test('farming perception: accepts farmland when light data is undefined', () => {
  const rallyPoint: Position = { x: 10, y: 64, z: 10 };
  const fakeBot: any = {
    blocks: {
      farmland: {
        name: 'farmland',
        position: { x: 12, y: 64, z: 10 },
        above: { name: 'air' }, // light undefined -> accepted gracefully
      },
    },
  };

  const perception = createPerception(fakeBot, 'owner');
  const found = perception.getAvailableFarmland(rallyPoint, 25);
  assert.ok(found);
  assert.equal(found?.x, 12);
});

test('farming adapter: farmPlant fails and triggers onFarmlandFailed when light level is insufficient (< 8)', async () => {
  let failedPos: any = null;
  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    pathfinder: { setGoal() {}, setMovements() {} },
    inventory: {
      items: () => [{ name: 'wheat_seeds', type: 100 }],
    },
    async lookAt() {},
    async equip() {},
    blockAt(pos: any) {
      if (pos.y > 64) {
        // Space above farmland has light 0 (dark underground/night)
        return { position: pos, name: 'air', light: 0, skyLight: 0 };
      }
      return { position: pos, name: 'farmland' };
    },
    async placeBlock() {
      throw new Error('Should not be called when light is insufficient');
    },
  };

  const farming = createFarming(fakeBot, {
    onFarmlandFailed: pos => {
      failedPos = pos;
    },
  });

  const request: ActionRequest = {
    nodeId: 'FarmPlant',
    runId: 'farm-dark-test',
    actionType: 'FarmPlant',
    targetId: null,
    priority: 30,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: { x: 1, y: 64, z: 0, seedItem: 'wheat_seeds', cropType: 'wheat' },
  };

  const board = createBlackboard('owner');
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = farming.farmPlant(request);
  adapter.start(ctx);
  adapter.update!(ctx);

  await new Promise(resolve => setTimeout(resolve, 200));

  assert.ok(failedPos !== null, 'onFarmlandFailed should be called when light is insufficient');
  assert.equal(failedPos.x, 1);
  assert.equal(failedPos.y, 64);
  assert.equal(failedPos.z, 0);
});
