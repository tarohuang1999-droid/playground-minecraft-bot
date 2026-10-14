import { THRESHOLDS } from '../../policy.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function maintenanceSubtree(available: ReadonlySet<string>) {
  return reactiveSelector('maintenance', [
    guard('emergency-food', s => available.has('EmergencyEat') && s.world.self.isAlive && s.world.inventory.bestFood !== null && s.world.self.food < 20 &&
      (s.world.self.health <= THRESHOLDS.emergencyHealth || s.world.self.food <= THRESHOLDS.emergencyFood),
    action('emergency-eat', () => ({ actionType: 'EmergencyEat', targetId: null, params: {} }))),
    guard('routine-food', s => available.has('RoutineEat') && s.world.self.isAlive && s.world.inventory.bestFood !== null && s.world.self.food <= THRESHOLDS.routineFood,
    action('routine-eat', () => ({ actionType: 'RoutineEat', targetId: null, params: {} }))),
    guard('equipment', s => available.has('EquipBest') && s.world.self.isAlive && s.world.threats.length === 0 &&
      (s.world.inventory.pendingArmorUpgrade !== null || (s.world.inventory.bestWeapon?.attackDamage ?? 0) > s.world.inventory.equippedWeaponDamage),
    action('equip', () => ({ actionType: 'EquipBest', targetId: null, params: {} }))),
  ]);
}
