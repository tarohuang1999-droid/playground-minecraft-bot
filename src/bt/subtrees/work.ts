import type { BlackboardSnapshot } from '../../blackboard.ts';
import { THRESHOLDS, type ResourceChannel } from '../../policy.ts';
import { action, guard, reactiveSelector, recovery, stagedRecovery, type BtNode } from '../nodes.ts';
import type { NavigationLogger } from '../../actions/navigation.ts';

export function workSubtree(
  available: ReadonlySet<string>,
  options?: {
    onNavigationFailed?: ((reason: string, missionId: string) => void) | undefined;
    logger?: NavigationLogger | undefined;
  }
) {
  const logger = options?.logger;
  const getNavResources = (s: BlackboardSnapshot): readonly ResourceChannel[] => {
    if (s.intent.canDig || s.intent.allowBridge) {
      return ['MOVE', 'LOOK', 'HAND', 'INVENTORY'];
    }
    return ['MOVE', 'LOOK'];
  };

  const withRecovery = (
    id: string,
    primaryNode: BtNode,
    getTargetPos: (s: BlackboardSnapshot) => { x: number; y: number; z: number } | null
  ) => {
    if (!available.has('UnstickCorner') && !available.has('DetourWaypoint')) {
      return primaryNode;
    }
    const stages: BtNode[] = [];
    if (available.has('UnstickCorner')) {
      stages.push(
        action(`${id}-unstick`, s => {
          logger?.info(`[recovery] ${id} recovery phase 1: issuing UnstickCorner`);
          return {
            actionType: 'UnstickCorner',
            targetId: null,
            params: { missionId: s.intent.missionId },
            requiredResources: ['MOVE', 'LOOK'],
          };
        })
      );
    }
    if (available.has('DetourWaypoint')) {
      const createDetourAction = (subId: string) => action(`${id}-detour-${subId}`, s => {
        const pos = getTargetPos(s);
        logger?.info(`[recovery] ${id} recovery phase 2: issuing DetourWaypoint towards (${pos?.x?.toFixed(1) ?? '?'}, ${pos?.y?.toFixed(1) ?? '?'}, ${pos?.z?.toFixed(1) ?? '?'})`);
        return {
          actionType: 'DetourWaypoint',
          targetId: null,
          params: {
            missionId: s.intent.missionId,
            ...(pos ? { targetX: pos.x, targetY: pos.y, targetZ: pos.z } : {}),
          },
          requiredResources: ['MOVE', 'LOOK'],
        };
      });
      stages.push(createDetourAction('1'));
      stages.push(createDetourAction('2'));
    }
    return recovery(
      `${id}-recovery`,
      primaryNode,
      stages.length === 1 ? stages[0]! : stagedRecovery(`${id}-rec-staged`, stages),
      {
        maxRetries: 3,
        onFinalFailure: (ctx) => {
          const missionId = ctx.snapshot.intent.missionId ?? '';
          logger?.warn(`[recovery] ${id} all recovery attempts exhausted; navigation failed for mission "${missionId}"`);
          options?.onNavigationFailed?.('Path obstructed. Stopped; send !follow, !come or !return to retry.', missionId);
        },
      }
    );
  };

  const canFollow = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'FOLLOW' && s.world.master.entityId !== null;

  const follow = (type: 'CatchUpFollow' | 'NormalFollow', enter: number, exit: number) =>
    guard(`${type}-ready`, s => available.has(type) && canFollow(s) && s.world.master.distance > enter,
      withRecovery(type,
        action(type, s => ({
          actionType: type,
          targetId: s.world.master.entityId,
          params: {
            canDig: s.intent.canDig,
            allowBridge: s.intent.allowBridge,
            missionId: s.intent.missionId,
          },
          requiredResources: getNavResources(s),
        })),
        s => s.world.master.position ? { x: s.world.master.position.x, y: s.world.master.position.y, z: s.world.master.position.z } : null
      ),
      { exit: s => !available.has(type) || !canFollow(s) || s.world.master.distance <= exit });

  const getBestPickupTarget = (s: BlackboardSnapshot) => {
    if (!available.has('PickupItem')) return null;
    if (!s.world.self.isAlive || s.world.inventory.freeSlots <= 0) return null;
    // In FOLLOW mode, master must be within pickupMasterLimit (10 blocks) so bot doesn't abandon master
    if (s.intent.mode === 'FOLLOW' && s.world.master.distance > THRESHOLDS.pickupMasterLimit) {
      return null;
    }
    // Filter drops within pickupRadius (5 blocks) and not in cooldown
    for (const drop of s.world.nearbyDrops) {
      if (drop.distance > THRESHOLDS.pickupRadius) continue;
      const cooldownUntil = s.runtime.cooldowns[drop.entityId];
      if (cooldownUntil && cooldownUntil > s.observedAt) continue;
      return drop;
    }
    return null;
  };

  const pickup = guard('PickupItem-ready',
    s => getBestPickupTarget(s) !== null,
    action('PickupItem', s => {
      const drop = getBestPickupTarget(s)!;
      return { actionType: 'PickupItem', targetId: drop.entityId, params: { itemName: drop.itemName } };
    }),
    { exit: s => getBestPickupTarget(s) === null });

  const canCome = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'COME' && s.intent.targetPosition !== null && s.intent.targetPosition !== undefined;

  const comeOnce = guard('ComeOnce-ready',
    s => available.has('ComeOnce') && canCome(s),
    withRecovery('ComeOnce',
      action('ComeOnce', s => {
        const pos = s.intent.targetPosition!;
        return {
          actionType: 'ComeOnce',
          targetId: null,
          params: {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            canDig: s.intent.canDig,
            allowBridge: s.intent.allowBridge,
            missionId: s.intent.missionId,
          },
          requiredResources: getNavResources(s),
        };
      }),
      s => s.intent.targetPosition ? { x: s.intent.targetPosition.x, y: s.intent.targetPosition.y, z: s.intent.targetPosition.z } : null
    ),
    { exit: s => !available.has('ComeOnce') || !canCome(s) });

  const canReturn = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'RETURN' && (s.world.base !== null || s.world.spawnPoint !== null);

  const returnToBase = guard('ReturnToBase-ready',
    s => available.has('ReturnToBase') && canReturn(s),
    withRecovery('ReturnToBase',
      action('ReturnToBase', s => {
        const dest = s.world.base ?? s.world.spawnPoint!;
        return {
          actionType: 'ReturnToBase',
          targetId: null,
          params: {
            x: dest.x,
            y: dest.y,
            z: dest.z,
            canDig: s.intent.canDig,
            allowBridge: s.intent.allowBridge,
            missionId: s.intent.missionId,
          },
          requiredResources: getNavResources(s),
        };
      }),
      s => {
        const dest = s.world.base ?? s.world.spawnPoint;
        return dest ? { x: dest.x, y: dest.y, z: dest.z } : null;
      }
    ),
    { exit: s => !available.has('ReturnToBase') || !canReturn(s) });

  const canSetSpawn = (s: BlackboardSnapshot) =>
    s.world.self.isAlive &&
    s.world.nearbyBed !== null &&
    (s.world.spawnPoint === null || s.world.bedNeedsRefresh) &&
    (s.intent.mode !== 'STAY' || (s.world.nearbyBed && Math.hypot(s.world.nearbyBed.x - s.world.self.position.x, s.world.nearbyBed.z - s.world.self.position.z) <= 2.5));

  const setSpawn = guard('SetSpawn-ready',
    s => available.has('SetSpawn') && canSetSpawn(s),
    action('SetSpawn', s => {
      const bed = s.world.nearbyBed!;
      return {
        actionType: 'SetSpawn',
        targetId: null,
        params: { x: bed.x, y: bed.y, z: bed.z },
      };
    }),
    { exit: s => !available.has('SetSpawn') || !canSetSpawn(s) });

  return reactiveSelector('work', [
    follow('CatchUpFollow', THRESHOLDS.catchUpEnter, THRESHOLDS.catchUpExit),
    pickup,
    comeOnce,
    returnToBase,
    follow('NormalFollow', THRESHOLDS.followEnter, THRESHOLDS.followExit),
    setSpawn,
  ]);
}
