import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createChat } from '../../src/actions/chat.ts';
import { createFarming } from '../../src/actions/farming.ts';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { attachCompanion } from '../../src/bot.ts';
import { createCommandController } from '../../src/command-controller.ts';
import { createRunner } from '../../src/bt/runner.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import { createPerception } from '../../src/perception.ts';
import { createTaskSessionManager } from '../../src/sessions/task-session-manager.ts';

class Stage3MockBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  health = 20;
  food = 20;
  heldItem: { name: string; type: number; count?: number } | null = null;
  players: Record<
    string,
    { username?: string; entity?: { id: number; position: { x: number; y: number; z: number } } }
  > = {
    owner: { username: 'owner', entity: { id: 2, position: { x: 0, y: 64, z: 0 } } },
  };
  entities: Record<
    number,
    {
      id: number;
      name?: string;
      username?: string;
      type?: string;
      position: { x: number; y: number; z: number };
      isValid?: boolean;
    }
  > = {};
  inventoryItems: Array<{ name: string; type: number; count: number }> = [];
  inventory = {
    emptySlotCount: () => 30,
    items: () => this.inventoryItems,
    slots: [] as Array<{ name: string; count: number } | null>,
  };
  pathfinder = {
    setGoal() {},
    stop() {},
    setMovements() {},
  };
  registry = { blocksByName: {}, itemsByName: {} };
  chatLog: string[] = [];
  digCalls = 0;
  placeCalls = 0;
  activateCalls = 0;
  swingCalls = 0;

  chat(msg: string) {
    this.chatLog.push(msg);
  }
  async dig() {
    this.digCalls++;
  }
  async placeBlock() {
    this.placeCalls++;
  }
  async activateBlock() {
    this.activateCalls++;
  }
  swingArm() {
    this.swingCalls++;
  }
  async equip(item: { name: string; type: number; count?: number }) {
    this.heldItem = item;
  }
  async lookAt() {}
  attack() {}
}

test('Stage 3.1: default runner clock uses Date.now() and 20-minute timeout triggers for HUNT and FARM', () => {
  // 1. Verify default runner clock aligns with Date.now() epoch (> 1_000_000_000_000)
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), {});
  const runner = createRunner({
    board,
    executor,
    tree: {
      tick: () => ({ status: 'SUCCESS', requests: [] }),
      halt() {},
    },
  });
  assert.ok(
    runner.snapshot().observedAt >= 1_700_000_000_000,
    'Default runner clock should use Date.now() epoch'
  );

  // 2. Verify 20-minute timeout triggers for HUNT and FARM in attachCompanion
  let fakeTime = 1_700_000_000_000;
  const bot = new Stage3MockBot();
  // Keep an animal out of melee range so hunting stays active until timeout
  bot.entities[50] = {
    id: 50,
    name: 'cow',
    position: { x: 10, y: 64, z: 0 },
    isValid: true,
  };

  const companion = attachCompanion(bot as never, 'owner', { now: () => fakeTime });
  bot.emit('spawn');

  bot.emit('chat', 'owner', '!hunt');
  bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'HUNT');

  // Advance past 20 minutes (1,200,001 ms)
  fakeTime += 1_200_001;
  bot.emit('physicsTick');
  fakeTime += 1500;
  bot.emit('physicsTick');

  assert.equal(companion.snapshot().intent.mode, 'IDLE');
  assert.ok(
    bot.chatLog.some(m => m.includes('Hunting shift completed (1 day limit reached)')),
    `Expected hunting timeout message, got: ${JSON.stringify(bot.chatLog)}`
  );

  // Now test FARM 20-minute timeout
  bot.inventoryItems = [{ name: 'wheat_seeds', type: 1, count: 10 }];
  (bot as { blocks?: unknown }).blocks = {
    farFarmland: {
      name: 'farmland',
      position: { x: 15, y: 64, z: 0 },
      above: { name: 'air' },
    },
  };

  fakeTime += 1500;
  bot.emit('chat', 'owner', '!farm');
  bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'FARM');

  fakeTime += 1_200_001;
  bot.emit('physicsTick');
  fakeTime += 1500;
  bot.emit('physicsTick');
  fakeTime += 1500;
  bot.emit('physicsTick');

  assert.equal(companion.snapshot().intent.mode, 'IDLE');
  assert.ok(
    bot.chatLog.some(m => m.includes('Farming shift completed (1 day limit reached)')),
    `Expected farming timeout message, got: ${JSON.stringify(bot.chatLog)}`
  );

  companion.dispose();
});

