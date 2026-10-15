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

  return reactiveSelector('work', [
    follow('CatchUpFollow', THRESHOLDS.catchUpEnter, THRESHOLDS.catchUpExit),
    pickup,
    follow('NormalFollow', THRESHOLDS.followEnter, THRESHOLDS.followExit),
  ]);
}
