import { RESOURCES, type ActionType, type ResourceChannel } from './policy.ts';
import type { ActionResult } from './execution/types.ts';

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface Position { x: number; y: number; z: number }
export interface ObservedEntity { entityId: number; name: string; position: Position; distance: number }
export interface WorldState {
  self: { position: Position; health: number; food: number; isAlive: boolean; tookDamageRecently: boolean };
  master: { username: string; entityId: number | null; position: Position | null; distance: number };
  base: Position | null;
  spawnPoint: Position | null;
  bedNeedsRefresh: boolean;
  nearbyBed: Position | null;
  entities: ObservedEntity[];
  threats: ObservedEntity[];
  nearbyDrops: Array<ObservedEntity & { itemName: string }>;
  inventory: {
    freeSlots: number;
    bestFood: { itemId: number; name: string; foodPoints: number } | null;
    bestWeapon: { itemId: number; name: string; attackDamage: number } | null;
    equippedWeaponDamage: number;
    pendingArmorUpgrade: { itemId: number; slot: 'head' | 'torso' | 'legs' | 'feet' } | null;
  };
}
export interface IntentState {
  mode: 'FOLLOW' | 'STAY' | 'IDLE' | 'COME' | 'RETURN';
  targetPosition?: Position | null;
  canDig: boolean;
  allowBridge: boolean;
  missionId: string;
  updatedAt: number;
  intentRevision: number;
}
export interface RuntimeState {
  activeRuns: Record<string, { runId: string; actionType: ActionType; targetId: number | null; startedAt: number; status: 'RUNNING' | 'STOPPING' | 'FAULTED' }>;
  results: Record<string, ActionResult>;
  cooldowns: Record<number, number>;
  lockedResources: Record<ResourceChannel, string | null>;
}
export interface BoardState {
  revision: number;
  observedAt: number;
  generation: number;
  world: WorldState;
  intent: IntentState;
  runtime: RuntimeState;
}
export type BlackboardSnapshot = DeepReadonly<BoardState>;
export function createWorld(master: string = ''): WorldState {
  return {
    self: { position: { x: 0, y: 0, z: 0 }, health: 20, food: 20, isAlive: false, tookDamageRecently: false },
    master: { username: master, entityId: null, position: null, distance: Infinity },
    base: null,
    spawnPoint: null,
    bedNeedsRefresh: false,
    nearbyBed: null,
    entities: [], threats: [], nearbyDrops: [],
    inventory: { freeSlots: 0, bestFood: null, bestWeapon: null, equippedWeaponDamage: 0, pendingArmorUpgrade: null },
  };
}
export function emptyRuntime(): RuntimeState {
  return { activeRuns: {}, results: {}, cooldowns: {}, lockedResources: Object.fromEntries(RESOURCES.map(r => [r, null])) as RuntimeState['lockedResources'] };
}
function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export function createBlackboard(master: string) {
  let missionCounter = 0;
  function nextMissionId(mode: string): string {
    return `${mode}-${++missionCounter}`;
  }

  let state: BoardState = {
    revision: 0, observedAt: 0, generation: 0, world: createWorld(master),
    intent: {
      mode: 'IDLE',
      targetPosition: null,
      canDig: false,
      allowBridge: false,
      missionId: nextMissionId('IDLE'),
      updatedAt: 0,
      intentRevision: 0,
    },
    runtime: emptyRuntime(),
  };
  return {
    setWorld(world: WorldState) { state.world = structuredClone(world); },
    setIntent(mode: IntentState['mode'], now: number, targetPosition?: Position | null) {
      state.intent = {
        ...state.intent,
        mode,
        targetPosition: targetPosition ?? null,
        missionId: nextMissionId(mode),
        updatedAt: now,
        intentRevision: state.intent.intentRevision + 1,
      };
    },
    setDig(canDig: boolean, now: number) {
      if (state.intent.canDig === canDig) return;
      state.intent = {
        ...state.intent,
        canDig,
        updatedAt: now,
        intentRevision: state.intent.intentRevision + 1,
      };
    },
    setBridge(allowBridge: boolean, now: number) {
      if (state.intent.allowBridge === allowBridge) return;
      state.intent = {
        ...state.intent,
        allowBridge,
        updatedAt: now,
        intentRevision: state.intent.intentRevision + 1,
      };
    },
    setRuntime(runtime: RuntimeState) { state.runtime = structuredClone(runtime); },
    reset(generation: number) {
      state = {
        ...state,
        generation,
        world: createWorld(master),
        intent: {
          ...state.intent,
          canDig: false,
          allowBridge: false,
        },
        runtime: emptyRuntime(),
      };
    },
    snapshot(now: number): BlackboardSnapshot {
      state.revision++;
      state.observedAt = now;
      return freezeDeep(structuredClone(state));
    },
  };
}
export type Blackboard = ReturnType<typeof createBlackboard>;