test('Stage 3.1: FarmPlant calls bot.placeBlock without being rejected by NavigationExecutionBoundary', async () => {
  const fakeTime = 10_000;
  const bot = new Stage3MockBot();
  (bot as any).activateBlock = undefined;
  // Position bot at (0, 64, 0.5) so distance to farmland center (1.5, 64, 0.5) is 1.5 (in [1.2, 2.2])
  bot.entity.position = { x: 0, y: 64, z: 0.5 };
  bot.inventoryItems = [{ name: 'wheat_seeds', type: 295, count: 5 }];
  const farmlandPos = { x: 1, y: 64, z: 0 };

  (bot as { blocks?: unknown }).blocks = {
    closeFarmland: {
      name: 'farmland',
      position: farmlandPos,
      above: { name: 'air' },
    },
  };
  (bot as { blockAt?: unknown }).blockAt = (pos: { x: number; y: number; z: number }) => {
    if (pos.x === 1 && pos.y === 64 && pos.z === 0) {
      return { name: 'farmland', position: farmlandPos };
    }
    return { name: 'air', position: pos };
  };

  let plantedCrop = false;
  bot.placeBlock = async () => {
    bot.placeCalls++;
    plantedCrop = true;
  };

  const companion = attachCompanion(bot as never, 'owner', { now: () => fakeTime });
  bot.emit('spawn');
  bot.emit('chat', 'owner', '!farm');
  bot.emit('physicsTick'); // starts FarmPlant
  bot.emit('physicsTick'); // updates FarmPlant in range, initiates async planting

  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(bot.placeCalls, 1, 'bot.placeBlock should pass through NavigationExecutionBoundary');
  assert.equal(plantedCrop, true);
  assert.equal(
    bot.activateCalls,
    0,
    'Fallback activateBlock should not run when placeBlock succeeds'
  );

  companion.dispose();
});

test('Stage 3.1: FarmPlant cancelled during in-flight placeBlock does not trigger fallback activateBlock or swingArm and tracks isStopped()', async () => {
  let rejectPlace!: (err: Error) => void;
  let swingCalls = 0;

  const fakeBot = {
    entity: { position: { x: 0, y: 64, z: 0.5 } },
    pathfinder: { setGoal() {}, stop() {}, setMovements() {} },
    inventory: {
      items: () => [{ name: 'wheat_seeds', type: 295, count: 4 }],
    },
    heldItem: { name: 'wheat_seeds', type: 295, count: 4 },
    blockAt: (pos: { x: number; y: number; z: number }) => {
      if (pos.y === 64) return { name: 'farmland', position: pos };
      return { name: 'air', position: pos };
    },
    lookAt: async () => {},
    equip: async () => {},
    placeBlock: () =>
      new Promise<void>((_resolve, reject) => {
        rejectPlace = reject;
      }),
    swingArm: () => {
      swingCalls++;
    },
  };

  const farming = createFarming(fakeBot as never);
  const request = {
    nodeId: 'farm-node',
    runId: 'run-1',
    actionType: 'FarmPlant' as const,
    priority: 40,
    targetId: null,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'] as const,
    cooldownMs: 0,
    interruptible: true,
    params: { x: 1, y: 64, z: 0, seedItem: 'wheat_seeds', cropType: 'wheat' },
  };
  const adapter = farming.farmPlant(request);

  let ctxActive = true;
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.position = { x: 0, y: 64, z: 0.5 };
  board.setWorld(world);
  const abortController = new AbortController();
  const ctx = {
    runId: 'run-1',
    token: 1,
    request,
    generation: 0,
    signal: abortController.signal,
    isActive: () => ctxActive,
    getSnapshot: () => board.snapshot(1000),
  };

  adapter.start(ctx);
  adapter.update?.(ctx); // starts async plant()

  // Wait past the 50ms settling delay so placeBlock is actively awaited
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(adapter.isStopped?.(), false, 'Should not report stopped while inFlight is true');

  // Cancel while placeBlock is in-flight, then reject placeBlock
  ctxActive = false;
  adapter.cancel();
  rejectPlace(new Error('Simulated block placement abort'));

  await new Promise(resolve => setImmediate(resolve));

  assert.equal(swingCalls, 0, 'Cancelled FarmPlant must not call fallback swingArm');
  assert.equal(adapter.isStopped?.(), true, 'Should report stopped once inFlight settles');
});

