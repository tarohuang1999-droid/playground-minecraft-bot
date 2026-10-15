import type { BlackboardSnapshot, ObservedEntity } from '../../blackboard.ts';
import { THRESHOLDS } from '../../policy.ts';
import { action, guard } from '../nodes.ts';

export function getCombatTarget(s: BlackboardSnapshot, available: ReadonlySet<string>): ObservedEntity | null {
  if (!available.has('Combat') || !s.world.self.isAlive) return null;

  // If in FOLLOW mode and master distance > combatMasterLimit, disengage combat
  if (s.intent.mode === 'FOLLOW' && s.world.master.distance > THRESHOLDS.combatMasterLimit) {
    return null;
  }

  // Target retention: check active combat run first
  const activeCombatRun = Object.values(s.runtime.activeRuns).find(
    r => r.actionType === 'Combat' && r.status === 'RUNNING'
  );
  if (activeCombatRun && activeCombatRun.targetId !== null) {
    const retained = s.world.threats.find(t => t.entityId === activeCombatRun.targetId);
    if (retained && retained.distance <= THRESHOLDS.combatExit) {
      return retained;
    }
  }

  // Otherwise, select the closest threat within combatEnter
  const closest = s.world.threats.find(t => t.distance <= THRESHOLDS.combatEnter);
  return closest ?? null;
}

export function combatSubtree(available: ReadonlySet<string>) {
  return guard(
    'combat-ready',
    s => getCombatTarget(s, available) !== null,
    action('Combat', s => {
      const target = getCombatTarget(s, available)!;
      return {
        actionType: 'Combat',
        targetId: target.entityId,
        params: { entityName: target.name },
      };
    }),
    { exit: s => getCombatTarget(s, available) === null }
  );
}
