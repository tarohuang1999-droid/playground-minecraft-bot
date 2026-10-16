import assert from 'node:assert/strict';
import test from 'node:test';
import { createArbiter } from '../../src/execution/arbiter.ts';
import type { ActionRequest } from '../../src/execution/types.ts';

function request(
  runId: string,
  priority: number,
  requiredResources: ActionRequest['requiredResources']
): ActionRequest {
  return {
    nodeId: runId,
    runId,
    actionType: 'Idle',
    targetId: null,
    priority,
    requiredResources,
    params: {},
  };
}

test('whole groups compete; disjoint winners can execute together', () => {
  const arbiter = createArbiter();
  const combat = request('combat', 80, ['MOVE', 'LOOK', 'HAND', 'INVENTORY']);
  const retreat = request('retreat', 100, ['MOVE', 'LOOK']);
  const eat = request('eat', 90, ['HAND', 'INVENTORY']);
  assert.deepEqual(
    arbiter.select([combat, retreat, eat]).map(r => r.runId),
    ['retreat', 'eat']
  );
  assert.equal(arbiter.acquire(combat, 1), true);
  assert.equal(arbiter.acquire(retreat, 2), false);
  assert.equal(arbiter.owners().MOVE, 'combat');
  arbiter.release('combat', 99);
  assert.equal(arbiter.owners().HAND, 'combat');
  arbiter.release('combat', 1);
  assert.equal(arbiter.acquire(retreat, 2), true);
  assert.equal(arbiter.acquire(eat, 3), true);
});

test('equal priority retains the owner even when input order changes', () => {
  const arbiter = createArbiter();
  const incumbent = request('old', 20, ['MOVE', 'LOOK']);
  const newcomer = request('new', 20, ['MOVE', 'LOOK']);
  arbiter.acquire(incumbent, 1);
  assert.deepEqual(
    arbiter.select([newcomer, incumbent]).map(r => r.runId),
    ['old']
  );
});
