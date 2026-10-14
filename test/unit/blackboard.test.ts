import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';

test('snapshots detach and deeply freeze nested input, preserving previous rounds', () => {
  const board = createBlackboard('owner');
  const world = createWorld('owner');
  world.self.health = 12;
  board.setWorld(world);
  const first = board.snapshot(10);
  world.self.health = 1;
  assert.equal(first.world.self.health, 12);
  assert.equal(Reflect.set(first.world.self, 'health', 0), false);
  board.setIntent('FOLLOW', 20);
  const second = board.snapshot(20);
  assert.equal(first.intent.mode, 'IDLE');
  assert.equal(second.intent.mode, 'FOLLOW');
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.intent.intentRevision, 1);
});
