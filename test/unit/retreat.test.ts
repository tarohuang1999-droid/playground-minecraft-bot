import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createNavigation, findSafestEscapePosition } from '../../src/actions/navigation.ts';
import { shouldExitRetreat, shouldRetreat, survivalSubtree } from '../../src/bt/subtrees/survival.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import { attachCompanion } from '../../src/bot.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';
import { THRESHOLDS } from '../../src/policy.ts';

test('findSafestEscapePosition: chooses position in direction with fewest enemies in area', () => {
  const fakeBot: any = {
    blockAt: () => null,
  };

  const origin = { x: 0, y: 64, z: 0 };

  // Enemies are concentrated on the East (+X) side
  const threats = [
    { position: { x: 5, y: 64, z: 0 } },
    { position: { x: 7, y: 64, z: 2 } },
    { position: { x: 6, y: 64, z: -2 } },
  ];

  // Candidates sampled at radius 12
  const escapePos = findSafestEscapePosition(fakeBot, threats, origin, { radius: 12, dangerRadius: 10, angleCount: 16 });

  // Escape direction should be on the West (-X) side, far away from all 3 enemies
  assert.ok(escapePos.x < -8, `Expected escape position to be on West side (x < -8), got x=${escapePos.x}`);
});

test('findSafestEscapePosition: avoids terrain hazards (lava)', () => {
  const origin = { x: 0, y: 64, z: 0 };
  const threats = [
    { position: { x: 5, y: 64, z: 0 } }, // Threat is East (+X)
  ];

  // Pretend West (-X) has lava
  const fakeBot: any = {
    blockAt: (pos: any) => {
      if (pos.y < 64) {
        if (pos.x < 0) return { name: 'lava', boundingBox: 'block' };
        return { name: 'stone', boundingBox: 'block' };
      }
      return { name: 'air', boundingBox: 'empty' };
    },
  };

  const escapePos = findSafestEscapePosition(fakeBot, threats, origin, { radius: 12, dangerRadius: 10, angleCount: 16 });

  // West has lava, so it must not pick x < 0 despite threats being at +X
  assert.ok(escapePos.x >= 0, `Expected escape position to avoid lava at x < 0, got x=${escapePos.x}`);
});

test('shouldRetreat: triggers on low health OR when swarmed by too many mobs', () => {
  const available = new Set(['Retreat', 'Combat', 'NormalFollow', 'Idle']);
  const board = createBlackboard('dakaz');

  // Case 1: Full health (20), 1 threat at distance 5 -> should NOT retreat
  const worldSingleThreat = createWorld('dakaz');
  worldSingleThreat.self = { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, isAlive: true, tookDamageRecently: false };
  worldSingleThreat.threats = [{ entityId: 10, name: 'zombie', position: { x: 5, y: 64, z: 0 }, distance: 5 }];
  board.setWorld(worldSingleThreat);
  let snap = board.snapshot(1000);
  assert.strictEqual(shouldRetreat(snap, available), false);

  // Case 2: Low health (HP = 4 <= 6), 1 threat at distance 5 -> triggers retreat!
  const worldLowHealth = structuredClone(worldSingleThreat);
  worldLowHealth.self.health = 4;
  board.setWorld(worldLowHealth);
  snap = board.snapshot(1050);
  assert.strictEqual(shouldRetreat(snap, available), true);

  // Case 3: Full health (20), but swarmed by 3 mobs within 12 blocks -> triggers retreat!
  const worldSwarmed = structuredClone(worldSingleThreat);
  worldSwarmed.self.health = 20;
  worldSwarmed.threats = [
    { entityId: 10, name: 'zombie', position: { x: 5, y: 64, z: 0 }, distance: 5 },
    { entityId: 11, name: 'skeleton', position: { x: 6, y: 64, z: 2 }, distance: 6.3 },
    { entityId: 12, name: 'spider', position: { x: 7, y: 64, z: -1 }, distance: 7.1 },
  ];
  board.setWorld(worldSwarmed);
  snap = board.snapshot(1100);
  assert.strictEqual(shouldRetreat(snap, available), true);

  // Case 4: Mobs are outside retreatEnter (> 12 blocks) -> does NOT retreat
  const worldDistantMobs = structuredClone(worldSwarmed);
  worldDistantMobs.threats = [
    { entityId: 10, name: 'zombie', position: { x: 14, y: 64, z: 0 }, distance: 14 },
    { entityId: 11, name: 'skeleton', position: { x: 15, y: 64, z: 0 }, distance: 15 },
    { entityId: 12, name: 'spider', position: { x: 16, y: 64, z: 0 }, distance: 16 },
  ];
  board.setWorld(worldDistantMobs);
  snap = board.snapshot(1150);
  assert.strictEqual(shouldRetreat(snap, available), false);
});

