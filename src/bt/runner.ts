import type { Blackboard, BlackboardSnapshot, IntentState, Position, WorldState } from '../blackboard.ts';
import type { Executor } from '../execution/executor.ts';
import type { ActionRequest } from '../execution/types.ts';
import type { BehaviorTree } from './nodes.ts';

export type RunnerEvent = { type: 'world'; world: WorldState }
  | { type: 'intent'; mode: IntentState['mode']; targetPosition?: Position | null }
  | { type: 'status' };
export function createRunner(options: {
  board: Blackboard; executor: Executor; tree: BehaviorTree;
  now?: () => number;
  schedule?: (callback: () => void) => void;
  collectRequests?: (snapshot: BlackboardSnapshot) => ActionRequest[];
  onStatus?: (snapshot: BlackboardSnapshot) => void;
}) {
  const { board, executor, tree } = options;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? queueMicrotask;
  // Coalesce latest world/intent and repeated status requests; never grow with packet rate.
  let events = new Map<RunnerEvent['type'], RunnerEvent>();
  let enabled = false;
  let deciding = false;
  let urgent = false;
  let scheduled = false;
  let physicsTicks = 0;

  function decide() {
    if (!enabled || deciding) return;
    deciding = true;
    urgent = false;
    const generation = executor.generation();
    try {
      const time = now();
      const batch = events;
      events = new Map(); // Events raised below belong to the next decision.
      for (const event of batch.values()) {
        if (event.type === 'world') board.setWorld(event.world);
        if (event.type === 'intent') board.setIntent(event.mode, time, event.targetPosition);
      }
      executor.flushResults(time);
      board.setRuntime(executor.runtime());
      const snapshot = board.snapshot(time);
      if (batch.has('status')) options.onStatus?.(snapshot);
      if (!enabled || generation !== executor.generation()) return;
      const requests = tree.tick(snapshot).requests;
      if (!enabled || generation !== executor.generation()) return;
      requests.push(...(options.collectRequests?.(snapshot) ?? []));
      if (!enabled || generation !== executor.generation()) return;
      executor.reconcile(requests, snapshot, time);
      board.setRuntime(executor.runtime());
    } finally { deciding = false; }
  }
  return {
    enqueue(event: RunnerEvent) { if (enabled) events.set(event.type, structuredClone(event)); },
    requestUrgentTick() {
      if (!enabled) return;
      urgent = true;
      if (scheduled) return;
      scheduled = true;
      const generation = executor.generation();
      schedule(() => {
        scheduled = false;
        if (!enabled || generation !== executor.generation() || !urgent) return;
        decide();
      });
    },
    physicsTick() {
      if (!enabled) return;
      const released = executor.advanceTick(); // Fence is 1 physics tick, not 1 decision tick.
      physicsTicks++;
      if (physicsTicks % 2 === 0 || released || urgent) decide();
    },
    resume() { enabled = true; physicsTicks = 0; },
    pause() {
      enabled = false; urgent = false; events.clear();
      executor.reset(); tree.halt(); board.reset(executor.generation());
    },
    snapshot() { board.setRuntime(executor.runtime()); return board.snapshot(now()); },
  };
}
export type Runner = ReturnType<typeof createRunner>;
