import type { BlackboardSnapshot } from '../../blackboard.ts';
import { THRESHOLDS } from '../../policy.ts';
import { action, guard } from '../nodes.ts';

export function shouldRetreat(s: BlackboardSnapshot, available: ReadonlySet<string>): boolean {
  if (!available.has('Retreat') || !s.world.self.isAlive) return false;

  const nearbyThreats = s.world.threats.filter(t => t.distance <= THRESHOLDS.retreatEnter);
  if (nearbyThreats.length === 0) return false;

  // Factor 1: Low health (<= 6) with nearby threats
  const lowHealth = s.world.self.health <= THRESHOLDS.retreatHealth;

  // Factor 2: Swarmed by too many hostile mobs (>= 3) within 12 blocks
  const swarmed = nearbyThreats.length >= THRESHOLDS.retreatMobCount;

  return lowHealth || swarmed;
}

export function shouldExitRetreat(s: BlackboardSnapshot, available: ReadonlySet<string>): boolean {
  if (!available.has('Retreat') || !s.world.self.isAlive) return true;

  const threatsInRange = s.world.threats.filter(t => t.distance < THRESHOLDS.retreatExit);
  if (threatsInRange.length === 0) {
    return true;
  }

  // If health has recovered to safe level (>= 10) and no longer swarmed (< 3 mobs), can exit
  if (s.world.self.health >= THRESHOLDS.emergencyHealth && threatsInRange.length < THRESHOLDS.retreatMobCount) {
    return true;
  }

  return false;
}

export function survivalSubtree(available: ReadonlySet<string>) {
  return guard(
    'survival',
    s => shouldRetreat(s, available),
    action('Retreat', () => ({ actionType: 'Retreat', targetId: null, params: {} })),
    { exit: s => shouldExitRetreat(s, available) }
  );
}
