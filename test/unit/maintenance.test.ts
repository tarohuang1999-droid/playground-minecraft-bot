import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createPerception, type PerceptionSource } from '../../src/perception.ts';
import { createInventoryAdapters } from '../../src/actions/inventory.ts';
import { createNavigation } from '../../src/actions/navigation.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import type { ActionContext, ActionRequest } from '../../src/execution/types.ts';

test('inventory perception: scores best food, armor upgrades, and weapons correctly', () => {
  const fakeBot: PerceptionSource = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 18,
    food: 12,
    players: {},
    entities: {},
    inventory: {
      emptySlotCount: () => 10,
      items: () => [
        { type: 101, name: 'apple', slot: 20 },
        { type: 102, name: 'cooked_beef', slot: 21 },
        { type: 103, name: 'rotten_flesh', slot: 22 }, // harmful, must be ignored
        { type: 201, name: 'iron_chestplate', slot: 25 },
        { type: 202, name: 'diamond_chestplate', slot: 26 },
        { type: 301, name: 'iron_sword', slot: 27 },
      ],
      slots: [
        null, null, null, null, null,
        null, // slot 5 head
        { type: 200, name: 'leather_chestplate', slot: 6 }, // slot 6 torso
        null, // slot 7 legs
        null, // slot 8 feet
      ],
    },
    heldItem: null,
  };

  const perception = createPerception(fakeBot, 'dakaz');
  const world = perception.sample();

  // 1. Food: cooked_beef (12 pts) beats apple (4 pts), rotten_flesh excluded
  assert.equal(world.inventory.bestFood?.name, 'cooked_beef');
  assert.equal(world.inventory.bestFood?.foodPoints, 12);

  // 2. Armor: diamond_chestplate (tier 5) beats leather_chestplate (tier 1) and iron_chestplate (tier 4)
  assert.equal(world.inventory.pendingArmorUpgrade?.slot, 'torso');
  assert.equal(world.inventory.pendingArmorUpgrade?.itemId, 202);

  // 3. Weapon: iron_sword
  assert.equal(world.inventory.bestWeapon?.name, 'iron_sword');
  assert.ok(world.inventory.bestWeapon?.attackDamage! > 0);
});

test('maintenance subtree: RoutineEat triggers when food <= 16, EmergencyEat when health <= 10 or food <= 6', () => {
  const available = new Set(['NormalFollow', 'RoutineEat', 'EmergencyEat', 'EquipBest', 'Idle']);
  const tree = createCompanionTree(available);
  const board = createBlackboard('dakaz');

  // Case 1: Routine food (food = 14, health = 20)
  const world = createWorld('dakaz');
  world.self.isAlive = true;
  world.self.food = 14;
  world.self.health = 20;
  world.inventory.bestFood = { itemId: 102, name: 'cooked_beef', foodPoints: 12 };
  board.setWorld(world);

  let snapshot = board.snapshot(100);
  let res = tree.tick(snapshot);
  let eatReq = res.requests.find(r => r.actionType === 'RoutineEat');
  assert.ok(eatReq, 'RoutineEat should be triggered when food <= 16');
  assert.equal(eatReq?.priority, 60);

  // Case 2: Emergency food (food = 14, health = 8)
  world.self.health = 8;
  board.setWorld(world);
  snapshot = board.snapshot(200);
  res = tree.tick(snapshot);
  let emergencyReq = res.requests.find(r => r.actionType === 'EmergencyEat');
  assert.ok(emergencyReq, 'EmergencyEat should take precedence when health <= 10');
  assert.equal(emergencyReq?.priority, 90);

  // Case 3: Full food (food = 20, health = 20) -> no eat
  world.self.food = 20;
  world.self.health = 20;
  board.setWorld(world);
  snapshot = board.snapshot(300);
  res = tree.tick(snapshot);
  assert.equal(res.requests.some(r => r.actionType === 'RoutineEat' || r.actionType === 'EmergencyEat'), false);
});

test('dual-channel blending: Follow (MOVE, LOOK) and RoutineEat (HAND, INVENTORY) execute in parallel without conflict', () => {
  const arbiter = createArbiter();
  const board = createBlackboard('dakaz');

  // Both actions requested at once
  const followReq: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-follow', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };
  const eatReq: ActionRequest = {
    nodeId: 'RoutineEat', runId: 'run-eat', actionType: 'RoutineEat',
    targetId: null, priority: 60, requiredResources: ['HAND', 'INVENTORY'], params: {},
  };

  const winners = arbiter.select([followReq, eatReq]);
  assert.equal(winners.length, 2, 'Both disjoint actions must win simultaneously');

  const winnerTypes = new Set(winners.map(w => w.actionType));
  assert.ok(winnerTypes.has('NormalFollow'));
  assert.ok(winnerTypes.has('RoutineEat'));
});

