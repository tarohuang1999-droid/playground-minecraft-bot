import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { attachCompanion } from '../../src/bot.ts';
import type { ActionContext } from '../../src/execution/types.ts';

class FakeBot extends EventEmitter {
  entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
  health = 20;
  food = 20;
  entities = {};
  players = { owner: { entity: { id: 2, position: { x: 10, y: 64, z: 0 } } } };
  inventory = { emptySlotCount: () => 36 };
  sent: string[] = [];
  chat(message: string) { this.sent.push(message); }
}

test('owner chat changes intent while missing body adapters stay Idle; detach removes listeners', () => {
  const bot = new FakeBot();
  const companion = attachCompanion(bot, 'owner');
  bot.emit('spawn');
  bot.emit('chat', 'stranger', '!follow');
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'IDLE');
  bot.emit('chat', 'owner', '!follow');
  bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'FOLLOW');
  assert.ok(Object.values(companion.snapshot().runtime.activeRuns).some(run => run.actionType === 'Idle'));
  bot.emit('whisper', 'owner', '!stop'); bot.emit('physicsTick');
  assert.equal(companion.snapshot().intent.mode, 'STAY');
  companion.dispose(); companion.dispose();
  assert.equal(bot.eventNames().length, 0);
});

test('death cancels active controls immediately; respawn is clean; end clears locks', () => {
  const bot = new FakeBot();
  let ctx!: ActionContext;
  let cancels = 0;
  const companion = attachCompanion(bot, 'owner', { adapters: { NormalFollow: () => ({
    start(context) { ctx = context; }, cancel() { cancels++; },
  }) } });
  bot.emit('spawn'); bot.emit('chat', 'owner', '!follow'); bot.emit('physicsTick');
  assert.notEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
  assert.equal(ctx.isActive(), true);
  bot.emit('death');
  assert.equal(cancels, 1);
  assert.equal(ctx.isActive(), false);
  assert.equal(companion.snapshot().generation, 1);
  assert.deepEqual(companion.snapshot().runtime.activeRuns, {});
  assert.ok(Object.values(companion.snapshot().runtime.lockedResources).every(owner => owner === null));
  bot.emit('physicsTick');
  assert.deepEqual(companion.snapshot().runtime.activeRuns, {});
  bot.emit('respawn'); bot.emit('spawn'); bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal(ctx.isActive(), true); // New run from preserved user intent, not old runtime.
  bot.emit('end');
  assert.equal(ctx.isActive(), false);
  assert.equal(companion.snapshot().generation, 2);
  companion.dispose();
});
