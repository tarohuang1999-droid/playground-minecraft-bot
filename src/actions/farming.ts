import { Vec3 } from 'vec3';
import { goals } from 'mineflayer-pathfinder';
import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
} from '../execution/types.ts';
import { setupMovements, type NavigationBot, type NavigationLogger } from './navigation.ts';

const { GoalNear } = goals;

export interface FarmingOptions {
  logger?: NavigationLogger | undefined;
  onCropPlanted?:
    ((cropType: string, pos?: { x: number; y: number; z: number }) => void) | undefined;
  onFarmlandFailed?: ((pos: { x: number; y: number; z: number }) => void) | undefined;
}

export function createFarming(bot: NavigationBot, options: FarmingOptions = {}) {
  const logger = options.logger;

  return {
    farmPlant(request: ActionRequest): ActionAdapter {
      let active = false;
      let inFlight = false;
      let finishedResult: ActionResult | null = null;
      let startTime = 0;
      const targetPos = {
        x: Number(request.params.x),
        y: Number(request.params.y),
        z: Number(request.params.z),
      };
      const seedItem = String(request.params.seedItem);
      const cropType = String(request.params.cropType ?? 'wheat');

      return {
        start(_ctx: ActionContext): void | ActionResult {
          active = true;
          inFlight = false;
          finishedResult = null;
          startTime = Date.now();

          setupMovements(bot, logger, {
            canDig: false,
            allowBridge: false,
            allowParkour: false,
          });
          bot.setControlState?.('jump', false);

          const goal = new GoalNear(targetPos.x + 0.5, targetPos.y + 1, targetPos.z + 0.5, 2.0);
          bot.pathfinder?.setGoal(goal, false);
          logger?.info(
            `[farming] FarmPlant started towards (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) with ${seedItem}`
          );
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!active || !ctx.isActive()) return;
          if (finishedResult) return finishedResult;

          const now = Date.now();
          if (now - startTime > 15_000) {
            logger?.warn(`[farming] FarmPlant timed out (> 15s)`);
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            options.onFarmlandFailed?.(targetPos);
            return { status: 'FAILURE', reason: 'Plant approach timed out' };
          }

          if (inFlight) return;

          const selfPos = bot.entity?.position;
          if (!selfPos) return { status: 'FAILURE', reason: 'Bot position missing' };

          const dist = Math.hypot(selfPos.x - (targetPos.x + 0.5), selfPos.z - (targetPos.z + 0.5));
          const dy = Math.abs(selfPos.y - targetPos.y);

          // Check if bot is colliding with crop volume [targetPos.x .. +1, targetPos.y + 1 .. +2, targetPos.z .. +1]
          const isColliding =
            selfPos.y < targetPos.y + 2.0 &&
            selfPos.y + 1.8 > targetPos.y + 1.0 &&
            selfPos.x + 0.35 > targetPos.x &&
            selfPos.x - 0.35 < targetPos.x + 1.0 &&
            selfPos.z + 0.35 > targetPos.z &&
            selfPos.z - 0.35 < targetPos.z + 1.0;

          if (isColliding) {
            // Bot is standing inside the crop volume, back up slightly to safe distance
            const angle = Math.atan2(
              selfPos.z - (targetPos.z + 0.5),
              selfPos.x - (targetPos.x + 0.5)
            );
            const backX = targetPos.x + 0.5 + Math.cos(angle || 0) * 1.6;
            const backZ = targetPos.z + 0.5 + Math.sin(angle || 0) * 1.6;
            bot.pathfinder?.setGoal(new GoalNear(backX, targetPos.y + 1, backZ, 0.4), false);
            return;
          }

          if (dist <= 3.2 && dy <= 2.0) {
            inFlight = true;
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);

            (async () => {
              try {
                if (!active || !ctx.isActive()) return;

                const inv = (bot as any).inventory;
                const items = typeof inv?.items === 'function' ? inv.items() : [];
                const item = items.find((i: any) => i?.name === seedItem);
                if (!item) {
                  options.onFarmlandFailed?.(targetPos);
                  finishedResult = {
                    status: 'FAILURE',
                    reason: `Seed ${seedItem} not in inventory`,
                  };
                  return;
                }

                if (typeof (bot as any).equip === 'function') {
                  await (bot as any).equip(item, 'hand');
                }

                if (!active || !ctx.isActive()) return;

                if (typeof (bot as any).lookAt === 'function') {
                  await (bot as any).lookAt(
                    new Vec3(targetPos.x + 0.5, targetPos.y + 0.5, targetPos.z + 0.5)
                  );
                }

                if (!active || !ctx.isActive()) return;

                const farmlandBlock =
                  typeof (bot as any).blockAt === 'function'
                    ? (bot as any).blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z))
                    : {
                        position: new Vec3(targetPos.x, targetPos.y, targetPos.z),
                        name: 'farmland',
                      };

                if (!farmlandBlock || farmlandBlock.name !== 'farmland') {
                  options.onFarmlandFailed?.(targetPos);
                  finishedResult = { status: 'FAILURE', reason: 'Target is not farmland' };
                  return;
                }

                if (typeof (bot as any).activateBlock === 'function') {
                  await (bot as any).activateBlock(farmlandBlock);
                } else if (typeof (bot as any).placeBlock === 'function') {
                  await (bot as any).placeBlock(farmlandBlock, new Vec3(0, 1, 0));
                }

                if (typeof (bot as any).swingArm === 'function') {
                  (bot as any).swingArm('right');
                }

                if (!active || !ctx.isActive()) return;

                options.onCropPlanted?.(cropType, targetPos);
                logger?.info(
                  `[farming] Successfully planted ${seedItem} on (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                );
                finishedResult = { status: 'SUCCESS' };
              } catch (err) {
                if (!active || !ctx.isActive()) return;
                logger?.warn(`[farming] planting error: ${err}`);
                options.onFarmlandFailed?.(targetPos);
                finishedResult = { status: 'FAILURE', reason: String(err) };
              } finally {
                inFlight = false;
              }
            })();
          }
        },

        cancel(): void {
          active = false;
          bot.pathfinder?.setGoal(null);
          bot.setControlState?.('jump', false);
          logger?.info('[farming] FarmPlant cancelled');
        },

        isStopped(): boolean {
          return !active;
        },
      };
    },

    returnToRally(request: ActionRequest): ActionAdapter {
      let active = false;
      const targetPos = {
        x: Number(request.params.x),
        y: Number(request.params.y),
        z: Number(request.params.z),
      };

      return {
        start(_ctx: ActionContext): void | ActionResult {
          active = true;
          setupMovements(bot, logger, {
            canDig: false,
            allowBridge: false,
            allowParkour: false,
          });
          bot.setControlState?.('jump', false);

          const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.5);
          bot.pathfinder?.setGoal(goal, false);
          logger?.info(
            `[farming] ReturnToRally started towards (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
          );
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!active || !ctx.isActive()) return;

          const selfPos = bot.entity?.position;
          if (!selfPos) return { status: 'FAILURE', reason: 'Bot position missing' };

          const dist = Math.hypot(selfPos.x - targetPos.x, selfPos.z - targetPos.z);
          if (dist <= 1.5) {
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            logger?.info(`[farming] Arrived at rally point`);
            return { status: 'SUCCESS' };
          }
        },

        cancel(): void {
          active = false;
          bot.pathfinder?.setGoal(null);
          bot.setControlState?.('jump', false);
          logger?.info('[farming] ReturnToRally cancelled');
        },

        isStopped(): boolean {
          return !active;
        },
      };
    },
  };
}
