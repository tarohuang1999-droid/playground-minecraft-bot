import { RESOURCES, type ResourceChannel } from '../policy.ts';
import type { ActionRequest } from './types.ts';

type Owner = { runId: string; token: number };
export function createArbiter() {
  const owners = new Map<ResourceChannel, Owner>();
  function validate(requests: readonly ActionRequest[]) {
    const ids = new Set<string>();
    for (const request of requests) {
      if (ids.has(request.runId) || !Number.isFinite(request.priority)) throw new Error('Invalid action request');
      ids.add(request.runId);
      if (new Set(request.requiredResources).size !== request.requiredResources.length ||
          request.requiredResources.some(resource => !RESOURCES.includes(resource))) throw new Error('Invalid resources');
    }
  }
  return {
    select(requests: readonly ActionRequest[]): ActionRequest[] {
      validate(requests);
      const incumbents = new Set([...owners.values()].map(owner => owner.runId));
      const sorted = [...requests].sort((a, b) => b.priority - a.priority || Number(incumbents.has(b.runId)) - Number(incumbents.has(a.runId)));
      const claimed = new Set<ResourceChannel>();
      return sorted.filter(request => {
        if (request.requiredResources.some(resource => claimed.has(resource))) return false;
        request.requiredResources.forEach(resource => claimed.add(resource));
        return true;
      });
    },
    acquire(request: ActionRequest, token: number): boolean {
      validate([request]);
      if (request.requiredResources.some(resource => owners.has(resource))) return false;
      for (const resource of request.requiredResources) owners.set(resource, { runId: request.runId, token });
      return true;
    },
    release(runId: string, token: number) {
      for (const [resource, owner] of owners) if (owner.runId === runId && owner.token === token) owners.delete(resource);
    },
    owners(): Record<ResourceChannel, string | null> {
      return Object.fromEntries(RESOURCES.map(resource => [resource, owners.get(resource)?.runId ?? null])) as Record<ResourceChannel, string | null>;
    },
    clear() { owners.clear(); },
  };
}
export type Arbiter = ReturnType<typeof createArbiter>;
