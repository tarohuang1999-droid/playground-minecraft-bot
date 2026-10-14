import { emptyRuntime, type BlackboardSnapshot, type RuntimeState } from '../blackboard.ts';
import { THRESHOLDS } from '../policy.ts';
import type { Arbiter } from './arbiter.ts';
import type { ActionAdapter, ActionContext, ActionRequest, ActionResult, AdapterRegistry } from './types.ts';

interface Run {
  request: ActionRequest;
  token: number;
  status: 'RUNNING' | 'STOPPING' | 'FAULTED';
  startedAt: number;
  releaseAtTick: number;
  controller: AbortController;
  adapter: ActionAdapter;
  ctx: ActionContext;
  completionQueued: boolean;
}
export function createExecutor(arbiter: Arbiter, adapters: AdapterRegistry, logger?: { error?(m: string, d?: unknown): void }) {
  const runs = new Map<string, Run>();
  const results = new Map<string, ActionResult>();
  const cooldowns = new Map<number, number>();
  let completions: Array<{ run: Run; result: ActionResult }> = [];
  let generation = 0;
  let token = 0;
  let tick = 0;
  let latestSnapshot: BlackboardSnapshot;
  let fault: string | null = null;

  function stop(run: Run) {
    if (run.status !== 'RUNNING') return;
    run.status = 'STOPPING'; // Revoke before calling any user-provided cancellation code.
    run.controller.abort();
    run.releaseAtTick = tick + 1;
    try { run.adapter.cancel(); }
    catch (error) {
      run.status = 'FAULTED';
      fault = String(error);
      logger?.error?.(`[executor] action ${run.request.actionType} cancel error: ${error}`);
    }
  }
  function queueResult(run: Run, value: void | ActionResult) {
    if (!value || !run.ctx.isActive() || run.completionQueued) return;
    run.completionQueued = true;
    completions.push({ run, result: value });
  }
  function perform(run: Run, call: () => void | ActionResult | Promise<void | ActionResult>) {
    try {
      const value = call();
      if (value instanceof Promise) {
        value.then(outcome => {
          if (!run.ctx.isActive()) return;
          queueResult(run, outcome);
        }, error => {
          if (!run.ctx.isActive()) return;
          logger?.error?.(`[executor] action ${run.request.actionType} async error: ${error?.stack ?? error}`);
          queueResult(run, { status: 'FAILURE', reason: String(error) });
        });
      } else queueResult(run, value);
    } catch (error: any) {
      logger?.error?.(`[executor] action ${run.request.actionType} error: ${error?.stack ?? error}`);
      queueResult(run, { status: 'FAILURE', reason: String(error) });
    }
  }
  return {
    reconcile(requests: readonly ActionRequest[], snapshot: BlackboardSnapshot, now: number) {
      if (snapshot.generation !== generation) return;
      const roundGeneration = generation;
      latestSnapshot = snapshot;
      if (fault) return;
      for (const request of requests) {
        const existing = runs.get(request.runId);
        if (existing && JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error('A run cannot change its resource or target contract');
      }
      const requestedIds = new Set(requests.map(request => request.runId));
      for (const id of results.keys()) if (!requestedIds.has(id)) results.delete(id);
      const winners = arbiter.select(requests);
      const winnerIds = new Set(winners.map(request => request.runId));
      for (const run of runs.values()) if (!winnerIds.has(run.request.runId)) stop(run);
      if (fault) return;
      for (const request of winners) {
        if (generation !== roundGeneration || fault) return;
        const existing = runs.get(request.runId);
        if (existing) {
          if (existing.ctx.isActive() && !existing.completionQueued && existing.adapter.update) perform(existing, () => existing.adapter.update!(existing.ctx));
          continue;
        }
        if (results.has(request.runId)) continue;
        const factory = adapters[request.actionType];
        if (!factory) { results.set(request.runId, { status: 'FAILURE', reason: 'Action is not implemented' }); continue; }
        const nextToken = ++token;
        if (!arbiter.acquire(request, nextToken)) continue;
        let adapter: ActionAdapter;
        try { adapter = factory(request); }
        catch (error) {
          arbiter.release(request.runId, nextToken);
          results.set(request.runId, { status: 'FAILURE', reason: String(error) });
          continue;
        }
        const controller = new AbortController();
        const runGeneration = generation;
        const run: Run = {
          request: structuredClone(request), token: nextToken, status: 'RUNNING', startedAt: now, releaseAtTick: Infinity,
          controller, adapter, completionQueued: false,
          ctx: {
            request, token: nextToken, generation: runGeneration, signal: controller.signal,
            isActive: () => generation === runGeneration && runs.get(request.runId) === run && run.status === 'RUNNING' && run.token === nextToken,
            getSnapshot: () => latestSnapshot,
          },
        };
        runs.set(request.runId, run);
        perform(run, () => adapter.start(run.ctx));
      }
    },
    advanceTick(): boolean {
      tick++;
      let released = false;
      for (const [id, run] of runs) {
        if (run.status === 'STOPPING' && run.releaseAtTick <= tick) {
          arbiter.release(id, run.token);
          runs.delete(id);
          released = true;
        }
      }
      return released;
    },
    flushResults(now: number) {
      const batch = completions;
      completions = [];
      for (const { run, result } of batch) {
        if (!run.ctx.isActive()) continue;
        stop(run);
        results.set(run.request.runId, result);
        if (result.status === 'FAILURE' && run.request.actionType === 'PickupItem' && run.request.targetId !== null) {
          cooldowns.set(run.request.targetId, now + THRESHOLDS.failureCooldownMs);
        }
      }
      for (const [id, until] of cooldowns) if (until <= now) cooldowns.delete(id);
    },
    runtime(): RuntimeState {
      const runtime = emptyRuntime();
      for (const [id, run] of runs) runtime.activeRuns[id] = {
        runId: id, actionType: run.request.actionType, targetId: run.request.targetId, startedAt: run.startedAt, status: run.status,
      };
      runtime.results = Object.fromEntries(results);
      runtime.cooldowns = Object.fromEntries(cooldowns);
      runtime.lockedResources = arbiter.owners();
      return structuredClone(runtime);
    },
    reset() {
      generation++;
      for (const run of runs.values()) stop(run);
      runs.clear(); results.clear(); cooldowns.clear(); completions = [];
      arbiter.clear(); fault = null;
    },
    generation: () => generation,
    fault: () => fault,
    availableActions: () => new Set(Object.keys(adapters)),
  };
}
export type Executor = ReturnType<typeof createExecutor>;