test('Stage 3.1: entityHurt without source ignores bystanders without recent arm swing and records attacker with recent swing', () => {
  let fakeTime = 5000;
  const bot = new Stage3MockBot();
  // Bystander player near bot
  bot.entities[99] = {
    id: 99,
    username: 'bystander',
    type: 'player',
    position: { x: 1, y: 64, z: 0 },
  };

  const companion = attachCompanion(bot as never, 'owner', { now: () => fakeTime });
  bot.emit('spawn');

  // 1. Hurt with no source and no arm swing -> bystander NOT added to threats
  bot.emit('entityHurt', bot.entity, undefined);
  bot.emit('physicsTick');
  assert.equal(
    companion.snapshot().world.threats.length,
    0,
    'Bystander without arm swing must not be blamed for sourceless damage'
  );

  // 2. Bystander swings arm, then 1500ms passes (> 1000ms window) -> still NOT added
  bot.emit('entitySwingArm', bot.entities[99]);
  fakeTime += 1500;
  bot.emit('entityHurt', bot.entity, undefined);
  bot.emit('physicsTick');
  assert.equal(
    companion.snapshot().world.threats.length,
    0,
    'Stale arm swing (> 1000ms) must not trigger player counterattack'
  );

  // 3. Bystander swings arm within 500ms (<= 1000ms window) -> added to threats
  bot.emit('entitySwingArm', bot.entities[99]);
  fakeTime += 500;
  bot.emit('entityHurt', bot.entity, undefined);
  bot.emit('physicsTick');
  assert.equal(
    companion.snapshot().world.threats.length,
    1,
    'Player with recent arm swing (<= 1000ms) within 4.5m should be recorded as threat'
  );
  assert.equal(companion.snapshot().world.threats[0]?.entityId, 99);

  companion.dispose();
});

test('Stage 3.2: TaskSessionManager unit tests (happy path, edge cases, reset, and failure limits)', () => {
  const sm = createTaskSessionManager();

  // Farming happy path & failure reset
  sm.startFarming('FARM:1');
  assert.equal(sm.recordFarmFailure().shouldAbort, false);
  assert.equal(sm.recordCropPlanted(), 1);
  // Consecutive failures reset after planting a crop
  for (let i = 0; i < 4; i++) {
    assert.equal(sm.recordFarmFailure().shouldAbort, false);
  }
  assert.equal(sm.recordFarmFailure().shouldAbort, true);

  const fComplete1 = sm.tryCompleteTask('FARM:1', 'COMPLETED');
  assert.deepEqual(fComplete1, { completed: true, count: 1 });
  // Duplicate call with same missionId is idempotent
  assert.deepEqual(sm.tryCompleteTask('FARM:1', 'COMPLETED'), { completed: false, count: 0 });
  // Empty missionId edge case
  assert.deepEqual(sm.tryCompleteTask('', 'COMPLETED'), { completed: false, count: 0 });

  // Hunting happy path & edge cases
  sm.startHunting('HUNT:1');
  assert.equal(sm.recordAnimalDead(10), false, 'Unattacked animal must not count');
  sm.recordAnimalAttacked(10);
  assert.equal(sm.recordAnimalDead(10), true, 'Attacked animal counts on first death');
  assert.equal(sm.recordAnimalDead(10), false, 'Duplicate entityDead must not double-count');
  assert.equal(sm.getHuntedCount(), 1);

  assert.deepEqual(sm.tryCompleteTask('HUNT:1', 'COMPLETED'), { completed: true, count: 1 });
  assert.deepEqual(sm.tryCompleteTask('HUNT:1', 'COMPLETED'), { completed: false, count: 0 });

  // Reset clears all state
  sm.reset();
  assert.equal(sm.getPlantedCount(), 0);
  assert.equal(sm.getHuntedCount(), 0);
});

