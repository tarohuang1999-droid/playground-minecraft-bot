import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createPerception, isHostileMob, type PerceptionSource } from '../../src/perception.ts';
import { getCombatTarget } from '../../src/bt/subtrees/combat.ts';
import { createCombatAdapter } from '../../src/actions/combat.ts';
import { attachCompanion } from '../../src/bot.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';

test('isHostileMob: safely identifies hostiles and excludes players/animals [RULE-08]', () => {
  // 1. Hostile mobs
  assert.ok(isHostileMob({ name: 'zombie' }));
  assert.ok(isHostileMob({ name: 'skeleton' }));
  assert.ok(isHostileMob({ name: 'spider' }));
  assert.ok(isHostileMob({ name: 'creeper' }));
  assert.ok(isHostileMob({ name: 'drowned' }));

  // 2. Players must NEVER be classified as hostile mobs
  assert.strictEqual(isHostileMob({ name: 'player', type: 'player' }), false);
  assert.strictEqual(isHostileMob({ name: 'zombie', username: 'dakaz' }), false);
  assert.strictEqual(isHostileMob({ name: 'zombie', type: 'player' }), false);

  // 3. Neutral / passive mobs must not be classified as hostile
  assert.strictEqual(isHostileMob({ name: 'cow' }), false);
  assert.strictEqual(isHostileMob({ name: 'sheep' }), false);
  assert.strictEqual(isHostileMob({ name: 'pig' }), false);
  assert.strictEqual(isHostileMob({ name: 'chicken' }), false);
  assert.strictEqual(isHostileMob({ name: 'villager' }), false);
});

test('combat perception: detects hostile threats within combat range and tracks recent damage', () => {
  const fakeBot: PerceptionSource = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    players: { dakaz: { entity: { id: 2, position: { x: 3, y: 64, z: 0 } } } },
    entities: {
      '2': { id: 2, position: { x: 3, y: 64, z: 0 }, username: 'dakaz' },
      '10': { id: 10, position: { x: 5, y: 64, z: 0 }, name: 'zombie' }, // 5 blocks away (threat)
      '11': { id: 11, position: { x: 12, y: 64, z: 0 }, name: 'skeleton' }, // 12 blocks away (threat <= 16)
      '12': { id: 12, position: { x: 25, y: 64, z: 0 }, name: 'creeper' }, // 25 blocks away (> 16, excluded)
      '13': { id: 13, position: { x: 2, y: 64, z: 0 }, name: 'cow' }, // neutral, excluded
      '14': { id: 14, position: { x: 4, y: 64, z: 0 }, name: 'spider', health: 0 }, // dead, excluded
    },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    heldItem: null,
  };

  const perception = createPerception(fakeBot, 'dakaz');
  const world1 = perception.sample();

  assert.strictEqual(world1.threats.length, 2);
  assert.strictEqual(world1.threats[0]?.entityId, 10);
  assert.strictEqual(world1.threats[0]?.name, 'zombie');
  assert.strictEqual(world1.threats[1]?.entityId, 11);
  assert.strictEqual(world1.self.tookDamageRecently, false);

  // When health drops, tookDamageRecently becomes true
  fakeBot.health = 16;
  const world2 = perception.sample();
  assert.strictEqual(world2.self.health, 16);
  assert.strictEqual(world2.self.tookDamageRecently, true);
});