test('shouldExitRetreat: maintains hysteresis and does not exit until threats >= 18 blocks or recovered', () => {
  const available = new Set(['Retreat', 'Combat', 'NormalFollow', 'Idle']);
  const board = createBlackboard('dakaz');

  // Entered retreat with HP = 4. Threats now at distance 14 (between 12 and 18 blocks)
  const worldRetreating = createWorld('dakaz');
  worldRetreating.self = { position: { x: 0, y: 64, z: 0 }, health: 4, food: 20, isAlive: true, tookDamageRecently: false };
  worldRetreating.threats = [{ entityId: 10, name: 'zombie', position: { x: 14, y: 64, z: 0 }, distance: 14 }];
  board.setWorld(worldRetreating);
  let snap = board.snapshot(1000);

  // Hysteresis: must NOT exit retreat at 14 blocks while HP is still 4
  assert.strictEqual(shouldExitRetreat(snap, available), false);

  // Threat reaches safe distance (19 >= 18 blocks) -> exits retreat!
  worldRetreating.threats[0]!.distance = 19;
  board.setWorld(worldRetreating);
  snap = board.snapshot(1050);
  assert.strictEqual(shouldExitRetreat(snap, available), true);

  // Alternatively: health recovered to 12 (>= 10) while threat is at 14 blocks (not swarmed) -> exits retreat!
  worldRetreating.threats[0]!.distance = 14;
  worldRetreating.self.health = 12;
  board.setWorld(worldRetreating);
  snap = board.snapshot(1100);
  assert.strictEqual(shouldExitRetreat(snap, available), true);
});

test('arbiter & preemption: Retreat (100) and EmergencyEat (90) preempt Combat (80)', () => {
  const arbiter = createArbiter();

  const combatReq: ActionRequest = {
    nodeId: 'combat',
    runId: 'run-combat',
    actionType: 'Combat',
    targetId: 10,
    priority: 80,
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
    params: {},
  };

  // 1. Initial state: Combat is active holding all 4 channels
  const initialWinners = arbiter.select([combatReq]);
  assert.strictEqual(initialWinners.length, 1);
  assert.ok(arbiter.acquire(combatReq, 1));

  // 2. Bot health drops to critical level -> Retreat (100) and EmergencyEat (90) requested
  const retreatReq: ActionRequest = {
    nodeId: 'retreat',
    runId: 'run-retreat',
    actionType: 'Retreat',
    targetId: null,
    priority: 100,
    requiredResources: ['MOVE', 'LOOK'],
    params: {},
  };

  const emergencyEatReq: ActionRequest = {
    nodeId: 'emergency-eat',
    runId: 'run-eat',
    actionType: 'EmergencyEat',
    targetId: null,
    priority: 90,
    requiredResources: ['HAND', 'INVENTORY'],
    params: {},
  };

  // Arbiter evaluates:
  // - Retreat (100) takes MOVE, LOOK
  // - EmergencyEat (90) takes HAND, INVENTORY
  // - Combat (80) loses its channels and is dropped!
  const preemptWinners = arbiter.select([retreatReq, emergencyEatReq, combatReq]);
  assert.strictEqual(preemptWinners.length, 2);
  const winnerTypes = preemptWinners.map(w => w.actionType);
  assert.ok(winnerTypes.includes('Retreat'));
  assert.ok(winnerTypes.includes('EmergencyEat'));
  assert.strictEqual(winnerTypes.includes('Combat'), false);
});