test('Stage 3.2: 3 consecutive rounds of !hunt and !farm each complete and transition to IDLE', () => {
  let fakeTime = 10_000;
  const bot = new Stage3MockBot();
  const companion = attachCompanion(bot as never, 'owner', { now: () => fakeTime });
  bot.emit('spawn');

  // 3 rounds of !hunt (no animals -> immediate completion)
  for (let round = 1; round <= 3; round++) {
    fakeTime += 2000;
    bot.emit('chat', 'owner', '!hunt');
    bot.emit('physicsTick'); // starts & sees no animals -> completes on tick, sends Intent=HUNT
    fakeTime += 1500;
    bot.emit('physicsTick'); // flushes Intent=HUNT -> STOPPING
    fakeTime += 1500;
    bot.emit('physicsTick'); // releases VOICE fence & sends Hunting completed
    bot.emit('physicsTick'); // flushes Hunting completed -> STOPPING
    bot.emit('physicsTick'); // releases VOICE fence

    assert.equal(
      companion.snapshot().intent.mode,
      'IDLE',
      `Hunt round ${round} should return to IDLE`
    );
    const completedMsgs = bot.chatLog.filter(m => m.startsWith('Hunting completed.'));
    assert.equal(
      completedMsgs.length,
      round,
      `Hunt round ${round} should emit completion chat message`
    );
  }

  // 3 rounds of !farm (has seeds, no empty farmland -> immediate completion)
  bot.inventoryItems = [{ name: 'wheat_seeds', type: 295, count: 5 }];
  (bot as { blocks?: unknown }).blocks = {};

  for (let round = 1; round <= 3; round++) {
    fakeTime += 2000;
    bot.emit('chat', 'owner', '!farm');
    bot.emit('physicsTick'); // starts & sees no farmland -> completes on tick, sends Intent=FARM
    fakeTime += 1500;
    bot.emit('physicsTick'); // flushes Intent=FARM -> STOPPING
    fakeTime += 1500;
    bot.emit('physicsTick'); // releases VOICE fence & sends Farming completed
    bot.emit('physicsTick'); // flushes Farming completed -> STOPPING
    bot.emit('physicsTick'); // releases VOICE fence

    assert.equal(
      companion.snapshot().intent.mode,
      'IDLE',
      `Farm round ${round} should return to IDLE`
    );
    const completedMsgs = bot.chatLog.filter(m => m.startsWith('Farming completed.'));
    assert.equal(
      completedMsgs.length,
      round,
      `Farm round ${round} should emit completion chat message`
    );
  }

  companion.dispose();
});