test('combat subtree: enters on threat <= 8 blocks, exhibits hysteresis, and disengages properly', () => {
  const available = new Set(['Combat', 'NormalFollow', 'CatchUpFollow', 'Idle']);
  const board = createBlackboard('dakaz');

  // Case 1: Threat at 9 blocks (> combatEnter 8) -> does NOT enter combat
  board.setIntent('FOLLOW', 1000);
  const worldNoCombat = createWorld('dakaz');
  worldNoCombat.self = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    isAlive: true,
    tookDamageRecently: false,
  };
  worldNoCombat.master = {
    username: 'dakaz',
    entityId: 2,
    position: { x: 2, y: 64, z: 0 },
    distance: 2,
  };
  worldNoCombat.threats = [
    { entityId: 10, name: 'zombie', position: { x: 9, y: 64, z: 0 }, distance: 9 },
  ];
  board.setWorld(worldNoCombat);

  let snap = board.snapshot(1000);
  assert.strictEqual(getCombatTarget(snap, available), null);

  // Case 2: Threat enters 6 blocks (<= combatEnter 8) -> enters combat
  const worldInCombat = structuredClone(worldNoCombat);
  worldInCombat.threats = [
    { entityId: 10, name: 'zombie', position: { x: 6, y: 64, z: 0 }, distance: 6 },
  ];
  board.setWorld(worldInCombat);
  snap = board.snapshot(1050);
  const target = getCombatTarget(snap, available);
  assert.strictEqual(target?.entityId, 10);

  // Case 3: Target retention with active combat run at 10 blocks (hysteresis: > 8 but <= 16)
  const runtimeWithCombat = structuredClone(snap.runtime);
  (runtimeWithCombat.activeRuns as any)['run-combat-1'] = {
    runId: 'run-combat-1',
    actionType: 'Combat',
    targetId: 10,
    startedAt: 1050,
    status: 'RUNNING',
  };
  board.setRuntime(runtimeWithCombat);
  const worldAt10 = structuredClone(worldInCombat);
  worldAt10.threats = [
    { entityId: 10, name: 'zombie', position: { x: 10, y: 64, z: 0 }, distance: 10 },
  ];
  board.setWorld(worldAt10);
  snap = board.snapshot(1100);
  assert.strictEqual(getCombatTarget(snap, available)?.entityId, 10);

  // Case 4: Target exceeds combatExit (17 > 16) -> disengages
  const worldAt17 = structuredClone(worldAt10);
  worldAt17.threats = [
    { entityId: 10, name: 'zombie', position: { x: 17, y: 64, z: 0 }, distance: 17 },
  ];
  board.setWorld(worldAt17);
  snap = board.snapshot(1150);
  assert.strictEqual(getCombatTarget(snap, available), null);

  // Case 5: In FOLLOW mode, master distance > 24 (combatMasterLimit) -> disengages to not lose master
  const worldMasterFar = structuredClone(worldAt10);
  worldMasterFar.master.distance = 25;
  board.setWorld(worldMasterFar);
  snap = board.snapshot(1200);
  assert.strictEqual(getCombatTarget(snap, available), null);
});

