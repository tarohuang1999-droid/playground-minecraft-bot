import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachCompanion } from '../../src/bot.ts';
import { createSetBedAdapter } from '../../src/actions/bed.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';
import { survivalConfig } from '../../src/config/index.ts';

class Stage4MockBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  health = 20;
  food = 20;
  players: Record<string, any> = {};
  entities: Record<number, any> = {};
  inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
  blocks: Record<string, any> = {};
  activatedBlocks: any[] = [];
  sent: string[] = [];
  isSleeping = false;
  isRaining = false;
  time = { timeOfDay: 0 };
  controlStates: Record<string, boolean> = {};
  activeGoal: any = null;

  pathfinder = {
    setGoal: (goal: any) => {
      this.activeGoal = goal;
    },
    isMoving: () => false,
  };

  blockAt = (pos: any) => {
    const key = Object.keys(this.blocks).find(k => {
      const b = this.blocks[k];
      return (
        Math.floor(b.position.x) === Math.floor(pos.x) &&
        Math.floor(b.position.y) === Math.floor(pos.y) &&
        Math.floor(b.position.z) === Math.floor(pos.z)
      );
    });
    return key ? this.blocks[key] : null;
  };

  activateBlock = async (block: any) => {
    this.activatedBlocks.push(block);
  };

  sleepCalls = 0;
  wakeCalls = 0;

  sleep = async (_bedBlock: any) => {
    this.sleepCalls++;
    this.isSleeping = true;
  };

  wake = async () => {
    this.wakeCalls++;
    this.isSleeping = false;
  };

  setControlState = (control: string, state: boolean) => {
    this.controlStates[control] = state;
  };

  chat(message: string) {
    this.sent.push(message);
  }
}

test('Stage 4.1 !setbed: without bed within 10 blocks replies "沒看到"', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.ok(bot.sent.includes('沒看到'));
  assert.strictEqual(companion.snapshot().world.spawnPoint, null);

  companion.dispose();
});

test('Stage 4.1 !setbed: with bed at distance > 10 blocks replies "沒看到"', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  bot.blocks.distantBed = { name: 'red_bed', position: { x: 15, y: 64, z: 0 } }; // dist = 15 > 10
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.ok(bot.sent.includes('沒看到'));
  assert.strictEqual(companion.snapshot().world.spawnPoint, null);

  companion.dispose();
});

test('Stage 4.1 !setbed: with bed within 10 blocks sets spawn point and activates bed', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  bot.blocks.nearBed = { name: 'cyan_bed', position: { x: 2, y: 64, z: 0 } }; // dist = 2 <= 10
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.deepStrictEqual(companion.snapshot().world.spawnPoint, { x: 2, y: 64, z: 0 });
  assert.ok(bot.sent.some(m => m.includes('Spawn point set to (2.0, 64.0, 0.0)')));
  assert.strictEqual(bot.activatedBlocks.length, 1);

  companion.dispose();
});

test('Stage 4.1 SetBed ActionAdapter: searches bed, fails if none, succeeds and sets spawn if found', () => {
  const bot = new Stage4MockBot();
  let spawnSet: any = null;
  let noBedCalled = false;

  const factory = createSetBedAdapter(bot as any, undefined, {
    onSpawnSet: pos => {
      spawnSet = pos;
    },
    onNoBedFound: () => {
      noBedCalled = true;
    },
  });

  const request: ActionRequest = {
    nodeId: 'node-1',
    runId: 'run-1',
    actionType: 'SetBed',
    targetId: null,
    requiredResources: ['MOVE', 'LOOK', 'HAND'],
    priority: 15,
    params: {},
  };

  const adapter = factory(request);
  const dummyCtx: ActionContext = {
    request,
    token: 1,
    generation: 1,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => ({ world: { self: { position: { x: 0, y: 64, z: 0 } } } }) as any,
  };

  // Case 1: No bed
  const res1 = adapter.start(dummyCtx);
  assert.deepStrictEqual(res1, { status: 'FAILURE', reason: 'No bed found within 10 blocks' });
  assert.strictEqual(noBedCalled, true);

  // Case 2: Bed present
  bot.blocks.bed = { name: 'white_bed', position: { x: 1, y: 64, z: 1 } };
  const res2 = adapter.start(dummyCtx);
  assert.deepStrictEqual(res2, { status: 'SUCCESS' });
  assert.deepStrictEqual(spawnSet, { x: 1, y: 64, z: 1 });
  assert.strictEqual(bot.activatedBlocks.length, 1);
});

