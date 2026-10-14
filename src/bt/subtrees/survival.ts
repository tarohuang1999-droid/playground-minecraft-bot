import { action, guard } from '../nodes.ts';
import { THRESHOLDS } from '../../policy.ts';

// Stage 2 guard/request skeleton; retreat latch and safe-time tracking belong to Stage 5.
export function survivalSubtree(available: ReadonlySet<string>) {
  return guard('survival', s => available.has('Retreat') && s.world.self.isAlive &&
    s.world.self.health <= THRESHOLDS.retreatHealth && s.world.threats.some(t => t.distance <= THRESHOLDS.retreatEnter),
  action('retreat', () => ({ actionType: 'Retreat', targetId: null, params: {} })));
}