test('combat adapter: equips best weapon, chases target, looks and attacks within reach', async () => {
  let lookAtCalled = false;
  let attackCount = 0;
  let equippedItem: any = null;
  let currentGoal: any = null;

  const targetZombie = {
    id: 10,
    name: 'zombie',
    position: { x: 2, y: 64, z: 0 },
    height: 1.8,
    health: 20,
    isValid: true,
  };

  const bot: any = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: { 10: targetZombie },
    inventory: {
      items: () => [{ type: 100, name: 'iron_sword', id: 100 }],
      slots: [],
    },
    heldItem: null,
    pathfinder: {
      setGoal: (g: any) => {
        currentGoal = g;
      },
      movements: { canDig: true },
    },
    equip: async (item: any) => {
      equippedItem = item;
    },
    lookAt: async () => {
      lookAtCalled = true;
    },
    attack: () => {
      attackCount++;
    },
  };

  const adapterFactory = createCombatAdapter(bot);
  const request: ActionRequest = {
    nodeId: 'combat-1',
    runId: 'run-combat-1',
    actionType: 'Combat',
    targetId: 10,
    priority: 80,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
  };

  const adapter = adapterFactory(request);
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 1,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => ({
      world: {
        self: {
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          isAlive: true,
          tookDamageRecently: false,
        },
        master: { username: 'dakaz', entityId: 2, position: { x: 0, y: 64, z: 0 }, distance: 0 },
        base: null,
        spawnPoint: null,
        bedNeedsRefresh: false,
        nearbyBed: null,
        timeOfDay: 0,
        isRaining: false,
        isSleeping: false,
        entities: [],
        threats: [],
        nearbyDrops: [],
        inventory: {
          freeSlots: 10,
          bestFood: null,
          bestWeapon: { itemId: 100, name: 'iron_sword', attackDamage: 9 },
          equippedWeaponDamage: 0,
          pendingArmorUpgrade: null,
        },
      },
      intent: {
        mode: 'FOLLOW',
        canDig: false,
        allowBridge: false,
        missionId: 'm1',
        updatedAt: 0,
        intentRevision: 1,
      },
      runtime: { activeRuns: {}, results: {}, cooldowns: {}, lockedResources: {} as any },
      revision: 1,
      observedAt: Date.now(),
      generation: 1,
    }),
  };

  // 1. Start: equips iron_sword and sets GoalFollow
  await adapter.start(ctx);
  assert.strictEqual(equippedItem?.name, 'iron_sword');
  assert.ok(currentGoal !== null);
  assert.strictEqual(bot.pathfinder.movements.canDig, false);

  // 2. Update at distance 2 (<= 3.5): triggers lookAt and attack
  adapter.update!(ctx);
  // Give lookAt microtask a tick to execute
  await new Promise(r => setTimeout(r, 10));
  assert.ok(lookAtCalled);
  assert.strictEqual(attackCount, 1);

  // 3. Immediate subsequent update respects 550ms cooldown (does not attack again)
  adapter.update!(ctx);
  assert.strictEqual(attackCount, 1);

  // 4. Target eliminated check: target health drops to 0 -> returns SUCCESS and clears goal
  targetZombie.health = 0;
  const outcome = adapter.update!(ctx);
  assert.deepStrictEqual(outcome, { status: 'SUCCESS' });
  assert.strictEqual(currentGoal, null);
});

test('arbiter & preemption: Combat (80) immediately preempts RoutineEat (60) and Follow (20)', () => {
  const arbiter = createArbiter();

  const followReq: ActionRequest = {
    nodeId: 'follow',
    runId: 'run-follow',
    actionType: 'NormalFollow',
    targetId: 2,
    priority: 20,
    requiredResources: ['MOVE', 'LOOK'],
    params: {},
  };

  const eatReq: ActionRequest = {
    nodeId: 'eat',
    runId: 'run-eat',
    actionType: 'RoutineEat',
    targetId: null,
    priority: 60,
    requiredResources: ['HAND', 'INVENTORY'],
    params: {},
  };

  // Initial state: Follow (20) and RoutineEat (60) run concurrently on disjoint resources
  const initialWinners = arbiter.select([followReq, eatReq]);
  assert.strictEqual(initialWinners.length, 2);
  assert.ok(arbiter.acquire(followReq, 1));
  assert.ok(arbiter.acquire(eatReq, 2));

  // A hostile mob is encountered -> Combat (80) requests ALL 4 resources
  const combatReq: ActionRequest = {
    nodeId: 'combat',
    runId: 'run-combat',
    actionType: 'Combat',
    targetId: 10,
    priority: 80,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
  };

  // Arbiter evaluates: Combat (80) preempts both Follow (20) and RoutineEat (60)
  const preemptWinners = arbiter.select([combatReq, followReq, eatReq]);
  assert.strictEqual(preemptWinners.length, 1);
  assert.strictEqual(preemptWinners[0]?.actionType, 'Combat');
});

