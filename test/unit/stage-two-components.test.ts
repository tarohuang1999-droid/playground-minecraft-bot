import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createCompanionTree } from '../../src/bt/companion-tree.ts';
import { parseCommand } from '../../src/commands.ts';
import { createPerception } from '../../src/perception.ts';
import { createChat } from '../../src/actions/chat.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';

test('only configured owner can issue exact supported commands', () => {
  assert.equal(parseCommand('owner', 'stranger', '!follow'), null);
  assert.deepEqual(parseCommand('owner', 'owner', '!follow somebody'), { type: 'unknown', raw: 'follow somebody' });
  assert.equal(parseCommand('owner', 'owner', '/kill'), null);
  assert.deepEqual(parseCommand('owner', 'owner', ' !Follow '), { type: 'intent', mode: 'FOLLOW' });
  assert.deepEqual(parseCommand('owner', 'owner', '!stop'), { type: 'intent', mode: 'STAY' });
  assert.deepEqual(parseCommand('owner', 'owner', '!status'), { type: 'status' });
});

test('perception copies plain positions, bounds observations, and handles invisible owner', () => {
  const owner = { id: 2, username: 'owner', position: { x: 10, y: 64, z: 0 } };
  const source = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } }, health: 18, food: 16,
    entities: { 2: owner, 3: { id: 3, name: 'zombie', position: { x: 100, y: 64, z: 0 } } },
    players: { owner: { entity: owner } }, inventory: { emptySlotCount: () => 12 },
  };
  const perception = createPerception(source, 'owner');
  const world = perception.sample();
  owner.position.x = 14;
  assert.equal(world.master.distance, 10);
  assert.equal(world.master.position?.x, 10);
  assert.equal(world.inventory.freeSlots, 12);
  assert.deepEqual(world.entities.map(entity => entity.entityId), [2]);
  assert.deepEqual(world.threats, []); // Classification belongs to Stage 4.
  const hidden = createPerception({ ...source, players: {} }, 'owner').sample();
  assert.equal(hidden.master.entityId, null);
  assert.equal(hidden.master.distance, Infinity);
});

test('Stage 2 defaults to Idle; explicitly enabled fake actions exercise composed subtrees', () => {
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.isAlive = true; world.self.health = 5; world.self.food = 4;
  world.master = { username: 'owner', entityId: 2, distance: 20, position: { x: 20, y: 0, z: 0 } };
  world.threats = [{ entityId: 3, name: 'zombie', distance: 2, position: { x: 2, y: 0, z: 0 } }];
  world.inventory.bestFood = { itemId: 1, name: 'bread', foodPoints: 5 };
  board.setWorld(world); board.setIntent('FOLLOW', 0);
  assert.deepEqual(createCompanionTree(new Set(['Idle'])).tick(board.snapshot(0)).requests.map(r => r.actionType), ['Idle']);
  const tree = createCompanionTree(new Set(['Idle', 'Retreat', 'Combat', 'EmergencyEat', 'NormalFollow', 'CatchUpFollow']));
  assert.deepEqual(tree.tick(board.snapshot(0)).requests.map(r => r.actionType), ['Retreat', 'EmergencyEat']);
  world.self.health = 20; world.self.food = 20; world.threats = [];
  board.setWorld(world);
  assert.equal(tree.tick(board.snapshot(1)).requests[0]?.actionType, 'CatchUpFollow');
  board.setIntent('STAY', 2);
  assert.equal(tree.tick(board.snapshot(2)).requests[0]?.actionType, 'Idle');
});

test('VOICE queue is bounded, ordered, rate limited and reset clears pending messages', () => {
  const sent: string[] = [];
  const chat = createChat(message => sent.push(message));
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), { Chat: chat.adapter });
  for (let i = 0; i < 5; i++) assert.equal(chat.enqueue(`message ${i}`), true);
  assert.equal(chat.enqueue('overflow'), false);
  function tick(time: number) {
    executor.advanceTick(); executor.flushResults(time); board.setRuntime(executor.runtime());
    const snapshot = board.snapshot(time);
    executor.reconcile(chat.requests(snapshot), snapshot, time);
  }
  tick(0); tick(100); tick(999);
  assert.deepEqual(sent, ['message 0']);
  tick(1000);
  assert.deepEqual(sent, ['message 0', 'message 1']);
  chat.reset(); tick(2000);
  assert.deepEqual(sent, ['message 0', 'message 1']);
});
