import type { BlackboardSnapshot } from '../blackboard.ts';
import { ACTION_POLICY, type ActionType, type ResourceChannel } from '../policy.ts';
import type { ActionRequest, NodeStatus } from '../execution/types.ts';

export interface TickResult {
  status: NodeStatus;
  requests: ActionRequest[];
}
interface NodeState {
  cursor?: number;
  activeIndex?: number;
  entered?: boolean;
  runId?: string;
  signature?: string;
  completed?: Set<number>;
  retryCount?: number;
  phase?: 'primary' | 'recovery';
}
export interface BtContext {
  snapshot: BlackboardSnapshot;
  states: Map<string, NodeState>;
  nextRunId(nodeId: string): string;
}
export interface BtNode {
  id: string;
  tick(ctx: BtContext): TickResult;
  halt(ctx: BtContext): void;
}
const result = (status: NodeStatus, requests: ActionRequest[] = []): TickResult => ({
  status,
  requests,
});
function state(ctx: BtContext, id: string): NodeState {
  let value = ctx.states.get(id);
  if (!value) {
    value = {};
    ctx.states.set(id, value);
  }
  return value;
}
export function action(
  id: string,
  describe: (snapshot: BlackboardSnapshot) => {
    actionType: ActionType;
    targetId: number | null;
    params: ActionRequest['params'];
    requiredResources?: readonly ResourceChannel[];
  }
): BtNode {
  return {
    id,
    tick(ctx) {
      const spec = describe(ctx.snapshot);
      const signature = JSON.stringify([
        spec.actionType,
        spec.targetId,
        spec.params,
        spec.requiredResources,
      ]);
      const current = state(ctx, id);
      if (signature !== current.signature) {
        current.runId = ctx.nextRunId(id);
        current.signature = signature;
      }
      const runId = current.runId!;
      const outcome = ctx.snapshot.runtime.results[runId];
      if (outcome) {
        ctx.states.delete(id);
        return result(outcome.status);
      }
      const policy = ACTION_POLICY[spec.actionType];
      return result('RUNNING', [
        {
          nodeId: id,
          runId,
          actionType: spec.actionType,
          targetId: spec.targetId,
          params: spec.params,
          priority: policy.priority,
          requiredResources: spec.requiredResources ?? policy.requiredResources,
        },
      ]);
    },
    halt(ctx) {
      ctx.states.delete(id);
    },
  };
}
export function guard(
  id: string,
  enter: (snapshot: BlackboardSnapshot) => boolean,
  child: BtNode,
  options: { exit?: (snapshot: BlackboardSnapshot) => boolean } = {}
): BtNode {
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      const allowed =
        current.entered && options.exit ? !options.exit(ctx.snapshot) : enter(ctx.snapshot);
      if (!allowed) {
        child.halt(ctx);
        ctx.states.delete(id);
        return result('FAILURE');
      }
      current.entered = true;
      const outcome = child.tick(ctx);
      if (outcome.status !== 'RUNNING') {
        child.halt(ctx);
        ctx.states.delete(id);
      }
      return outcome;
    },
    halt(ctx) {
      child.halt(ctx);
      ctx.states.delete(id);
    },
  };
}
export function reactiveSelector(id: string, children: readonly BtNode[]): BtNode {
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        const outcome = child.tick(ctx);
        if (outcome.status === 'FAILURE') {
          child.halt(ctx);
          continue;
        }
        if (current.activeIndex !== undefined && current.activeIndex !== index)
          children[current.activeIndex]!.halt(ctx);
        current.activeIndex = index;
        if (outcome.status === 'SUCCESS') {
          child.halt(ctx);
          ctx.states.delete(id);
        }
        return outcome;
      }
      if (current.activeIndex !== undefined) children[current.activeIndex]!.halt(ctx);
      ctx.states.delete(id);
      return result('FAILURE');
    },
    halt(ctx) {
      children.forEach(child => child.halt(ctx));
      ctx.states.delete(id);
    },
  };
}
export function sequence(id: string, children: readonly BtNode[]): BtNode {
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      current.cursor ??= 0;
      while (current.cursor < children.length) {
        const child = children[current.cursor]!;
        const outcome = child.tick(ctx);
        if (outcome.status === 'RUNNING') return outcome;
        child.halt(ctx);
        if (outcome.status === 'FAILURE') {
          ctx.states.delete(id);
          return outcome;
        }
        current.cursor++;
      }
      ctx.states.delete(id);
      return result('SUCCESS');
    },
    halt(ctx) {
      children.forEach(child => child.halt(ctx));
      ctx.states.delete(id);
    },
  };
}
export function parallel(
  id: string,
  children: readonly BtNode[],
  options: { persistent?: boolean } = {}
): BtNode {
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      current.completed ??= new Set();
      const requests: ActionRequest[] = [];
      for (let index = 0; index < children.length; index++) {
        if (current.completed.has(index)) continue;
        const child = children[index]!;
        const outcome = child.tick(ctx);
        if (!options.persistent && outcome.status === 'FAILURE') {
          children.forEach(node => node.halt(ctx));
          ctx.states.delete(id);
          return result('FAILURE');
        }
        requests.push(...outcome.requests);
        if (outcome.status !== 'RUNNING') {
          child.halt(ctx);
          if (!options.persistent) current.completed.add(index);
        }
      }
      if (!options.persistent && current.completed.size === children.length) {
        ctx.states.delete(id);
        return result('SUCCESS');
      }
      return result('RUNNING', requests);
    },
    halt(ctx) {
      children.forEach(child => child.halt(ctx));
      ctx.states.delete(id);
    },
  };
}
export function stagedRecovery(id: string, stages: readonly BtNode[]): BtNode {
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      current.cursor ??= 0;
      while (current.cursor < stages.length) {
        const stage = stages[current.cursor]!;
        const outcome = stage.tick(ctx);
        if (outcome.status === 'RUNNING') return outcome;
        stage.halt(ctx);
        if (outcome.status === 'SUCCESS') {
          current.cursor++;
          return outcome;
        }
        // Stage failed, advance to next stage in the same tick
        current.cursor++;
      }
      ctx.states.delete(id);
      return result('FAILURE');
    },
    halt(ctx) {
      stages.forEach(s => s.halt(ctx));
    },
  };
}
export function retry(
  id: string,
  child: BtNode,
  options: { maxRetries?: number; onFinalFailure?: (ctx: BtContext) => void } = {}
): BtNode {
  const maxRetries = options.maxRetries ?? 1;
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      current.retryCount ??= 0;

      while (true) {
        const outcome = child.tick(ctx);
        if (outcome.status === 'RUNNING') return outcome;
        child.halt(ctx);
        if (outcome.status === 'SUCCESS') {
          ctx.states.delete(id);
          return outcome;
        }
        if (current.retryCount >= maxRetries) {
          ctx.states.delete(id);
          options.onFinalFailure?.(ctx);
          return result('FAILURE');
        }
        current.retryCount++;
      }
    },
    halt(ctx) {
      child.halt(ctx);
      ctx.states.delete(id);
    },
  };
}
export function recovery(
  id: string,
  primary: BtNode,
  recoveryNode: BtNode,
  options: { maxRetries?: number; onFinalFailure?: (ctx: BtContext) => void } = {}
): BtNode {
  const maxRetries = options.maxRetries ?? 1;
  return {
    id,
    tick(ctx) {
      const current = state(ctx, id);
      current.retryCount ??= 0;
      current.phase ??= 'primary';

      while (true) {
        if (current.phase === 'primary') {
          const outcome = primary.tick(ctx);
          if (outcome.status === 'RUNNING') return outcome;
          primary.halt(ctx);
          if (outcome.status === 'SUCCESS') {
            recoveryNode.halt(ctx);
            ctx.states.delete(recoveryNode.id);
            ctx.states.delete(id);
            return outcome;
          }
          if (current.retryCount >= maxRetries) {
            recoveryNode.halt(ctx);
            ctx.states.delete(recoveryNode.id);
            ctx.states.delete(id);
            options.onFinalFailure?.(ctx);
            return result('FAILURE');
          }
          current.retryCount++;
          current.phase = 'recovery';
        }

        // phase === 'recovery'
        const recOutcome = recoveryNode.tick(ctx);
        if (recOutcome.status === 'RUNNING') return recOutcome;
        recoveryNode.halt(ctx);
        if (recOutcome.status === 'SUCCESS') {
          current.phase = 'primary';
          continue;
        }
        // Recovery failed
        recoveryNode.halt(ctx);
        ctx.states.delete(recoveryNode.id);
        ctx.states.delete(id);
        options.onFinalFailure?.(ctx);
        return result('FAILURE');
      }
    },
    halt(ctx) {
      primary.halt(ctx);
      recoveryNode.halt(ctx);
      ctx.states.delete(recoveryNode.id);
      ctx.states.delete(id);
    },
  };
}
export function createTree(root: BtNode) {
  const states = new Map<string, NodeState>();
  let counter = 0;
  let context: BtContext | undefined;
  return {
    tick(snapshot: BlackboardSnapshot): TickResult {
      context = {
        snapshot,
        states,
        nextRunId: nodeId => `${snapshot.generation}:${nodeId}:${++counter}`,
      };
      return root.tick(context);
    },
    halt() {
      if (context) root.halt(context);
      states.clear();
    },
  };
}
export type BehaviorTree = ReturnType<typeof createTree>;
