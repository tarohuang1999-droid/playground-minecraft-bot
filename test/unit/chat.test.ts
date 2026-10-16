import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard } from '../../src/blackboard.ts';
import { createChat } from '../../src/actions/chat.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';

test('VOICE queue is bounded, ordered, rate limited and reset clears pending messages', () => {
  const sent: string[] = [];
  const chat = createChat(message => sent.push(message));
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), { Chat: chat.adapter });
  for (let i = 0; i < 5; i++) assert.equal(chat.enqueue(`message ${i}`), true);
  assert.equal(chat.enqueue('overflow'), false);
  function tick(time: number) {
    executor.advanceTick();
    executor.flushResults(time);
    board.setRuntime(executor.runtime());
    const snapshot = board.snapshot(time);
    executor.reconcile(chat.requests(snapshot), snapshot, time);
  }
  tick(0);
  tick(100);
  tick(999);
  assert.deepEqual(sent, ['message 0']);
  tick(1000);
  assert.deepEqual(sent, ['message 0', 'message 1']);
  chat.reset();
  tick(2000);
  assert.deepEqual(sent, ['message 0', 'message 1']);
});
