import { THRESHOLDS } from '../../policy.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function maintenanceSubtree(available: ReadonlySet<string>) {
  return reactiveSelector('maintenance', [
    guard(
      'emergency-food',
      s =>
        available.has('EmergencyEat') &&
        s.world.self.isAlive &&
        s.world.inventory.bestFood !== null &&
        s.world.self.food < 20 &&
        (s.world.self.health <= THRESHOLDS.emergencyHealth ||
          s.world.self.food <= THRESHOLDS.emergencyFood),
      action('emergency-eat', s => ({
        actionType: 'EmergencyEat',
        targetId: null,
        params: { foodItemId: s.world.inventory.bestFood!.itemId },
      })),
      {
        exit: s =>
          !available.has('EmergencyEat') ||
          !s.world.self.isAlive ||
          s.world.inventory.bestFood === null ||
          s.world.self.food >= 20,
      }
    ),
    guard(
      'routine-food',
      s =>
        available.has('RoutineEat') &&
        s.world.self.isAlive &&
        s.world.inventory.bestFood !== null &&
        s.world.self.food <= THRESHOLDS.routineFood,
      action('routine-eat', s => ({
        actionType: 'RoutineEat',
        targetId: null,
        params: { foodItemId: s.world.inventory.bestFood!.itemId },
      })),
      {
        exit: s =>
          !available.has('RoutineEat') ||
          !s.world.self.isAlive ||
          s.world.inventory.bestFood === null ||
          s.world.self.food >= 20,
      }
    ),
    guard(
      'equipment',
      s =>
        available.has('EquipBest') &&
        s.world.self.isAlive &&
        s.world.threats.length === 0 &&
        s.intent.mode !== 'FARM' &&
        (s.world.inventory.pendingArmorUpgrade !== null ||
          (!s.world.inventory.heldItemName &&
            (s.world.inventory.bestWeapon?.attackDamage ?? 0) >
              s.world.inventory.equippedWeaponDamage) ||
          (s.world.inventory.equippedWeaponDamage > 0 &&
            (s.world.inventory.bestWeapon?.attackDamage ?? 0) >
              s.world.inventory.equippedWeaponDamage)),
      action('equip', () => ({ actionType: 'EquipBest', targetId: null, params: {} })),
      {
        exit: s =>
          !available.has('EquipBest') ||
          !s.world.self.isAlive ||
          s.intent.mode === 'FARM' ||
          (s.world.inventory.pendingArmorUpgrade === null &&
            (s.world.inventory.bestWeapon?.attackDamage ?? 0) <=
              s.world.inventory.equippedWeaponDamage),
      }
    ),
  ]);
}
