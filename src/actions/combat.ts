import { goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { THRESHOLDS } from '../policy.ts';
import { getWeaponDamage } from '../perception.ts';
import type { ActionAdapter, ActionContext, ActionRequest, ActionResult, AdapterFactory } from '../execution/types.ts';

const { GoalFollow } = goals;

export interface CombatEntity {
  id: number;
  position: { x: number; y: number; z: number };
  height?: number;
  isValid?: boolean;
  health?: number;
  name?: string;
  type?: string;
}

export interface CombatBot {
  entity?: {
    position: { x: number; y: number; z: number };
    height?: number;
  };
  pathfinder?: {
    setGoal(goal: unknown, dynamic?: boolean): void;
    setMovements?(movements: unknown): void;
  };
  entities: Record<string | number, CombatEntity>;
  inventory: {
    items(): any[];
    slots?: any[];
  };
  heldItem?: any;
  quickBarSlot?: number;
  equip?(item: any, destination: string): Promise<void>;
  attack?(target: any): void | Promise<void>;
  lookAt?(position: any, force?: boolean): Promise<void>;
}

export interface CombatLogger {
  info(m: string, d?: unknown): void;
  warn(m: string, d?: unknown): void;
  error?(m: string, d?: unknown): void;
}

export function createCombatAdapter(
  bot: CombatBot,
  logger?: CombatLogger,
  options?: { isThreat?: (targetId: number) => boolean; onAttack?: (targetId: number) => void }
): AdapterFactory {
  return (request: ActionRequest): ActionAdapter => {
    let activeGoal: unknown = null;
    let lastAttackTime = 0;
    const targetId = request.targetId;

    return {
      async start(ctx: ActionContext): Promise<void | ActionResult> {
        if (!ctx.isActive()) return;

        if (!bot.pathfinder) {
          logger?.warn('[combat] cannot fight: pathfinder is not loaded');
          return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
        }

        if (targetId === null) {
          logger?.warn('[combat] cannot fight: targetId is null');
          return { status: 'FAILURE', reason: 'TargetId is null' };
        }

        const target = (bot.entities as any)[targetId];
        if (!target) {
          logger?.warn(`[combat] target ${targetId} not found in bot.entities`);
          return { status: 'FAILURE', reason: 'Target entity not found' };
        }

        // 1. Weapon check & auto-equip:
        const snapshot = ctx.getSnapshot();
        const bestWeapon = snapshot.world.inventory.bestWeapon;
        if (bestWeapon && typeof bot.equip === 'function') {
          const heldItem = bot.heldItem ?? (bot.inventory?.slots ? bot.inventory.slots[36 + (bot.quickBarSlot ?? 0)] : null);
          const currentDamage = heldItem ? getWeaponDamage(heldItem.name) : 0;
          if (bestWeapon.attackDamage > currentDamage) {
            const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
            const weaponItem = items.find((i: any) => i.name === bestWeapon.name || (i.type ?? i.id) === bestWeapon.itemId);
            if (weaponItem) {
              logger?.info(`[combat] equipping weapon ${weaponItem.name} (dmg=${bestWeapon.attackDamage} > held=${currentDamage})`);
              try {
                await bot.equip(weaponItem, 'hand');
              } catch (err: any) {
                if (!ctx.isActive()) return;
                logger?.warn(`[combat] failed to equip weapon: ${err?.message ?? err}`);
              }
              if (!ctx.isActive()) return; // [RULE-04]
            }
          }
        }

        // 2. Chasing goal:
        if ((bot.pathfinder as any)?.movements) {
          (bot.pathfinder as any).movements.canDig = false;
        }
        activeGoal = new GoalFollow(target as any, 2.5);
        bot.pathfinder.setGoal(activeGoal, true);
        logger?.info(`[combat] initiated GoalFollow chase for target ${target.name ?? targetId} (id=${targetId})`);
      },

      update(ctx: ActionContext): void | ActionResult {
        if (!ctx.isActive()) return;

        if (targetId === null) {
          bot.pathfinder?.setGoal(null);
          return { status: 'FAILURE', reason: 'TargetId is null' };
        }

        const target = (bot.entities as any)[targetId];
        // Target defeated or removed check
        if (!target || target.isValid === false || (target.health !== undefined && target.health <= 0)) {
          logger?.info(`[combat] target ${targetId} eliminated or despawned`);
          bot.pathfinder?.setGoal(null);
          return { status: 'SUCCESS' };
        }

        if (options?.isThreat && !options.isThreat(targetId)) {
          logger?.info(`[combat] target ${targetId} is no longer considered a threat`);
          bot.pathfinder?.setGoal(null);
          return { status: 'SUCCESS' };
        }

        const snapshot = ctx.getSnapshot();

        const selfPos = bot.entity?.position ?? snapshot.world.self.position;
        const dx = target.position.x - selfPos.x;
        const dy = target.position.y - selfPos.y;
        const dz = target.position.z - selfPos.z;
        const dist = Math.hypot(dx, dy, dz);

        // Disengage if target out of combatExit range (16 blocks)
        if (dist > THRESHOLDS.combatExit) {
          logger?.info(`[combat] target distance ${dist.toFixed(1)} exceeded combatExit (${THRESHOLDS.combatExit})`);
          bot.pathfinder?.setGoal(null);
          return { status: 'FAILURE', reason: 'Target out of combat range' };
        }

        // Disengage in FOLLOW mode if master distance exceeds limit (24 blocks)
        if (snapshot.intent.mode === 'FOLLOW' && snapshot.world.master.distance > THRESHOLDS.combatMasterLimit) {
          logger?.info(`[combat] master distance ${snapshot.world.master.distance.toFixed(1)} exceeded combatMasterLimit (${THRESHOLDS.combatMasterLimit})`);
          bot.pathfinder?.setGoal(null);
          return { status: 'FAILURE', reason: 'Master distance limit exceeded' };
        }

        // Attack if within reach (<= 3.5 blocks) with 550ms cooldown
        if (dist <= 3.5) {
          const now = Date.now();
          if (now - lastAttackTime >= 550) {
            lastAttackTime = now;
            const targetHeight = target.height ?? 1.8;
            const eyePos = new Vec3(target.position.x, target.position.y + targetHeight * 0.85, target.position.z);
            if (typeof bot.lookAt === 'function') {
              bot.lookAt(eyePos, true).catch(() => {});
            }

            if (typeof bot.attack === 'function' && (bot.entities as any)[targetId]) {
              logger?.info(`[combat] attacking target ${target.name ?? targetId} at dist=${dist.toFixed(1)}`);
              bot.attack(target as any);
              options?.onAttack?.(targetId);
            }
          }
        }
      },

      cancel() {
        logger?.info(`[combat] combat cancelled for target ${targetId}`);
        activeGoal = null;
        bot.pathfinder?.setGoal(null);
      },
    };
  };
}
