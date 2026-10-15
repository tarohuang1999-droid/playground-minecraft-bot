import type { BlackboardSnapshot } from '../blackboard.ts';
import type { ActionType, ResourceChannel } from '../policy.ts';

export type NodeStatus = 'RUNNING' | 'SUCCESS' | 'FAILURE';
export interface ActionRequest {
  readonly nodeId: string;
  readonly runId: string;
  readonly actionType: ActionType;
  readonly targetId: number | null;
  readonly requiredResources: readonly ResourceChannel[];
  readonly priority: number;
  readonly params: Readonly<Record<string, string | number | boolean>>;
}
export interface ActionResult {
  readonly status: 'SUCCESS' | 'FAILURE';
  readonly reason?: string;
}
export interface ActionContext {
  readonly request: ActionRequest;
  readonly token: number;
  readonly generation: number;
  readonly signal: AbortSignal;
  isActive(): boolean;
  getSnapshot(): BlackboardSnapshot;
}
export interface ActionAdapter {
  start(ctx: ActionContext): void | ActionResult | Promise<void | ActionResult>;
  update?(ctx: ActionContext): void | ActionResult;
  // Must synchronously disable future control writes. A pending result alone may remain.
  cancel(): void;
  // Optional confirmation of stoppage for actions with asynchronous side effects.
  isStopped?(): boolean;
}
export type AdapterFactory = (request: ActionRequest) => ActionAdapter;
export type AdapterRegistry = Partial<Record<ActionType, AdapterFactory>>;
