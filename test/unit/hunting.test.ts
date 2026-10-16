import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { parseCommand } from '../../src/commands.ts';
import { createBlackboard, createWorld, type Position } from '../../src/blackboard.ts';
import { createPerception } from '../../src/perception.ts';
import { createHunting } from '../../src/actions/hunting.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { attachCompanion } from '../../src/bot.ts';
import { workConfig } from '../../src/config/index.ts';
import { calculateActionPriority } from '../../src/policy.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';

test('hunting commands: parses !hunt with and without target animal', () => {
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt'), { type: 'hunt', target: null });
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt cow'), { type: 'hunt', target: 'cow' });
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt pig'), { type: 'hunt', target: 'pig' });
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt sheep'), {
    type: 'hunt',
    target: 'sheep',
  });
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt chicken'), {
    type: 'hunt',
    target: 'chicken',
  });

  // Invalid animal returns usage
  assert.deepEqual(parseCommand('owner', 'owner', '!hunt zombie'), {
    type: 'command_usage',
    message: 'Usage: !hunt [chicken|pig|cow|sheep]',
  });

  // Non-owner ignored
  assert.equal(parseCommand('owner', 'stranger', '!hunt'), null);
});

test('hunting perception: findHuntableAnimal identifies closest valid animal within radius and respects targets', () => {
  const rallyPoint: Position = { x: 0, y: 64, z: 0 };
  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {
      closePig: {
        id: 10,
        name: 'pig',
        position: { x: 5, y: 64, z: 0 }, // dist from rally = 5 <= 25, dist to bot = 5
      },
      closeCow: {
        id: 11,
        name: 'cow',
        position: { x: 2, y: 64, z: 0 }, // dist from rally = 2 <= 25, dist to bot = 2
      },
      farSheep: {
        id: 12,
        name: 'sheep',
        position: { x: 30, y: 64, z: 0 }, // dist from rally = 30 > 25 (out of bounds)
      },
      deadChicken: {
        id: 13,
        name: 'chicken',
        position: { x: 1, y: 64, z: 0 },
        health: 0, // dead
      },
      monster: {
        id: 14,
        name: 'zombie',
        position: { x: 1, y: 64, z: 0 }, // not a huntable animal
      },
    },
  };

  const perception = createPerception(fakeBot, 'owner');

  // 1. General search: cow is closest (dist 2 vs pig dist 5)
  const bestAll = perception.getHuntableAnimal(rallyPoint, 25);
  assert.ok(bestAll);
  assert.equal(bestAll?.entityId, 11);
  assert.equal(bestAll?.name, 'cow');

  // 2. Specific search: target pig
  const bestPig = perception.getHuntableAnimal(rallyPoint, 25, 'pig');
  assert.ok(bestPig);
  assert.equal(bestPig?.entityId, 10);
  assert.equal(bestPig?.name, 'pig');

  // 3. Animal cooldown skips on next search
  perception.markAnimalCooldown(11, 30_000);
  const nextBest = perception.getHuntableAnimal(rallyPoint, 25);
  assert.ok(nextBest);
  assert.equal(nextBest?.entityId, 10, 'Should skip cow on cooldown and pick pig');
});