test('Stage 4.1 Autonomous Sleep: does NOT trigger sleep if spawnPoint is NOT set even at night', () => {
  const bot = new Stage4MockBot();
  bot.time.timeOfDay = 15000; // Nighttime
  const companion = attachCompanion(bot as any, '', { now: () => 1000 });
  bot.emit('spawn');

  // mode is IDLE, night, but NO spawnPoint set!
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.strictEqual(companion.snapshot().world.spawnPoint, null);
  assert.strictEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
  assert.strictEqual(bot.sleepCalls, 0);

  companion.dispose();
});

test('Stage 4.1 Autonomous Sleep: does NOT trigger sleep during daytime when not raining', () => {
  const bot = new Stage4MockBot();
  bot.time.timeOfDay = 6000; // Midday
  bot.isRaining = false;
  bot.blocks.bed = { name: 'red_bed', position: { x: 1, y: 64, z: 0 } };
  const companion = attachCompanion(bot as any, 'dakaz', { now: () => 1000 });
  bot.emit('spawn');

  // Set bed
  bot.emit('chat', 'dakaz', '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.deepStrictEqual(companion.snapshot().world.spawnPoint, { x: 1, y: 64, z: 0 });

  // Physics ticks during day
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.strictEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
  assert.strictEqual(bot.sleepCalls, 0);

  companion.dispose();
});

test('Stage 4.1 Autonomous Sleep: does NOT trigger sleep if mode is NOT IDLE (e.g. FOLLOW)', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  const ownerEntity = { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: owner };
  bot.blocks.bed = { name: 'red_bed', position: { x: 1, y: 64, z: 0 } };
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  // Set bed while daytime
  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Switch to FOLLOW
  bot.emit('chat', owner, '!follow');
  ownerEntity.position = { x: 5, y: 64, z: 0 }; // distance = 5 -> triggers NormalFollow

  // Night falls while in FOLLOW mode
  bot.time.timeOfDay = 15000;
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Mode is FOLLOW, so NormalFollow runs instead of SleepAtBed
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /NormalFollow/);
  assert.strictEqual(bot.sleepCalls, 0);

  companion.dispose();
});

test('Stage 4.1 Autonomous Sleep: triggers SleepAtBed when spawnPoint is set, mode is IDLE, and nighttime', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  bot.blocks.bed = { name: 'blue_bed', position: { x: 1, y: 64, z: 0 } };
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  // 1. Set bed
  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.deepStrictEqual(companion.snapshot().world.spawnPoint, { x: 1, y: 64, z: 0 });

  // 2. Night falls (timeOfDay >= sleepMinTime)
  bot.time.timeOfDay = survivalConfig.sleepMinTime + 100;
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // SleepAtBed is active and locked resources
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /SleepAtBed/);
  assert.match(companion.snapshot().runtime.lockedResources.HAND ?? '', /SleepAtBed/);
  assert.strictEqual(bot.sleepCalls, 1);
  assert.strictEqual(bot.isSleeping, true);

  companion.dispose();
});

test('Stage 4.1 Autonomous Sleep: taking damage / under attack while sleeping wakes up bot and triggers combat/retreat preemption', () => {
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  bot.blocks.bed = { name: 'yellow_bed', position: { x: 1, y: 64, z: 0 } };
  const companion = attachCompanion(bot as any, owner, { now: () => 1000 });
  bot.emit('spawn');

  // 1. Set bed and sleep at night
  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.time.timeOfDay = 16000;
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(bot.isSleeping, true);

  // 2. A zombie attacks the sleeping bot!
  const zombie = {
    id: 99,
    name: 'zombie',
    type: 'mob',
    position: { x: 2, y: 64, z: 0 },
    health: 20,
  };
  bot.entities[99] = zombie;
  bot.health = 18; // Took damage!
  bot.emit('entityHurt', bot.entity, zombie);
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Bot wakes up immediately!
  assert.strictEqual(bot.isSleeping, false);
  assert.ok(bot.wakeCalls >= 1);
  // Combat (80) preempts SleepAtBed (15)
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);

  companion.dispose();
});