test('integration: Follow preempted by Combat on zombie spawn, auto-resumes Follow after zombie death', () => {
  class CompanionCombatBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    goalsSet: any[] = [];
    pathfinder = {
      setGoal: (goal: any, dynamic?: boolean) => {
        this.goalsSet.push({ goal, dynamic });
      },
      setMovements: (_m: any) => {},
    };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [{ type: 100, name: 'iron_sword', id: 100 }],
      slots: [],
    };
    heldItem: any = { name: 'iron_sword' };
    attacks: any[] = [];
    equipCalls: any[] = [];
    equip = async (item: any) => {
      this.equipCalls.push(item);
    };
    attack = (target: any) => {
      this.attacks.push(target);
    };
    lookAt = async () => {};
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new CompanionCombatBot();
  const ownerEntity = { id: 2, position: { x: 5, y: 64, z: 0 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Command: follow owner (distance is 5 > 2.2, so NormalFollow starts)
  bot.emit('chat', 'dakaz', '!follow');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().intent.mode, 'FOLLOW');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /NormalFollow/);
  assert.strictEqual(companion.snapshot().runtime.lockedResources.HAND, null);

  // Spawn hostile zombie at distance 4 (<= combatEnter 8)
  const zombie = {
    id: 10,
    name: 'zombie',
    position: { x: 4, y: 64, z: 0 },
    height: 1.8,
    health: 20,
    isValid: true,
  };
  bot.entities[10] = zombie;

  // Next physicsTick: Combat (80) preempts NormalFollow (20)
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);
  assert.match(companion.snapshot().runtime.lockedResources.HAND ?? '', /Combat/);
  assert.match(companion.snapshot().runtime.lockedResources.LOOK ?? '', /Combat/);
  assert.match(companion.snapshot().runtime.lockedResources.INVENTORY ?? '', /Combat/);

  // Kill zombie: health = 0 and removed from entities
  zombie.health = 0;
  delete bot.entities[10];

  // Next physicsTick: Combat finishes, Bot automatically resumes NormalFollow without manual intervention
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /NormalFollow/);
  assert.strictEqual(companion.snapshot().runtime.lockedResources.HAND, null);
});

test('perception: dynamic hostile targets tracks non-owner player for 30s and owner for 3s / 1 hit', () => {
  let currentTime = 10000;
  const fakeBot: PerceptionSource = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    players: { dakaz: { entity: { id: 2, position: { x: 3, y: 64, z: 0 } } } },
    entities: {
      '2': { id: 2, position: { x: 3, y: 64, z: 0 }, username: 'dakaz' },
      '50': { id: 50, position: { x: 4, y: 64, z: 0 }, username: 'stranger', type: 'player' },
    },
    inventory: { emptySlotCount: () => 10, items: () => [] },
    heldItem: null,
  };

  const perception = createPerception(fakeBot, 'dakaz', { now: () => currentTime });

  // Initially: neither player is a threat (isHostileMob returns false)
  let world = perception.sample();
  assert.strictEqual(world.threats.length, 0);

  // 1. Non-owner player attacks bot: 30s hostile
  perception.recordAttacker(
    { id: 50, username: 'stranger' },
    { durationMs: 30000, isOwner: false }
  );
  world = perception.sample();
  assert.strictEqual(world.threats.length, 1);
  assert.strictEqual(world.threats[0]?.entityId, 50);

  // After 29s: still a threat
  currentTime += 29000;
  world = perception.sample();
  assert.strictEqual(world.threats.length, 1);

  // After 31s total: expired
  currentTime += 2000;
  world = perception.sample();
  assert.strictEqual(world.threats.length, 0);

  // 2. Owner attacks bot: 3s hostile, maxHits = 1
  perception.recordAttacker(
    { id: 2, username: 'dakaz' },
    { durationMs: 3000, maxHits: 1, isOwner: true }
  );
  world = perception.sample();
  assert.strictEqual(world.threats.length, 1);
  assert.strictEqual(world.threats[0]?.entityId, 2);

  // After 1 hit: owner is immediately removed from threats
  perception.notifyAttack(2);
  world = perception.sample();
  assert.strictEqual(world.threats.length, 0);
});