test('hunting integration: !hunt engages HUNT mode, anchors rally point, and announces Intent=HUNT', () => {
  class MockBot extends EventEmitter {
    entity = { id: 1, position: { x: 10, y: 64, z: 20 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {
      owner: { entity: { id: 2, position: { x: 0, y: 64, z: 0 } } },
    };
    entities: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 30,
      items: () => [],
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
  bot.emit('chat', 'owner', '!hunt');
  bot.emit('physicsTick');

  assert.ok(bot.chatLog.includes('Intent=HUNT'));
  const snap = companion.snapshot();
  assert.equal(snap.intent.mode, 'HUNT');
  assert.equal(snap.intent.workArea?.rallyPoint.x, 10);
  assert.equal(snap.intent.workArea?.rallyPoint.z, 20);
  assert.equal(snap.intent.workArea?.maxRadius, workConfig.huntWorkRadius);
  assert.equal(snap.intent.workArea?.maxDurationMs, workConfig.huntMaxDurationMs);

  companion.dispose();
});

test('hunting BT: selects HuntAnimal (40) when huntable animal is available in range', () => {
  const available = new Set(['NormalFollow', 'HuntAnimal', 'Idle']);
  const animalTarget = { entityId: 105, name: 'cow', position: { x: 5, y: 64, z: 5 }, distance: 7 };
  const tree = createCompanionTree(available, {
    getHuntableAnimal: () => animalTarget,
  });

  const board = createBlackboard('owner');
  const now = 1000;
  board.setIntent('HUNT', now, null, {
    rallyPoint: { x: 0, y: 64, z: 0 },
    maxRadius: 25,
    startedAt: now,
    maxDurationMs: 1_200_000,
    targetAnimal: null,
  });

  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  board.setWorld(world);

  const snapshot = board.snapshot(now);
  const result = tree.tick(snapshot);

  const huntReq = result.requests.find(r => r.actionType === 'HuntAnimal');
  assert.ok(huntReq, 'HuntAnimal request should be issued');
  assert.equal(huntReq?.targetId, 105);
  assert.equal(huntReq?.priority, 40); // HUNT bonus 25 + HuntAnimal base 15 = 40
});

test('hunting BT: shift duration limit (20 min) or no animals left finishes to IDLE without ReturnToRally and notifies chat', () => {
  let finishedReason: string | null = null;
  const tree = createCompanionTree(new Set(['HuntAnimal', 'Idle']), {
    getHuntableAnimal: () => null, // No animals left
    onHuntingFinished: reason => {
      finishedReason = reason;
    },
  });

  const board = createBlackboard('owner');
  const now = 1000;
  board.setIntent('HUNT', now, null, {
    rallyPoint: { x: 0, y: 64, z: 0 },
    maxRadius: 25,
    startedAt: now,
    maxDurationMs: 1_200_000,
  });

  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  board.setWorld(world);

  const snapshot = board.snapshot(now);
  const result = tree.tick(snapshot);

  assert.equal(finishedReason, 'COMPLETED');
  const idleReq = result.requests.find(r => r.actionType === 'Idle');
  assert.ok(idleReq, 'Idle request should be issued');

  // Shift timeout triggers TIMEOUT reason
  let timeoutReason: string | null = null;
  const treeTimeout = createCompanionTree(new Set(['HuntAnimal', 'Idle']), {
    getHuntableAnimal: () => ({
      entityId: 1,
      name: 'pig',
      position: { x: 1, y: 64, z: 1 },
      distance: 1,
    }),
    onHuntingFinished: reason => {
      timeoutReason = reason;
    },
  });

  const expiredSnapshot = board.snapshot(now + 1_200_001);
  const timeoutResult = treeTimeout.tick(expiredSnapshot);

  assert.equal(timeoutReason, 'TIMEOUT');
  const timeoutIdleReq = timeoutResult.requests.find(r => r.actionType === 'Idle');
  assert.ok(timeoutIdleReq, 'Idle request should be issued on timeout');
});

test('hunting adapter: approaches animal, auto-equips best weapon, attacks when in range, and completes on death', async () => {
  let goalSet: any = null;
  const equipCalls: any[] = [];
  const attackCalls: any[] = [];
  let killedAnimal: string | null = null;

  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setGoal(goal: any) {
        goalSet = goal;
      },
    },
    entities: {
      55: {
        id: 55,
        name: 'cow',
        position: { x: 2, y: 64, z: 0 }, // dist = 2 <= 3.0
        health: 10,
        isValid: true,
      },
    },
    inventory: {
      items: () => [{ name: 'diamond_sword', type: 276 }],
      slots: [],
    },
    heldItem: null,
    async equip(item: any, slot: string) {
      equipCalls.push({ item, slot });
      fakeBot.heldItem = item;
    },
    lookAt: async () => {},
    attack(target: any) {
      attackCalls.push(target);
      target.health = 0; // kill on attack
    },
  };

  const hunting = createHunting(fakeBot, {
    onAnimalKilled: name => {
      killedAnimal = name;
    },
  });

  const request: ActionRequest = {
    nodeId: 'HuntAnimal',
    runId: 'hunt-run-1',
    actionType: 'HuntAnimal',
    targetId: 55,
    priority: 40,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {
      rallyX: 0,
      rallyY: 64,
      rallyZ: 0,
      maxRadius: 25,
      targetAnimal: 'cow',
    },
  };

  const board = createBlackboard('owner');
  const now = 1000;
  const world = createWorld('owner');
  world.self.isAlive = true;
  world.self.position = { x: 0, y: 64, z: 0 };
  world.inventory.bestWeapon = { itemId: 276, name: 'diamond_sword', attackDamage: 7 };
  board.setWorld(world);

  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 0,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => board.snapshot(now),
  };

  const adapter = hunting.huntAnimal(request);
  await adapter.start(ctx);

  assert.ok(goalSet !== null, 'Pathfinder goal should be set to approach animal');
  assert.equal(equipCalls.length, 1, 'Should auto-equip diamond_sword');
  assert.equal(equipCalls[0]?.item.name, 'diamond_sword');

  // Update tick performs attack
  adapter.update!(ctx);

  assert.equal(attackCalls.length, 1, 'Should attack cow when within 3.0 blocks');

  // Next tick detects target died
  const finishResult = adapter.update!(ctx);
  assert.equal(finishResult?.status, 'SUCCESS');
  assert.equal(killedAnimal, 'cow');
});

