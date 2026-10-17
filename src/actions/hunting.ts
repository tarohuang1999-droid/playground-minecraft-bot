import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { getWeaponDamage } from '../perception.ts';
import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
} from '../execution/types.ts';
import type { Position } from '../blackboard.ts';

const { GoalNear, GoalFollow } = goals;

export interface HuntingEntity {
  id: number;
  position: { x: number; y: number; z: number };
  height?: number;
  isValid?: boolean;
  health?: number;
  name?: string;
  type?: string;
}

export interface HuntingBot {
  entity?: {
    position: { x: number; y: number; z: number };
    height?: number;
  };
  pathfinder?: {
    setGoal(goal: unknown, dynamic?: boolean): void;
    setMovements?(movements: unknown): void;
  };
  entities: Record<string | number, HuntingEntity>;
  inventory: {
    items(): any[];
    slots?: any[];
  };
  heldItem?: any;
  quickBarSlot?: number;
  equip?(item: any, destination: string): Promise<void>;
  attack?(target: any): void | Promise<void>;
  lookAt?(position: any, force?: boolean): Promise<void>;
  setControlState?(control: string, state: boolean): void;
}

export interface HuntingLogger {
  info(m: string, d?: unknown): void;
  warn(m: string, d?: unknown): void;
  error?(m: string, d?: unknown): void;
}

export interface HuntingOptions {
  now?: (() => number) | undefined;
  onAnimalAttacked?: ((entityId: number, animalName: string) => void) | undefined;
  onAnimalKilled?: ((animalName: string, entityId: number) => void) | undefined;
  onAnimalEscaped?: ((entityId: number) => void) | undefined;
}

