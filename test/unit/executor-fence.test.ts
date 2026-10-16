import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard } from '../../src/blackboard.ts';
import { createArbiter } from '../../src/execution/arbiter.ts';
import { createExecutor } from '../../src/execution/executor.ts';
import type { ActionContext, ActionRequest, ActionResult } from '../../src/execution/types.ts';

const req = (id: string, priority: number): ActionRequest => ({
  nodeId: id,
  runId: id,
  actionType: 'Idle',
  targetId: null,
  priority,
  requiredResources: ['HAND'],
  params: {},
});
const snapshot = () => createBlackboard('owner').snapshot(0);

test('one physics tick hands off despite a pending promise; stale continuation cannot act', async () => {
  let resolve!: (result: ActionResult) => void;
  let oldContext!: ActionContext;
  let effects = 0;
  const started: string[] = [];
  const cancelled: string[] = [];
  const executor = createExecutor(createArbiter(), {
    Idle: request => ({
      start(ctx) {
        started.push(request.runId);
        if (request.runId !== 'old') return;
        oldContext = ctx;
        return new Promise<ActionResult>(done => {
          resolve = done;
        }).then(result => {
          if (!ctx.isActive()) return;
          effects++;
          return result;
        });
      },
      cancel() {
        cancelled.push(request.runId);
      },
    }),
  });
  executor.reconcile([req('old', 20)], snapshot(), 0);
  executor.reconcile([req('new', 80)], snapshot(), 0);
  assert.deepEqual(started, ['old']);
  assert.deepEqual(cancelled, ['old']);
  assert.equal(oldContext.isActive(), false);
  executor.advanceTick();
  executor.reconcile([req('new', 80)], snapshot(), 50);
  assert.deepEqual(started, ['old', 'new']);
  resolve({ status: 'FAILURE' });
  await Promise.resolve();
  await Promise.resolve();
  executor.flushResults(60);
  assert.equal(effects, 0);
  assert.equal(executor.runtime().lockedResources.HAND, 'new');
  assert.equal(executor.runtime().results.old, undefined);
});

test('withdrawn waiting requests never start and reset invalidates the entire session', () => {
  const started: string[] = [];
  const contexts: ActionContext[] = [];
  const executor = createExecutor(createArbiter(), {
    Idle: request => ({
      start(ctx) {
        contexts.push(ctx);
        started.push(request.runId);
      },
      cancel() {},
    }),
  });
  executor.reconcile([req('old', 10)], snapshot(), 0);
  executor.reconcile([req('waiting', 80)], snapshot(), 0);
  executor.advanceTick();
  executor.reconcile([], snapshot(), 50);
  assert.deepEqual(started, ['old']);
  executor.reconcile([req('current', 20)], snapshot(), 50);
  executor.reset();
  assert.equal(executor.generation(), 1);
  assert.equal(
    contexts.every(ctx => !ctx.isActive()),
    true
  );
  assert.equal(executor.runtime().lockedResources.HAND, null);
});

test('cancel errors never silently release controls to another action', () => {
  const executor = createExecutor(createArbiter(), {
    Idle: () => ({
      start() {},
      cancel() {
        throw new Error('cannot stop');
      },
    }),
  });
  executor.reconcile([req('old', 10)], snapshot(), 0);
  executor.reconcile([req('new', 80)], snapshot(), 0);
  executor.advanceTick();
  executor.reconcile([req('new', 80)], snapshot(), 50);
  assert.equal(executor.runtime().lockedResources.HAND, 'old');
  assert.match(executor.fault() ?? '', /cannot stop/);
});

test('a session reset during start prevents remaining winners from the old round starting', () => {
  const started: string[] = [];
  const executor = createExecutor(createArbiter(), {
    Idle: request => ({
      start() {
        started.push(request.runId);
        executor.reset();
      },
      cancel() {},
    }),
  });
  executor.reconcile(
    [
      { ...req('first', 20), requiredResources: ['MOVE'] },
      { ...req('second', 10), requiredResources: ['HAND'] },
    ],
    snapshot(),
    0
  );
  assert.deepEqual(started, ['first']);
  executor.reconcile([req('stale', 10)], snapshot(), 50);
  assert.deepEqual(started, ['first']);
});

test('partial preemption stops the whole combat run before retreat and eating acquire disjoint groups', () => {
  let stopped = 0;
  const started: string[] = [];
  const executor = createExecutor(createArbiter(), {
    Idle: request => ({
      start() {
        started.push(request.runId);
      },
      cancel() {
        stopped++;
      },
    }),
  });
  const combat: ActionRequest = {
    ...req('combat', 80),
    requiredResources: ['MOVE', 'LOOK', 'HAND', 'INVENTORY'],
  };
  const retreat: ActionRequest = { ...req('retreat', 100), requiredResources: ['MOVE', 'LOOK'] };
  const eat: ActionRequest = { ...req('eat', 90), requiredResources: ['HAND', 'INVENTORY'] };
  executor.reconcile([combat], snapshot(), 0);
  executor.reconcile([combat, retreat, eat], snapshot(), 0);
  assert.equal(stopped, 1);
  assert.deepEqual(started, ['combat']);
  assert.equal(executor.runtime().lockedResources.HAND, 'combat');
  executor.advanceTick();
  executor.reconcile([combat, retreat, eat], snapshot(), 50);
  assert.deepEqual(started, ['combat', 'retreat', 'eat']);
  assert.deepEqual(executor.runtime().lockedResources, {
    MOVE: 'retreat',
    LOOK: 'retreat',
    HAND: 'eat',
    INVENTORY: 'eat',
    VOICE: null,
  });
});
