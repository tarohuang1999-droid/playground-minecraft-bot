import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
  AdapterFactory,
} from '../execution/types.ts';
import { ARMOR_SLOTS, getArmorInfo, getFoodPoints } from '../perception.ts';

export interface InventoryBot {
  equip(item: any, destination: string): Promise<void>;
  consume(): Promise<void>;
  deactivateItem?(): void;
  inventory: {
    items(): any[];
    slots?: any[];
  };
}

export interface InventoryLogger {
  info(m: string, d?: unknown): void;
  warn(m: string, d?: unknown): void;
  error?(m: string, d?: unknown): void;
}

export function createInventoryAdapters(bot: InventoryBot, logger?: InventoryLogger) {
  function eatAdapter(actionType: 'RoutineEat' | 'EmergencyEat'): AdapterFactory {
    return (_request: ActionRequest): ActionAdapter => {
      let isConsuming = false;

      return {
        async start(ctx: ActionContext): Promise<void | ActionResult> {
          if (!ctx.isActive()) return;

          const snapshot = ctx.getSnapshot();
          const bestFood = snapshot.world.inventory.bestFood;
          const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];

          let foodItem = bestFood
            ? items.find(
                i =>
                  i.name === bestFood.name || i.type === bestFood.itemId || i.id === bestFood.itemId
              )
            : null;

          if (!foodItem) {
            foodItem = items.find(i => getFoodPoints(i.name) > 0);
          }

          if (!foodItem) {
            logger?.warn(`[inventory] cannot eat: no food found in inventory`);
            return { status: 'FAILURE', reason: 'No food available in inventory' };
          }

          logger?.info(`[inventory] ${actionType} equipping ${foodItem.name} to hand`);
          try {
            await bot.equip(foodItem, 'hand');
          } catch (err: any) {
            if (!ctx.isActive()) return;
            logger?.warn(
              `[inventory] failed to equip food ${foodItem.name}: ${err?.message ?? err}`
            );
            return { status: 'FAILURE', reason: `Equip food failed: ${err?.message ?? err}` };
          }
          if (!ctx.isActive()) return; // [RULE-04]

          isConsuming = true;
          logger?.info(`[inventory] ${actionType} consuming ${foodItem.name}...`);
          try {
            await bot.consume();
          } catch (err: any) {
            isConsuming = false;
            if (!ctx.isActive()) return; // [RULE-04] Interrupted by preemption
            logger?.warn(`[inventory] consume failed: ${err?.message ?? err}`);
            return { status: 'FAILURE', reason: `Consume failed: ${err?.message ?? err}` };
          }
          isConsuming = false;
          if (!ctx.isActive()) return; // [RULE-04]

          logger?.info(`[inventory] ${actionType} successfully consumed ${foodItem.name}`);
          return { status: 'SUCCESS' };
        },

        cancel() {
          logger?.info(`[inventory] ${actionType} cancelled`);
          if (isConsuming) {
            bot.deactivateItem?.();
            isConsuming = false;
          }
        },
      };
    };
  }

  function equipBestAdapter(): AdapterFactory {
    return (_request: ActionRequest): ActionAdapter => {
      return {
        async start(ctx: ActionContext): Promise<void | ActionResult> {
          if (!ctx.isActive()) return;

          const slots = ['head', 'torso', 'legs', 'feet'] as const;
          let equippedAny = false;

          for (const slot of slots) {
            if (!ctx.isActive()) return; // [RULE-04]
            const slotIdx = ARMOR_SLOTS[slot];
            const equipped = bot.inventory.slots?.[slotIdx];
            const equippedTier = equipped ? (getArmorInfo(equipped.name)?.tier ?? 0) : 0;

            const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
            const candidates = items
              .filter(i => {
                if (i.slot === slotIdx) return false;
                const info = getArmorInfo(i.name);
                return info && info.slot === slot && info.tier > equippedTier;
              })
              .sort(
                (a, b) => (getArmorInfo(b.name)?.tier ?? 0) - (getArmorInfo(a.name)?.tier ?? 0)
              );

            const bestUpgrade = candidates[0];
            if (bestUpgrade) {
              logger?.info(`[inventory] equipping armor upgrade ${bestUpgrade.name} to ${slot}`);
              try {
                await bot.equip(bestUpgrade, slot);
                equippedAny = true;
              } catch (err: any) {
                if (!ctx.isActive()) return;
                logger?.warn(
                  `[inventory] equip armor error for ${bestUpgrade.name}: ${err?.message ?? err}`
                );
              }
              if (!ctx.isActive()) return; // [RULE-04]
            }
          }

          // Equip best weapon if better than equipped (and not intentionally holding non-weapon item)
          const snapshot = ctx.getSnapshot();
          const bestWp = snapshot.world.inventory.bestWeapon;
          const currentHeldName = (bot as any).heldItem?.name;
          const isHoldingNonWeapon = !!currentHeldName && snapshot.world.inventory.equippedWeaponDamage === 0;
          if (
            bestWp &&
            !isHoldingNonWeapon &&
            bestWp.attackDamage > snapshot.world.inventory.equippedWeaponDamage
          ) {
            const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
            const wpItem = items.find(
              i => i.name === bestWp.name || i.type === bestWp.itemId || i.id === bestWp.itemId
            );
            if (wpItem) {
              logger?.info(`[inventory] equipping best weapon ${wpItem.name} to hand`);
              try {
                await bot.equip(wpItem, 'hand');
                equippedAny = true;
              } catch (err: any) {
                if (!ctx.isActive()) return;
                logger?.warn(
                  `[inventory] equip weapon error for ${wpItem.name}: ${err?.message ?? err}`
                );
              }
              if (!ctx.isActive()) return; // [RULE-04]
            }
          }

          if (equippedAny) {
            logger?.info('[inventory] EquipBest successfully upgraded items');
          }
          return { status: 'SUCCESS' };
        },

        cancel() {
          logger?.info('[inventory] EquipBest cancelled');
        },
      };
    };
  }

  return {
    routineEat: eatAdapter('RoutineEat'),
    emergencyEat: eatAdapter('EmergencyEat'),
    equipBest: equipBestAdapter(),
  };
}
