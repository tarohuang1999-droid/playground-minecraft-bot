import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard, createWorld } from '../../src/blackboard.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import { createRunner } from '../../src/bt/runner.ts';
import { createTree, action, reactiveSelector, guard } from '../../src/bt/nodes.ts';

const idle = () => action('idle', () => ({ actionType: 'Idle', targetId: null, params: {} }));

test('mid-decision events wait for the next snapshot and urgent ticks never re-enter', () => {
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), { Idle: () => ({ start() {}, cancel() {} }) });
  const pending: Array<() => void> = [];
  const modes: string[] = [];
  let depth = 0;
  const runner = createRunner({
    board,
    executor,
    tree: {
      halt() {},
      tick(snapshot) {
        assert.equal(++depth, 1);
        modes.push(snapshot.intent.mode);
        if (modes.length === 1) {
          runner.enqueue({ type: 'intent', mode: 'FOLLOW' });
          runner.requestUrgentTick();
          assert.equal(snapshot.intent.mode, 'IDLE');
        }
        depth--;
        return { status: 'RUNNING', requests: [] };
      },
    },
    schedule: callback => pending.push(callback),
    now: () => 100,
  });
  runner.resume();
  runner.physicsTick();
  assert.deepEqual(modes, []);
  runner.physicsTick();
  assert.deepEqual(modes, ['IDLE']);
  pending.shift()!();
  assert.deepEqual(modes, ['IDLE', 'FOLLOW']);
});

test('one-tick fence wakes a fresh decision on the odd tick and respects withdrawn intent', () => {
  const started: string[] = [];
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), {
    NormalFollow: () => ({
      start() {
        started.push('follow');
      },
      cancel() {},
    }),
    Combat: () => ({
      start() {
        started.push('combat');
      },
      cancel() {},
    }),
    Idle: () => ({ start() {}, cancel() {} }),
  });
  const tree = createTree(
    reactiveSelector('root', [
      guard(
        'danger',
        s => s.world.self.health < 10,
        action('combat', () => ({ actionType: 'Combat', targetId: 1, params: {} }))
      ),
      guard(
        'follow',
        s => s.intent.mode === 'FOLLOW',
        action('walk', () => ({ actionType: 'NormalFollow', targetId: 2, params: {} }))
      ),
      idle(),
    ])
  );
  const runner = createRunner({ board, executor, tree });
  runner.resume();
  runner.enqueue({ type: 'intent', mode: 'FOLLOW' });
  runner.physicsTick();
  runner.physicsTick();
  const world = createWorld('owner');
  world.self.health = 5;
  runner.enqueue({ type: 'world', world });
  runner.physicsTick();
  runner.physicsTick();
  assert.deepEqual(started, ['follow']);
  runner.physicsTick(); // fence expires on an odd physics tick
  assert.deepEqual(started, ['follow', 'combat']);
  world.self.health = 20;
  runner.enqueue({ type: 'world', world });
  runner.physicsTick(); // cancel combat, follow is waiting
  runner.enqueue({ type: 'intent', mode: 'STAY' });
  runner.physicsTick(); // never restart the withdrawn follow request
  assert.deepEqual(started, ['follow', 'combat']);
});

test('pause invalidates sessions, cancels runs and clears queued world events', () => {
  let cancelled = 0;
  const board = createBlackboard('owner');
  const executor = createExecutor(createArbiter(), {
    Idle: () => ({
      start() {},
      cancel() {
        cancelled++;
      },
    }),
  });
  const runner = createRunner({ board, executor, tree: createTree(idle()) });
  runner.resume();
  runner.physicsTick();
  runner.physicsTick();
  const world = createWorld('owner');
  world.self.health = 3;
  runner.enqueue({ type: 'world', world });
  runner.pause();
  assert.equal(cancelled, 1);
  assert.equal(runner.snapshot().generation, 1);
  assert.deepEqual(runner.snapshot().runtime.activeRuns, {});
  assert.ok(
    Object.values(runner.snapshot().runtime.lockedResources).every(value => value === null)
  );
  runner.resume();
  runner.physicsTick();
  runner.physicsTick();
  assert.equal(runner.snapshot().world.self.health, 20);
});