test('Stage 3.2: entityGone after attacking an animal marks cooldown but does NOT increment kill count', () => {
  let fakeTime = 20_000;
  const bot = new Stage3MockBot();
  bot.entities[77] = {
    id: 77,
    name: 'sheep',
    position: { x: 1, y: 64, z: 0 },
    isValid: true,
  };

  const companion = attachCompanion(bot as never, 'owner', { now: () => fakeTime });
  bot.emit('spawn');
  bot.emit('chat', 'owner', '!hunt');
  bot.emit('physicsTick'); // starts HuntAnimal
  bot.emit('physicsTick'); // attacks sheep 77

  // Animal despawns / leaves chunk via entityGone WITHOUT entityDead
  bot.emit('entityGone', { id: 77, name: 'sheep' });
  delete bot.entities[77];

  fakeTime += 1500;
  bot.emit('physicsTick');
  fakeTime += 1500;
  bot.emit('physicsTick');

  assert.ok(
    bot.chatLog.some(m => m.includes('Hunting completed. Hunted 0 animals.')),
    `Expected 0 kills when animal only triggers entityGone, got: ${JSON.stringify(bot.chatLog)}`
  );

  companion.dispose();
});

test('Stage 3.3: CommandController independent unit verification', () => {
  let fakeTime = 2000;
  const fakeBot = new Stage3MockBot();
  const board = createBlackboard('owner');
  const perception = createPerception(fakeBot as never, 'owner', { now: () => fakeTime });
  const sessionManager = createTaskSessionManager();
  const chat = createChat(msg => fakeBot.chat(msg));
  const executor = createExecutor(createArbiter(), { Chat: chat.adapter });
  const runner = createRunner({
    board,
    executor,
    tree: {
      tick: () => ({ status: 'SUCCESS', requests: [] }),
      halt() {},
    },
    now: () => fakeTime,
    collectRequests: chat.requests,
  });
  runner.resume();

  const controller = createCommandController({
    bot: fakeBot,
    owner: 'owner',
    now: () => fakeTime,
    perception,
    sessionManager,
    chat,
    runner,
    sample: () => {
      runner.enqueue({ type: 'world', world: perception.sample(executor.runtime().cooldowns) });
    },
    isActive: () => true,
  });

  // Ignore non-owner commands
  controller.handleCommand('stranger', '!stop');
  runner.physicsTick();
  assert.equal(fakeBot.chatLog.length, 0);

  // !farm without seeds -> warns no seeds
  controller.handleCommand('owner', '!farm');
  runner.physicsTick(); // sends first chat message
  assert.ok(fakeBot.chatLog.includes('No plantable seeds in inventory!'));
  runner.physicsTick(); // flushes Chat -> STOPPING
  runner.physicsTick(); // releases VOICE fence

  // !item inventory formats inventory
  fakeTime += 1500;
  controller.handleCommand('owner', '!item inventory');
  runner.physicsTick();
  assert.ok(fakeBot.chatLog.some(m => m.includes('[Inventory] (30 slots free) Empty')));
});

test('Stage 3.4: companion.dispose() removes all bot listeners and uninstalls NavigationExecutionBoundary', async () => {
  const bot = new Stage3MockBot();
  const origDig = bot.dig;
  const origPlace = bot.placeBlock;

  const companion = attachCompanion(bot as never, 'owner');
  bot.emit('spawn');

  assert.notEqual(bot.dig, origDig, 'NavigationExecutionBoundary should wrap bot.dig while active');
  assert.notEqual(
    bot.placeBlock,
    origPlace,
    'NavigationExecutionBoundary should wrap bot.placeBlock while active'
  );
  assert.ok(bot.listenerCount('physicsTick') > 0);
  assert.ok(bot.listenerCount('entityHurt') > 0);

  companion.dispose();
  // Calling dispose() a second time is safe and idempotent
  companion.dispose();

  assert.equal(bot.dig, origDig, 'dispose() must restore original bot.dig');
  assert.equal(bot.placeBlock, origPlace, 'dispose() must restore original bot.placeBlock');

  for (const event of [
    'spawn',
    'respawn',
    'death',
    'end',
    'physicsTick',
    'health',
    'entitySwingArm',
    'entityDead',
    'entityGone',
    'entityHurt',
    'chat',
    'whisper',
  ]) {
    assert.equal(bot.listenerCount(event), 0, `Listener count for ${event} should be 0`);
  }
});
