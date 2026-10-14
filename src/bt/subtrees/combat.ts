import { action, guard } from '../nodes.ts';
import { THRESHOLDS } from '../../policy.ts';

// Stage 4 adds target retention and disengagement; no hostile classification here.
export function combatSubtree(available: ReadonlySet<string>) {
  return guard('combat-ready', s => available.has('Combat') && s.world.self.isAlive &&
    s.world.threats.some(t => t.distance <= THRESHOLDS.combatEnter),
  action('combat', s => ({ actionType: 'Combat', targetId: s.world.threats.find(t => t.distance <= THRESHOLDS.combatEnter)!.entityId, params: {} })));
}
