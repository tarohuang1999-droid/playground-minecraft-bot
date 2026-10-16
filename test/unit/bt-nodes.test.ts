import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard } from '../../src/blackboard.ts';
import { action, createTree, guard, parallel, reactiveSelector, recovery, sequence } from '../../src/bt/nodes.ts';
import type { BtNode } from '../../src/bt/nodes.ts';

const snapshot = () => createBlackboard('owner').snapshot(0);
const idle = (id: string) => action(id, () => ({ actionType: 'Idle', targetId: null, params: {} }));

test('reactive preemption resets the lower sequence and preserves uninterrupted run IDs', () => {
  let danger = false;
  let preparations = 0;
  const prepare: BtNode = { id: 'prepare', tick: () => { preparations++; return { status: 'SUCCESS', requests: [] }; }, halt() {} };
  const tree = createTree(reactiveSelector('root', [
    guard('danger', () => danger, idle('retreat')),
    sequence('work', [prepare, idle('follow')]),
  ]));
  const first = tree.tick(snapshot()).requests[0]!;
  assert.equal(tree.tick(snapshot()).requests[0]!.runId, first.runId);
  assert.equal(preparations, 1);
  danger = true;
  assert.equal(tree.tick(snapshot()).requests[0]!.nodeId, 'retreat');
  danger = false;
  const resumed = tree.tick(snapshot()).requests[0]!;
  assert.equal(preparations, 2);
  assert.notEqual(resumed.runId, first.runId);
});

test('persistent parallel retains both requests and halt re-enters with fresh run IDs', () => {
  const tree = createTree(parallel('root', [idle('move'), idle('eat')], { persistent: true }));
  const before = tree.tick(snapshot());
  assert.equal(before.status, 'RUNNING');
  assert.equal(before.requests.length, 2);
  tree.halt();
  const after = tree.tick(snapshot());
  assert.notEqual(after.requests[0]!.runId, before.requests[0]!.runId);
});

test('guard has separate enter and exit thresholds', () => {
  let distance = 6;
  const tree = createTree(guard('follow', () => distance > 5, idle('move'), { exit: () => distance <= 3 }));
  const request = tree.tick(snapshot()).requests[0]!;
  distance = 4;
  assert.equal(tree.tick(snapshot()).requests[0]!.runId, request.runId);
  distance = 3;
  assert.equal(tree.tick(snapshot()).status, 'FAILURE');
});

test('terminal action results advance a sequence without reissuing the completed action', () => {
  const board = createBlackboard('owner');
  const tree = createTree(sequence('root', [idle('first'), idle('second')]));
  const first = tree.tick(board.snapshot(0)).requests[0]!;
  const runtime = structuredClone(board.snapshot(0).runtime);
  board.setRuntime({ ...runtime, results: { [first.runId]: { status: 'SUCCESS' } } });
  assert.equal(tree.tick(board.snapshot(1)).requests[0]!.nodeId, 'second');
});

test('recovery node ticks recovery action on primary failure and retries primary on recovery success', () => {
  let primaryStatus: 'RUNNING' | 'SUCCESS' | 'FAILURE' = 'RUNNING';
  let recoveryStatus: 'RUNNING' | 'SUCCESS' | 'FAILURE' = 'RUNNING';
  let primaryTicks = 0;
  let recoveryTicks = 0;
  let primaryHalts = 0;
  let recoveryHalts = 0;

  const primary: BtNode = {
    id: 'primary',
    tick: () => { primaryTicks++; return { status: primaryStatus, requests: [] }; },
    halt: () => { primaryHalts++; },
  };
  const recAction: BtNode = {
    id: 'recAction',
    tick: () => { recoveryTicks++; return { status: recoveryStatus, requests: [] }; },
    halt: () => { recoveryHalts++; },
  };

  const tree = createTree(recovery('recNode', primary, recAction, { maxRetries: 2 }));

  // 1. Primary running
  let res = tree.tick(snapshot());
  assert.equal(res.status, 'RUNNING');
  assert.equal(primaryTicks, 1);
  assert.equal(recoveryTicks, 0);

  // 2. Primary fails -> recovery ticks immediately and returns RUNNING
  primaryStatus = 'FAILURE';
  recoveryStatus = 'RUNNING';
  res = tree.tick(snapshot());
  assert.equal(res.status, 'RUNNING');
  assert.equal(primaryHalts, 1);
  assert.equal(recoveryTicks, 1);

  // 3. Recovery succeeds -> primary retried in the same tick!
  primaryStatus = 'RUNNING';
  recoveryStatus = 'SUCCESS';
  res = tree.tick(snapshot());
  assert.equal(res.status, 'RUNNING');
  assert.equal(recoveryHalts, 1);
  assert.equal(primaryTicks, 3); // Retried primary!

  // 4. Primary fails 2nd time -> recovery ticks again
  primaryStatus = 'FAILURE';
  recoveryStatus = 'RUNNING';
  res = tree.tick(snapshot());
  assert.equal(res.status, 'RUNNING');
  assert.equal(recoveryTicks, 3);

  // 5. Recovery succeeds again -> primary retried 3rd time
  primaryStatus = 'FAILURE';
  recoveryStatus = 'SUCCESS';
  // Primary immediately fails 3rd time (maxRetries=2 reached) -> recovery node fails!
  res = tree.tick(snapshot());
  assert.equal(res.status, 'FAILURE');
});

test('recovery node returns FAILURE if recovery action fails', () => {
  const primary: BtNode = {
    id: 'primary',
    tick: () => ({ status: 'FAILURE', requests: [] }),
    halt: () => {},
  };
  const recAction: BtNode = {
    id: 'recAction',
    tick: () => ({ status: 'FAILURE', requests: [] }),
    halt: () => {},
  };

  const tree = createTree(recovery('recNode', primary, recAction, { maxRetries: 1 }));
  const res = tree.tick(snapshot());
  assert.equal(res.status, 'FAILURE');
});