test('Stage 4.1 Autonomous Sleep: morning arrival wakes up bot, announces "Good morning!", and returns to IDLE', () => {
  let simulatedTime = 1000;
  const bot = new Stage4MockBot();
  const owner = 'dakaz';
  bot.players.dakaz = {
    entity: { id: 2, position: { x: 0, y: 64, z: 0 }, username: owner },
    username: owner,
  };
  bot.blocks.bed = { name: 'green_bed', position: { x: 1, y: 64, z: 0 } };
  const companion = attachCompanion(bot as any, owner, { now: () => simulatedTime });
  bot.emit('spawn');

  // 1. Set bed and sleep at night
  bot.emit('chat', owner, '!setbed');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  simulatedTime += 2000;
  bot.time.timeOfDay = 18000;
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(bot.isSleeping, true);

  // 2. Night ends, morning arrives (timeOfDay = 0)
  simulatedTime += 2000;
  bot.time.timeOfDay = 0;
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Bot woke up and greeted morning!
  assert.strictEqual(bot.isSleeping, false);
  assert.ok(bot.wakeCalls >= 1);
  assert.ok(bot.sent.includes('Good morning!'));
  // Returns to IDLE
  assert.strictEqual(companion.snapshot().intent.mode, 'IDLE');

  companion.dispose();
});

test('Stage 4.1 Rest subtree & survivalConfig: canSleep and shouldExitSleep unit verification', async () => {
  const { canSleep, shouldExitSleep, restSubtree } = await import('../../src/bt/subtrees/rest.ts');
  const { createWorld } = await import('../../src/blackboard.ts');

  // Verify survivalConfig.bed parameters exist and are numbers
  assert.strictEqual(typeof survivalConfig.bed.searchRadius, 'number');
  assert.strictEqual(typeof survivalConfig.bed.reachDistance, 'number');
  assert.strictEqual(typeof survivalConfig.bed.sleepReachDistance, 'number');
  assert.strictEqual(typeof survivalConfig.bed.sleepApproachGoal, 'number');
  assert.strictEqual(typeof survivalConfig.bed.setBedTimeoutMs, 'number');
  assert.strictEqual(typeof survivalConfig.bed.failureCooldownMs, 'number');

  // 1. Initial snapshot: mode is IDLE, but spawnPoint is null -> canSleep false
  const world = createWorld();
  const baseSnapshot = {
    world: {
      ...world,
      self: { ...world.self, isAlive: true, tookDamageRecently: false },
      spawnPoint: null,
      timeOfDay: 18000,
      isRaining: false,
      threats: [],
    },
    intent: { mode: 'IDLE' as const, canDig: false, allowBridge: false, missionId: null },
    runtime: { lockedResources: {}, activeRuns: {}, results: {}, cooldowns: {} },
    observedAt: 1000,
  };

  assert.strictEqual(canSleep(baseSnapshot as any), false);

  // 2. Set spawn point -> canSleep true at night
  const sleepingSnapshot = {
    ...baseSnapshot,
    world: {
      ...baseSnapshot.world,
      spawnPoint: { x: 10, y: 64, z: 10 },
    },
  };
  assert.strictEqual(canSleep(sleepingSnapshot as any), true);
  assert.strictEqual(shouldExitSleep(sleepingSnapshot as any, new Set(['SleepAtBed'])), false);

  // 3. During daytime without rain -> canSleep false, shouldExitSleep true
  const daytimeSnapshot = {
    ...sleepingSnapshot,
    world: {
      ...sleepingSnapshot.world,
      timeOfDay: 6000,
      isRaining: false,
    },
  };
  assert.strictEqual(canSleep(daytimeSnapshot as any), false);
  assert.strictEqual(shouldExitSleep(daytimeSnapshot as any, new Set(['SleepAtBed'])), true);

  // 4. During daytime WITH rain -> canSleep true
  const rainyDaytimeSnapshot = {
    ...daytimeSnapshot,
    world: {
      ...daytimeSnapshot.world,
      isRaining: true,
    },
  };
  assert.strictEqual(canSleep(rainyDaytimeSnapshot as any), true);
  assert.strictEqual(shouldExitSleep(rainyDaytimeSnapshot as any, new Set(['SleepAtBed'])), false);

  // 5. Standalone restSubtree BT evaluation
  const { createTree } = await import('../../src/bt/nodes.ts');
  const tree = createTree(restSubtree(new Set(['SleepAtBed'])));
  const result = tree.tick(sleepingSnapshot as any);
  assert.strictEqual(result.status, 'RUNNING');
  const sleepReq = result.requests.find(r => r.actionType === 'SleepAtBed');
  assert.ok(sleepReq, 'SleepAtBed should be requested');
  assert.deepStrictEqual(sleepReq?.params, { x: 10, y: 64, z: 10 });
});