export function createHunting(
  bot: HuntingBot,
  options: HuntingOptions = {},
  logger?: HuntingLogger
) {
  const getNow = () => (options.now ? options.now() : Date.now());

  return {
    huntAnimal(request: ActionRequest): ActionAdapter {
      let active = true;
      let hasAttacked = false;
      let targetIsDead = false;
      let lastAttackTime = 0;
      let finishedResult: ActionResult | null = null;
      let targetName = 'animal';

      const targetId = request.targetId;
      const rallyPoint: Position = {
        x: Number(request.params?.rallyX ?? 0),
        y: Number(request.params?.rallyY ?? 0),
        z: Number(request.params?.rallyZ ?? 0),
      };
      const maxRadius: number = Number(request.params?.maxRadius ?? 25);

      const onDead = (deadEntity: any) => {
        if (deadEntity && deadEntity.id === targetId) {
          targetIsDead = true;
        }
      };

      if (typeof (bot as any).on === 'function') {
        (bot as any).on('entityDead', onDead);
      }

      function cleanupListeners() {
        if (typeof (bot as any).removeListener === 'function') {
          (bot as any).removeListener('entityDead', onDead);
        }
      }

      return {
        async start(ctx: ActionContext): Promise<void | ActionResult> {
          if (!ctx.isActive()) {
            cleanupListeners();
            return;
          }
          active = true;
          finishedResult = null;

          if (!bot.pathfinder) {
            cleanupListeners();
            logger?.warn('[hunting] cannot hunt: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }

          if (targetId === null) {
            cleanupListeners();
            logger?.warn('[hunting] cannot hunt: targetId is null');
            return { status: 'FAILURE', reason: 'TargetId is null' };
          }

          const target = (bot.entities as any)[targetId];
          if (!target) {
            cleanupListeners();
            logger?.warn(`[hunting] target ${targetId} not found in bot.entities`);
            return { status: 'FAILURE', reason: 'Target animal not found' };
          }

          targetName = target.name ?? 'animal';
          logger?.info(`[hunting] started hunting ${targetName} (id=${targetId})`);

          // 1. Equip best weapon if available
          const snapshot = ctx.getSnapshot();
          const bestWeapon = snapshot.world.inventory.bestWeapon;
          if (bestWeapon && typeof bot.equip === 'function') {
            const heldItem =
              bot.heldItem ??
              (bot.inventory?.slots ? bot.inventory.slots[36 + (bot.quickBarSlot ?? 0)] : null);
            const currentDamage = heldItem ? getWeaponDamage(heldItem.name) : 0;
            if (bestWeapon.attackDamage > currentDamage) {
              const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
              const weaponItem = items.find(
                (i: any) => i.name === bestWeapon.name || (i.type ?? i.id) === bestWeapon.itemId
              );
              if (weaponItem) {
                logger?.info(
                  `[hunting] equipping weapon ${weaponItem.name} (dmg=${bestWeapon.attackDamage} > held=${currentDamage})`
                );
                try {
                  await bot.equip(weaponItem, 'hand');
                } catch (err) {
                  if (!active || !ctx.isActive()) {
                    cleanupListeners();
                    return;
                  }
                  logger?.warn(`[hunting] failed to equip weapon: ${err}`);
                }
              }
            }
          }

          if (!active || !ctx.isActive()) {
            cleanupListeners();
            return;
          }

          // 2. Set movement goal towards animal
          try {
            if (GoalFollow) {
              bot.pathfinder.setGoal(new GoalFollow(target, 1.8), true);
            } else if (GoalNear) {
              bot.pathfinder.setGoal(
                new GoalNear(target.position.x, target.position.y, target.position.z, 1.8)
              );
            }
          } catch (err) {
            if (!active || !ctx.isActive()) {
              cleanupListeners();
              return;
            }
            logger?.warn(`[hunting] setGoal error: ${err}`);
          }
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!active || !ctx.isActive()) return;
          if (finishedResult) return finishedResult;

          if (targetId === null) {
            cleanupListeners();
            return { status: 'FAILURE', reason: 'TargetId is null' };
          }

          const target = (bot.entities as any)[targetId];
          const isDeadOrGone =
            targetIsDead ||
            !target ||
            target.isValid === false ||
            (target.health !== undefined && target.health <= 0);

          // Check if target died or despawned
          if (isDeadOrGone) {
            cleanupListeners();
            bot.pathfinder?.setGoal(null);
            if (hasAttacked) {
              logger?.info(`[hunting] ${targetName} (id=${targetId}) is down`);
              options.onAnimalKilled?.(targetName, targetId);
              finishedResult = { status: 'SUCCESS' };
            } else {
              logger?.info(
                `[hunting] target ${targetName} (id=${targetId}) disappeared or died without being attacked`
              );
              finishedResult = {
                status: 'FAILURE',
                reason: 'Target lost or died before attack',
              };
            }
            return finishedResult;
          }

          // Check boundary constraint: distance from rally point <= maxRadius
          const dx = target.position.x - rallyPoint.x;
          const dz = target.position.z - rallyPoint.z;
          if (Math.hypot(dx, dz) > maxRadius) {
            cleanupListeners();
            logger?.info(
              `[hunting] target ${targetName} (id=${targetId}) fled outside rally radius (${maxRadius}), aborting chase`
            );
            options.onAnimalEscaped?.(targetId);
            finishedResult = { status: 'SUCCESS' };
            bot.pathfinder?.setGoal(null);
            return finishedResult;
          }

          // Attack check
          const botPos = bot.entity?.position;
          if (!botPos) return;

          const dist = Math.hypot(
            botPos.x - target.position.x,
            botPos.y - target.position.y,
            botPos.z - target.position.z
          );

          const now = getNow();
          if (dist <= 3.0 && now - lastAttackTime >= 600) {
            lastAttackTime = now;
            if (typeof bot.lookAt === 'function') {
              const lookTarget = new Vec3(
                target.position.x,
                target.position.y + (target.height ?? 1) * 0.5,
                target.position.z
              );
              bot.lookAt(lookTarget, true).catch(() => {});
            }
            if (typeof bot.attack === 'function') {
              try {
                bot.attack(target);
                hasAttacked = true;
                options.onAnimalAttacked?.(targetId, targetName);
              } catch (err) {
                if (!active || !ctx.isActive()) return;
                logger?.warn(`[hunting] attack error: ${err}`);
              }
            }
          }
        },

        cancel(): void {
          active = false;
          cleanupListeners();
          bot.pathfinder?.setGoal(null);
        },

        isStopped(): boolean {
          return !active;
        },
      };
    },
  };
}
