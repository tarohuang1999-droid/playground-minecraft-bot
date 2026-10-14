import type { BlackboardSnapshot } from '../../blackboard.ts';
import { THRESHOLDS } from '../../policy.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function workSubtree(available: ReadonlySet<string>) {
  const canFollow = (s: BlackboardSnapshot) => s.world.self.isAlive && s.intent.mode === 'FOLLOW' && s.world.master.entityId !== null;
  const follow = (type: 'CatchUpFollow' | 'NormalFollow', enter: number, exit: number) =>
    guard(`${type}-ready`, s => available.has(type) && canFollow(s) && s.world.master.distance > enter,
      action(type, s => ({ actionType: type, targetId: s.world.master.entityId, params: {} })),
      { exit: s => !available.has(type) || !canFollow(s) || s.world.master.distance <= exit });
  // Stage 6 adds pickup selection, timeout and cooldown-aware filtering between these branches.
  return reactiveSelector('work', [
    follow('CatchUpFollow', THRESHOLDS.catchUpEnter, THRESHOLDS.catchUpExit),
    follow('NormalFollow', THRESHOLDS.followEnter, THRESHOLDS.followExit),
  ]);
}