test('static capability contract: navigation does not dynamically toggle canDig on HAND locking', () => {
  const fakeBot: any = {
    pathfinder: {
      setGoal() {},
      movements: { canDig: false },
    },
    entities: { 2: { id: 2, position: { x: 5, y: 64, z: 0 } } },
    players: { dakaz: { entity: { id: 2, position: { x: 5, y: 64, z: 0 } } } },
  };

  const nav = createNavigation(fakeBot);
  const board = createBlackboard('dakaz');
  const world = createWorld('dakaz');
  world.self.position = { x: 0, y: 64, z: 0 };
  world.master = { username: 'dakaz', entityId: 2, position: { x: 5, y: 64, z: 0 }, distance: 5 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'NormalFollow', runId: 'run-f1', actionType: 'NormalFollow',
    targetId: 2, priority: 20, requiredResources: ['MOVE', 'LOOK'], params: {},
  };

  let active = true;
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => active,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = nav.normalFollow(request);

  // 1. HAND is free -> canDig remains false (does not auto-enable)
  board.setRuntime({
    activeRuns: {}, results: {}, cooldowns: {},
    lockedResources: { MOVE: 'run-f1', LOOK: 'run-f1', HAND: null, INVENTORY: null, VOICE: null },
  });
  adapter.start(ctx);
  assert.equal(fakeBot.pathfinder.movements.canDig, false);

  // 2. HAND gets locked (e.g. RoutineEat running) -> canDig remains false
  board.setRuntime({
    activeRuns: {}, results: {}, cooldowns: {},
    lockedResources: { MOVE: 'run-f1', LOOK: 'run-f1', HAND: 'run-eat-1', INVENTORY: 'run-eat-1', VOICE: null },
  });
  adapter.update!(ctx);
  assert.equal(fakeBot.pathfinder.movements.canDig, false);

  // 3. HAND unlocked again -> canDig remains false
  board.setRuntime({
    activeRuns: {}, results: {}, cooldowns: {},
    lockedResources: { MOVE: 'run-f1', LOOK: 'run-f1', HAND: null, INVENTORY: null, VOICE: null },
  });
  adapter.update!(ctx);
  assert.equal(fakeBot.pathfinder.movements.canDig, false);
});

test('inventory adapter: RoutineEat equips food to hand and calls consume', async () => {
  const equipCalls: Array<{ item: any; dest: string }> = [];
  let consumed = false;
  let deactivated = false;

  const fakeBot = {
    equip(item: any, dest: string) { equipCalls.push({ item, dest }); return Promise.resolve(); },
    consume() { consumed = true; return Promise.resolve(); },
    deactivateItem() { deactivated = true; },
    inventory: {
      items: () => [{ type: 10, name: 'bread', slot: 20 }],
      slots: [],
    },
  };

  const adapters = createInventoryAdapters(fakeBot as any);
  const board = createBlackboard('dakaz');
  const world = createWorld('dakaz');
  world.inventory.bestFood = { itemId: 10, name: 'bread', foodPoints: 8 };
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'RoutineEat', runId: 'run-eat', actionType: 'RoutineEat',
    targetId: null, priority: 60, requiredResources: ['HAND', 'INVENTORY'], params: {},
  };

  let active = true;
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => active,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = adapters.routineEat(request);
  const result = await adapter.start(ctx);

  assert.deepEqual(result, { status: 'SUCCESS' });
  assert.equal(equipCalls.length, 1);
  assert.equal(equipCalls[0]?.dest, 'hand');
  assert.equal(equipCalls[0]?.item.name, 'bread');
  assert.equal(consumed, true);

  // Cancel calls deactivateItem
  adapter.cancel();
  assert.equal(deactivated, false); // Not consuming at the moment of cancel
});

test('inventory adapter: EquipBest equips armor upgrades and best weapon', async () => {
  const equipCalls: Array<{ item: any; dest: string }> = [];

  const fakeBot = {
    equip(item: any, dest: string) { equipCalls.push({ item, dest }); return Promise.resolve(); },
    consume() { return Promise.resolve(); },
    inventory: {
      items: () => [
        { type: 202, name: 'iron_chestplate', slot: 20 },
        { type: 203, name: 'diamond_helmet', slot: 21 },
        { type: 301, name: 'diamond_sword', slot: 22 },
      ],
      slots: [
        null, null, null, null, null,
        null, // slot 5 head
        { type: 200, name: 'leather_chestplate', slot: 6 }, // slot 6 torso
        null, // slot 7 legs
        null, // slot 8 feet
      ],
    },
  };

  const adapters = createInventoryAdapters(fakeBot as any);
  const board = createBlackboard('dakaz');
  const world = createWorld('dakaz');
  world.inventory.pendingArmorUpgrade = { itemId: 202, slot: 'torso' };
  world.inventory.bestWeapon = { itemId: 301, name: 'diamond_sword', attackDamage: 11 };
  world.inventory.equippedWeaponDamage = 0;
  board.setWorld(world);

  const request: ActionRequest = {
    nodeId: 'EquipBest', runId: 'run-equip', actionType: 'EquipBest',
    targetId: null, priority: 50, requiredResources: ['HAND', 'INVENTORY'], params: {},
  };

  let active = true;
  const ctx: ActionContext = {
    request, token: 1, generation: 0, signal: new AbortController().signal,
    isActive: () => active,
    getSnapshot: () => board.snapshot(0),
  };

  const adapter = adapters.equipBest(request);
  const result = await adapter.start(ctx);

  assert.deepEqual(result, { status: 'SUCCESS' });
  const equippedDestinations = equipCalls.map(c => c.dest);
  assert.ok(equippedDestinations.includes('head'), 'Diamond helmet equipped to head');
  assert.ok(equippedDestinations.includes('torso'), 'Iron chestplate equipped to torso');
  assert.ok(equippedDestinations.includes('hand'), 'Diamond sword equipped to hand');
});