test('hunting adapter: aborts chase when animal flees beyond rally point radius', async () => {
  let escapedId: number | null = null;
  const fakeBot: any = {
    entity: { id: 1, position: { x: 20, y: 64, z: 0 } },
    pathfinder: { setGoal() {} },
    entities: {
      77: {
        id: 77,
        name: 'sheep',
        position: { x: 26, y: 64, z: 0 }, // dist from rally (0,0) is 26 > 25 maxRadius
        health: 8,
        isValid: true,
      },
    },
    inventory: { items: () => [], slots: [] },
  };

  const hunting = createHunting(fakeBot, {
    onAnimalEscaped: id => {
      escapedId = id;
    },
  });

  const request: ActionRequest = {
    nodeId: 'HuntAnimal',
    runId: 'hunt-escape-run',
    actionType: 'HuntAnimal',
    targetId: 77,
    priority: 40,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {
      rallyX: 0,
      rallyY: 64,
      rallyZ: 0,
      maxRadius: 25,
      targetAnimal: '',
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

  const adapter = hunting.huntAnimal(request);
  await adapter.start(ctx);
  const result = adapter.update!(ctx);

  assert.equal(escapedId, 77, 'Should trigger onAnimalEscaped for animal fleeing outside radius');
  assert.equal(result?.status, 'SUCCESS');
});

test('hunting adapter: cancel stops pathfinder and isStopped returns true', () => {
  let clearedGoal = false;
  const fakeBot: any = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setGoal(goal: any) {
        if (goal === null) clearedGoal = true;
      },
    },
    entities: {},
    inventory: { items: () => [] },
  };

  const hunting = createHunting(fakeBot);
  const request: ActionRequest = {
    nodeId: 'HuntAnimal',
    runId: 'hunt-cancel-run',
    actionType: 'HuntAnimal',
    targetId: 123,
    priority: 40,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
  };

  const adapter = hunting.huntAnimal(request);
  adapter.cancel();

  assert.equal(adapter.isStopped?.(), true);
  assert.equal(clearedGoal, true);
});

test('hunting priority: HuntAnimal priority is 40 and preempts EquipBest (15)', () => {
  assert.equal(calculateActionPriority('HuntAnimal'), 40);
  assert.equal(calculateActionPriority('EquipBest'), 15);
  assert.ok(
    calculateActionPriority('HuntAnimal') > calculateActionPriority('EquipBest'),
    'HuntAnimal must have higher priority than EquipBest during HUNT mode'
  );
  assert.ok(
    calculateActionPriority('Combat') > calculateActionPriority('HuntAnimal'),
    'Combat (80) must preempt HuntAnimal (40) when attacked'
  );
});