test('integration: in Combat, critical HP triggers Retreat + EmergencyEat, cancels attack and flees', () => {
  class CompanionRetreatBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 10;
    goalsSet: any[] = [];
    pathfinder = {
      setGoal: (goal: any, dynamic?: boolean) => { this.goalsSet.push({ goal, dynamic }); },
      setMovements: (_m: any) => {},
    };
    entities: Record<number, any> = {};
    players: Record<string, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [
        { type: 100, name: 'iron_sword', id: 100 },
        { type: 200, name: 'cooked_beef', id: 200 },
      ],
      slots: [],
    };
    heldItem: any = { name: 'iron_sword' };
    attacks: any[] = [];
    equipCalls: any[] = [];
    consumeCalls = 0;
    equip = async (item: any) => { this.equipCalls.push(item); };
    consume = async () => { this.consumeCalls++; };
    deactivateItem = () => {};
    attack = (target: any) => { this.attacks.push(target); };
    lookAt = async () => {};
    chat = () => {};
  }

  const bot = new CompanionRetreatBot();
  const ownerEntity = { id: 2, position: { x: 0, y: 64, z: 0 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  // Zombie at distance 4
  const zombie = { id: 10, name: 'zombie', position: { x: 4, y: 64, z: 0 }, height: 1.8, health: 20, isValid: true };
  bot.entities[10] = zombie;

  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Start in FOLLOW mode
  bot.emit('chat', 'dakaz', '!follow');
  bot.emit('physicsTick'); bot.emit('physicsTick');

  // Zombie is detected -> Combat engages
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);
  assert.match(companion.snapshot().runtime.lockedResources.HAND ?? '', /Combat/);

  // Bot health drops to critical level (HP = 4 <= 6)
  bot.health = 4;
  bot.emit('entityHurt', bot.entity);
  bot.emit('physicsTick'); bot.emit('physicsTick');

  // Verification: Combat is cancelled!
  // MOVE, LOOK acquired by Retreat
  // HAND, INVENTORY acquired by EmergencyEat
  const locked = companion.snapshot().runtime.lockedResources;
  assert.match(locked.MOVE ?? '', /Retreat/);
  assert.match(locked.LOOK ?? '', /Retreat/);
  assert.match(locked.HAND ?? '', /emergency-eat|EmergencyEat/i);
  assert.match(locked.INVENTORY ?? '', /emergency-eat|EmergencyEat/i);

  const activeActions = Object.values(companion.snapshot().runtime.activeRuns).map(r => r.actionType);
  assert.ok(activeActions.includes('Retreat'));
  assert.ok(activeActions.includes('EmergencyEat'));
  assert.strictEqual(activeActions.includes('Combat'), false);
});

test('retreat adapter: aborts with FAILURE when trapped/stalled for > 3.5s allowing defense', async () => {
  const bot: any = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setGoal: () => {},
      isMoving: () => false, // pathfinder is idle / cannot find path
    },
    setControlState: () => {},
  };

  const nav = createNavigation(bot);
  const request: ActionRequest = {
    nodeId: 'retreat',
    runId: 'run-retreat-1',
    actionType: 'Retreat',
    targetId: null,
    priority: 100,
    requiredResources: ['MOVE', 'LOOK'],
    params: {},
  };

  const adapter = nav.retreat(request);
  const ctx: ActionContext = {
    request,
    token: 1,
    generation: 1,
    signal: new AbortController().signal,
    isActive: () => true,
    getSnapshot: () => ({
      world: {
        self: { position: { x: 0, y: 64, z: 0 }, health: 4, food: 20, isAlive: true, tookDamageRecently: true },
        master: { username: 'dakaz', entityId: 2, position: { x: 0, y: 64, z: 0 }, distance: 0 },
        base: null,
        spawnPoint: null,
        entities: [],
        threats: [{ entityId: 10, name: 'zombie', position: { x: 3, y: 64, z: 0 }, distance: 3 }],
        nearbyDrops: [],
        inventory: { freeSlots: 10, bestFood: null, bestWeapon: null, equippedWeaponDamage: 0, pendingArmorUpgrade: null },
      },
      intent: { mode: 'FOLLOW', updatedAt: 0, intentRevision: 1 },
      runtime: { activeRuns: {}, results: {}, cooldowns: {}, lockedResources: {} as any },
      revision: 1,
      observedAt: Date.now(),
      generation: 1,
    }),
  };

  adapter.start(ctx);

  // Fast forward time > 3600ms without progress
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 4000;
    const outcome = adapter.update!(ctx);
    assert.deepStrictEqual(outcome, { status: 'FAILURE', reason: 'Retreat path trapped or obstructed' });
  } finally {
    Date.now = originalNow;
  }
});
