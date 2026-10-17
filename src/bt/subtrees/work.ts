import type { BlackboardSnapshot, Position } from '../../blackboard.ts';
import { THRESHOLDS, type ResourceChannel } from '../../policy.ts';
import { action, guard, reactiveSelector, retry, type BtNode } from '../nodes.ts';
import type { NavigationLogger } from '../../actions/navigation.ts';
import { navigationConfig, survivalConfig } from '../../config/index.ts';

export interface WorkSubtreeOptions {
  onNavigationFailed?: ((reason: string, missionId: string) => void) | undefined;
  onFarmingFinished?: ((reason: 'TIMEOUT' | 'COMPLETED', missionId: string) => void) | undefined;
  onHuntingFinished?: ((reason: 'TIMEOUT' | 'COMPLETED', missionId: string) => void) | undefined;
  logger?: NavigationLogger | undefined;
  getAvailableFarmland?: ((rallyPoint: Position, maxRadius: number) => Position | null) | undefined;
  getHuntableAnimal?:
    | ((
        rallyPoint: Position,
        maxRadius: number,
        targetAnimal?: string | null,
        currentTargetId?: number | null
      ) => { entityId: number; name: string; position: Position; distance: number } | null)
    | undefined;
}

export function workSubtree(available: ReadonlySet<string>, options?: WorkSubtreeOptions) {
  const logger = options?.logger;
  const getNavResources = (s: BlackboardSnapshot): readonly ResourceChannel[] => {
    if (s.intent.canDig || s.intent.allowBridge) {
      return ['MOVE', 'LOOK', 'HAND', 'INVENTORY'];
    }
    return ['MOVE', 'LOOK'];
  };

  const withRecovery = (id: string, primaryNode: BtNode) => {
    return retry(`${id}-recovery`, primaryNode, {
      maxRetries: navigationConfig.recoveryMaxRetries,
      onFinalFailure: ctx => {
        const missionId = ctx.snapshot.intent.missionId ?? '';
        logger?.warn(
          `[recovery] ${id} navigation attempts exhausted; navigation failed for mission "${missionId}"`
        );
        options?.onNavigationFailed?.(
          'Path obstructed. Stopped; send !follow, !come or !return to retry.',
          missionId
        );
      },
    });
  };

  const canFollow = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'FOLLOW' && s.world.master.entityId !== null;

  const follow = (type: 'CatchUpFollow' | 'NormalFollow', enter: number, exit: number) =>
    guard(
      `${type}-ready`,
      s => available.has(type) && canFollow(s) && s.world.master.distance > enter,
      withRecovery(
        type,
        action(type, s => ({
          actionType: type,
          targetId: s.world.master.entityId,
          params: {
            canDig: s.intent.canDig,
            allowBridge: s.intent.allowBridge,
            missionId: s.intent.missionId,
          },
          requiredResources: getNavResources(s),
        }))
      ),
      { exit: s => !available.has(type) || !canFollow(s) || s.world.master.distance <= exit }
    );

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

  const pickup = guard(
    'PickupItem-ready',
    s => getBestPickupTarget(s) !== null,
    action('PickupItem', s => {
      const drop = getBestPickupTarget(s)!;
      return {
        actionType: 'PickupItem',
        targetId: drop.entityId,
        params: { itemName: drop.itemName },
      };
    }),
    { exit: s => getBestPickupTarget(s) === null }
  );

  const canCome = (s: BlackboardSnapshot) =>
    s.world.self.isAlive &&
    s.intent.mode === 'COME' &&
    s.intent.targetPosition !== null &&
    s.intent.targetPosition !== undefined;

  const comeOnce = guard(
    'ComeOnce-ready',
    s => available.has('ComeOnce') && canCome(s),
    withRecovery(
      'ComeOnce',
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
      })
    ),
    { exit: s => !available.has('ComeOnce') || !canCome(s) }
  );

  const canReturn = (s: BlackboardSnapshot) =>
    s.world.self.isAlive &&
    s.intent.mode === 'RETURN' &&
    (s.world.base !== null || s.world.spawnPoint !== null);

  const returnToBase = guard(
    'ReturnToBase-ready',
    s => available.has('ReturnToBase') && canReturn(s),
    withRecovery(
      'ReturnToBase',
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
      })
    ),
    { exit: s => !available.has('ReturnToBase') || !canReturn(s) }
  );

  const canSetSpawn = (s: BlackboardSnapshot) =>
    s.world.self.isAlive &&
    s.world.nearbyBed !== null &&
    (s.world.spawnPoint === null || s.world.bedNeedsRefresh) &&
    (s.intent.mode !== 'STAY' ||
      (s.world.nearbyBed &&
        Math.hypot(
          s.world.nearbyBed.x - s.world.self.position.x,
          s.world.nearbyBed.z - s.world.self.position.z
        ) <= survivalConfig.bed.reachDistance));

  const setSpawn = guard(
    'SetSpawn-ready',
    s => available.has('SetSpawn') && canSetSpawn(s),
    action('SetSpawn', s => {
      const bed = s.world.nearbyBed!;
      return {
        actionType: 'SetSpawn',
        targetId: null,
        params: { x: bed.x, y: bed.y, z: bed.z },
      };
    }),
    { exit: s => !available.has('SetSpawn') || !canSetSpawn(s) }
  );

  const canFarm = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'FARM' && !!s.intent.workArea;

  const isFarmingActive = (s: BlackboardSnapshot) => {
    if (!canFarm(s)) return false;
    const workArea = s.intent.workArea!;
    const elapsed = s.observedAt - workArea.startedAt;
    if (elapsed >= workArea.maxDurationMs) return false;
    const seeds = s.world.inventory.plantableSeeds ?? [];
    const hasSeeds = seeds.some(seed => !workArea.cropType || seed.cropType === workArea.cropType);
    if (!hasSeeds) return false;
    const farmland = options?.getAvailableFarmland?.(workArea.rallyPoint, workArea.maxRadius);
    return farmland !== null && farmland !== undefined;
  };

  const farmPlant = guard(
    'FarmPlant-ready',
    s => available.has('FarmPlant') && isFarmingActive(s),
    action('FarmPlant', s => {
      const workArea = s.intent.workArea!;
      const seeds = s.world.inventory.plantableSeeds ?? [];
      const matchingSeed = workArea.cropType
        ? seeds.find(sd => sd.cropType === workArea.cropType)
        : seeds[0];
      const getFarmland = options?.getAvailableFarmland;
      const farmland = getFarmland ? getFarmland(workArea.rallyPoint, workArea.maxRadius) : null;
      const targetPos = farmland ?? workArea.rallyPoint;
      return {
        actionType: 'FarmPlant',
        targetId: null,
        params: {
          x: targetPos.x,
          y: targetPos.y,
          z: targetPos.z,
          seedItem: matchingSeed?.name ?? 'wheat_seeds',
          cropType: matchingSeed?.cropType ?? 'wheat',
        },
      };
    }),
    { exit: s => !available.has('FarmPlant') || !isFarmingActive(s) }
  );

  const isFarmingFinished = (s: BlackboardSnapshot) => canFarm(s) && !isFarmingActive(s);

  const farmFinish = guard(
    'FarmFinish-ready',
    s => isFarmingFinished(s),
    action('FarmFinish', s => {
      const workArea = s.intent.workArea!;
      const elapsed = s.observedAt - workArea.startedAt;
      const reason = elapsed >= workArea.maxDurationMs ? 'TIMEOUT' : 'COMPLETED';
      options?.onFarmingFinished?.(reason, s.intent.missionId);
      return {
        actionType: 'Idle',
        targetId: null,
        params: {},
      };
    }),
    { exit: s => !isFarmingFinished(s) }
  );

  const canHunt = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'HUNT' && !!s.intent.workArea;

  const getActiveHuntTargetId = (s: BlackboardSnapshot): number | null => {
    const activeHuntRun = Object.values(s.runtime.activeRuns).find(
      r => r.actionType === 'HuntAnimal' && r.status === 'RUNNING'
    );
    return activeHuntRun?.targetId ?? null;
  };

  const isHuntingActive = (s: BlackboardSnapshot) => {
    if (!canHunt(s)) return false;
    const workArea = s.intent.workArea!;
    const elapsed = s.observedAt - workArea.startedAt;
    if (elapsed >= workArea.maxDurationMs) return false;
    const currentTargetId = getActiveHuntTargetId(s);
    const animal = options?.getHuntableAnimal?.(
      workArea.rallyPoint,
      workArea.maxRadius,
      workArea.targetAnimal,
      currentTargetId
    );
    return animal !== null && animal !== undefined;
  };

  const huntAnimal = guard(
    'HuntAnimal-ready',
    s => available.has('HuntAnimal') && isHuntingActive(s),
    action('HuntAnimal', s => {
      const workArea = s.intent.workArea!;
      const currentTargetId = getActiveHuntTargetId(s);
      const animal = options?.getHuntableAnimal?.(
        workArea.rallyPoint,
        workArea.maxRadius,
        workArea.targetAnimal,
        currentTargetId
      );
      return {
        actionType: 'HuntAnimal',
        targetId: animal?.entityId ?? null,
        params: {
          rallyX: workArea.rallyPoint.x,
          rallyY: workArea.rallyPoint.y,
          rallyZ: workArea.rallyPoint.z,
          maxRadius: workArea.maxRadius,
          targetAnimal: workArea.targetAnimal ?? '',
        },
      };
    }),
    { exit: s => !available.has('HuntAnimal') || !isHuntingActive(s) }
  );

  const isHuntingFinished = (s: BlackboardSnapshot) => canHunt(s) && !isHuntingActive(s);

  const huntFinish = guard(
    'HuntFinish-ready',
    s => isHuntingFinished(s),
    action('HuntFinish', s => {
      const workArea = s.intent.workArea!;
      const elapsed = s.observedAt - workArea.startedAt;
      const reason = elapsed >= workArea.maxDurationMs ? 'TIMEOUT' : 'COMPLETED';
      options?.onHuntingFinished?.(reason, s.intent.missionId);
      return {
        actionType: 'Idle',
        targetId: null,
        params: {},
      };
    }),
    { exit: s => !isHuntingFinished(s) }
  );

  return reactiveSelector('work', [
    follow('CatchUpFollow', THRESHOLDS.catchUpEnter, THRESHOLDS.catchUpExit),
    pickup,
    huntAnimal,
    farmPlant,
    comeOnce,
    returnToBase,
    huntFinish,
    farmFinish,
    follow('NormalFollow', THRESHOLDS.followEnter, THRESHOLDS.followExit),
    setSpawn,
  ]);
}