test('integration: owner attack unfollows (intent -> STAY) and triggers 1 counter-attack hit, then stops', async () => {
  class OwnerCombatBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    goalsSet: any[] = [];
    pathfinder = {
      setGoal: (goal: any, dynamic?: boolean) => {
        this.goalsSet.push({ goal, dynamic });
      },
      setMovements: (_m: any) => {},
    };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [{ type: 100, name: 'diamond_sword', id: 100 }],
      slots: [],
    };
    heldItem: any = { name: 'diamond_sword' };
    attacks: any[] = [];
    equipCalls: any[] = [];
    equip = async (item: any) => {
      this.equipCalls.push(item);
    };
    attack = (target: any) => {
      this.attacks.push(target);
    };
    lookAt = async () => {};
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new OwnerCombatBot();
  const ownerEntity = {
    id: 2,
    position: { x: 2, y: 64, z: 0 },
    username: 'dakaz',
    height: 1.8,
    health: 20,
    isValid: true,
  };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Master commands: follow
  bot.emit('chat', 'dakaz', '!follow');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().intent.mode, 'FOLLOW');

  // Master hits the bot!
  bot.health = 18;
  bot.emit('entityHurt', bot.entity, ownerEntity);

  // Next tick processes enqueued intent and triggers Combat
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().intent.mode, 'STAY');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);

  // Allow equip async task to resolve and update tick to strike
  await Promise.resolve();
  bot.emit('physicsTick');

  // 3. Bot hits owner back once
  assert.strictEqual(bot.attacks.length, 1);
  assert.strictEqual(bot.attacks[0]?.id, 2);

  // 4. After 1 hit, owner is removed from threats, Combat finishes and bot remains in STAY mode
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
  assert.strictEqual(companion.snapshot().runtime.lockedResources.HAND, null);
  assert.strictEqual(companion.snapshot().intent.mode, 'STAY');
});

test('integration: non-owner attack triggers 30s hostile chase and exits on expiration', () => {
  let simulatedTime = 50000;
  class NonOwnerCombatBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    pathfinder = {
      setGoal: () => {},
      setMovements: () => {},
    };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [{ type: 100, name: 'iron_sword', id: 100 }],
      slots: [],
    };
    heldItem: any = { name: 'iron_sword' };
    attacks: any[] = [];
    equip = async () => {};
    attack = (target: any) => {
      this.attacks.push(target);
    };
    lookAt = async () => {};
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new NonOwnerCombatBot();
  const ownerEntity = { id: 2, position: { x: 5, y: 64, z: 0 }, username: 'dakaz' };
  const griefer = {
    id: 88,
    position: { x: 3, y: 64, z: 0 },
    username: 'griefer',
    type: 'player',
    height: 1.8,
    health: 20,
    isValid: true,
  };
  bot.entities[2] = ownerEntity;
  bot.entities[88] = griefer;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  // Griefer swings arm and damages bot (source passed)
  bot.emit('entityHurt', bot.entity, griefer);

  // Next ticks: Combat triggers targeting griefer
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);
  assert.ok(bot.attacks.length >= 1);
  assert.strictEqual(bot.attacks[0]?.id, 88);

  // Fast forward 31 seconds: hostility expires
  simulatedTime += 31000;
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Combat exits
  assert.strictEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
});

test('attacker inference: identifies attacker by recent arm swing when source is missing', () => {
  class ArmSwingBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    pathfinder = { setGoal: () => {}, setMovements: () => {} };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    attacks: any[] = [];
    equip = async () => {};
    attack = (t: any) => {
      this.attacks.push(t);
    };
    lookAt = async () => {};
    chat() {}
  }

  const bot = new ArmSwingBot();
  const playerA = {
    id: 5,
    position: { x: 2, y: 64, z: 0 },
    username: 'attacker_player',
    type: 'player',
    height: 1.8,
    health: 20,
    isValid: true,
  };
  bot.entities[5] = playerA;

  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Player swings arm at bot
  bot.emit('entitySwingArm', playerA);

  // Bot is hurt without source argument
  bot.emit('entityHurt', bot.entity);

  // Next ticks: Combat engages attacker_player
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);
  assert.ok(bot.attacks.length >= 1);
  assert.strictEqual(bot.attacks[0]?.id, 5);
});
