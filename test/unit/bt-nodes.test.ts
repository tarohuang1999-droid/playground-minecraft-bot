import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlackboard } from '../../src/blackboard.ts';
import { action, createTree, guard, parallel, reactiveSelector, sequence } from '../../src/bt/nodes.ts';
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
