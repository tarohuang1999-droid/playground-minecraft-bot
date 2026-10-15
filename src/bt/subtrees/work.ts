import type { BlackboardSnapshot } from '../../blackboard.ts';
import { THRESHOLDS } from '../../policy.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function workSubtree(available: ReadonlySet<string>) {
  const canFollow = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'FOLLOW' && s.world.master.entityId !== null;

  const follow = (type: 'CatchUpFollow' | 'NormalFollow', enter: number, exit: number) =>
    guard(`${type}-ready`, s => available.has(type) && canFollow(s) && s.world.master.distance > enter,
      action(type, s => ({ actionType: type, targetId: s.world.master.entityId, params: {} })),
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
    action('ComeOnce', s => {
      const pos = s.intent.targetPosition!;
      return {
        actionType: 'ComeOnce',
        targetId: null,
        params: { x: pos.x, y: pos.y, z: pos.z },
      };
    }),
    { exit: s => !available.has('ComeOnce') || !canCome(s) });

  const canReturn = (s: BlackboardSnapshot) =>
    s.world.self.isAlive && s.intent.mode === 'RETURN' && (s.world.base !== null || s.world.spawnPoint !== null);

  const returnToBase = guard('ReturnToBase-ready',
    s => available.has('ReturnToBase') && canReturn(s),
    action('ReturnToBase', s => {
      const dest = s.world.base ?? s.world.spawnPoint!;
      return {
        actionType: 'ReturnToBase',
        targetId: null,
        params: { x: dest.x, y: dest.y, z: dest.z },
      };
    }),
    { exit: s => !available.has('ReturnToBase') || !canReturn(s) });

  return reactiveSelector('work', [
    follow('CatchUpFollow', THRESHOLDS.catchUpEnter, THRESHOLDS.catchUpExit),
    pickup,
    comeOnce,
    returnToBase,
    follow('NormalFollow', THRESHOLDS.followEnter, THRESHOLDS.followExit),
  ]);
}
