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
  now?: (() => number) | undefined;
  onCropPlanted?:
    ((cropType: string, pos?: { x: number; y: number; z: number }) => void) | undefined;
  onFarmlandFailed?: ((pos: { x: number; y: number; z: number }) => void) | undefined;
}

export function createFarming(bot: NavigationBot, options: FarmingOptions = {}) {
  const logger = options.logger;
  const getNow = () => (options.now ? options.now() : Date.now());

  return {
    farmPlant(request: ActionRequest): ActionAdapter {
      let active = false;
      let inFlight = false;
      let phase: 'APPROACH' | 'PLANTING' = 'APPROACH';
      let finishedResult: ActionResult | null = null;
      let startTime = 0;
      const targetPos = {
        x: Number(request.params.x),
        y: Number(request.params.y),
        z: Number(request.params.z),
      };
      const seedItem = String(request.params.seedItem);
      const cropType = String(request.params.cropType ?? 'wheat');

      const fcX = targetPos.x + 0.5;
      const fcZ = targetPos.z + 0.5;
      let standX = fcX + 1.5;
      let standZ = fcZ;
      const standY = targetPos.y + 1;

      return {
        start(_ctx: ActionContext): void | ActionResult {
          active = true;
          inFlight = false;
          phase = 'APPROACH';
          finishedResult = null;
          startTime = getNow();

          setupMovements(bot, logger, {
            canDig: false,
            allowBridge: false,
            allowParkour: false,
          });
          bot.setControlState?.('jump', false);

          const selfPos = bot.entity?.position ?? { x: fcX + 1.5, y: standY, z: fcZ };
          const angle = Math.atan2(selfPos.z - fcZ, selfPos.x - fcX);
          standX = fcX + Math.cos(angle || 0) * 1.5;
          standZ = fcZ + Math.sin(angle || 0) * 1.5;

          const goal = new GoalNear(standX, standY, standZ, 0.4);
          bot.pathfinder?.setGoal(goal, false);
          logger?.info(
            `[farming] FarmPlant approaching stand position (${standX.toFixed(1)}, ${standY}, ${standZ.toFixed(1)}) for farmland (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) with ${seedItem}`
          );
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!active || !ctx.isActive()) return;
          if (finishedResult) return finishedResult;

          const now = getNow();
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

          if (phase === 'APPROACH') {
            const distToStand = Math.hypot(selfPos.x - standX, selfPos.z - standZ);
            const distToFarmland = Math.hypot(selfPos.x - fcX, selfPos.z - fcZ);
            const dy = Math.abs(selfPos.y - targetPos.y);

            const isColliding =
              selfPos.y < targetPos.y + 2.0 &&
              selfPos.y + 1.8 > targetPos.y + 1.0 &&
              selfPos.x + 0.35 > targetPos.x &&
              selfPos.x - 0.35 < targetPos.x + 1.0 &&
              selfPos.z + 0.35 > targetPos.z &&
              selfPos.z - 0.35 < targetPos.z + 1.0;

            if (isColliding) {
              const angle = Math.atan2(selfPos.z - fcZ, selfPos.x - fcX);
              standX = fcX + Math.cos(angle || 0) * 1.6;
              standZ = fcZ + Math.sin(angle || 0) * 1.6;
              bot.pathfinder?.setGoal(new GoalNear(standX, standY, standZ, 0.3), false);
              return;
            }

            // Check if arrived at safe standing spot in front of farmland
            const isAtStand = distToStand <= 0.5 && dy <= 1.2;
            const isAtSafeDistance = distToFarmland >= 1.2 && distToFarmland <= 2.2 && dy <= 1.2;

            if ((isAtStand || isAtSafeDistance) && !isColliding) {
              phase = 'PLANTING';
              // Completely stop all movement before planting
              bot.pathfinder?.setGoal(null);
              bot.setControlState?.('forward', false);
              bot.setControlState?.('back', false);
              bot.setControlState?.('left', false);
              bot.setControlState?.('right', false);
              bot.setControlState?.('jump', false);
              bot.setControlState?.('sprint', false);

              inFlight = true;
              (async () => {
                try {
                  if (!active || !ctx.isActive()) return;

                  // 0. Motion settling delay to eliminate momentum/sliding
                  await new Promise(r => setTimeout(r, 50));
                  if (!active || !ctx.isActive()) return;

                  const curPos = bot.entity?.position ?? selfPos;
                  logger?.info(
                    `[farming] Planting initiated at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): botPos=(${curPos.x.toFixed(2)}, ${curPos.y.toFixed(2)}, ${curPos.z.toFixed(2)}), distToFarmland=${Math.hypot(curPos.x - fcX, curPos.z - fcZ).toFixed(2)}`
                  );

                  const inv = (bot as any).inventory;
                  const items = typeof inv?.items === 'function' ? inv.items() : [];
                  const seedItems = items.filter((i: any) => i?.name === seedItem);
                  const initialCount = seedItems.reduce(
                    (acc: number, cur: any) => acc + (cur.count ?? 1),
                    0
                  );
                  if (initialCount <= 0) {
                    logger?.warn(`[farming] Seed ${seedItem} not found in inventory`);
                    options.onFarmlandFailed?.(targetPos);
                    finishedResult = {
                      status: 'FAILURE',
                      reason: `Seed ${seedItem} not in inventory`,
                    };
                    return;
                  }
                  const itemToEquip = seedItems[0];

                  // 1. Look directly at top face of farmland
                  const topCenter = new Vec3(fcX, targetPos.y + 1.0, fcZ);
                  if (typeof (bot as any).lookAt === 'function') {
                    await (bot as any).lookAt(topCenter, true);
                  }
                  if (!active || !ctx.isActive()) return;

                  // 2. Equip seed
                  if (typeof (bot as any).equip === 'function') {
                    await (bot as any).equip(itemToEquip, 'hand');
                  }
                  if (!active || !ctx.isActive()) return;

                  const held = (bot as any).heldItem;
                  logger?.info(
                    `[farming] Held item confirmed: ${held?.name ?? 'empty'} (count=${held?.count ?? 0})`
                  );

                  // 3. Verify target farmland
                  const farmlandBlock =
                    typeof (bot as any).blockAt === 'function'
                      ? (bot as any).blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z))
                      : {
                          position: new Vec3(targetPos.x, targetPos.y, targetPos.z),
                          name: 'farmland',
                        };

                  if (!farmlandBlock || farmlandBlock.name !== 'farmland') {
                    logger?.warn(
                      `[farming] Target block at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${farmlandBlock?.name ?? 'null'}, expected farmland`
                    );
                    options.onFarmlandFailed?.(targetPos);
                    finishedResult = { status: 'FAILURE', reason: 'Target is not farmland' };
                    return;
                  }

                  // 4. Plant: Prefer placeBlock (official Mineflayer method for placing blocks/seeds)
                  // Fallback to activateBlock if placeBlock throws or is unavailable
                  let placeError: any = null;
                  let methodUsed = 'none';

                  if (typeof (bot as any).placeBlock === 'function') {
                    try {
                      methodUsed = 'placeBlock';
                      logger?.info(
                        `[farming] Executing placeBlock on farmland (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) with face (0, 1, 0)`
                      );
                      await (bot as any).placeBlock(farmlandBlock, new Vec3(0, 1, 0));
                      logger?.info(
                        `[farming] placeBlock completed successfully on (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                      );
                    } catch (err: any) {
                      placeError = err;
                      logger?.warn(
                        `[farming] placeBlock error on (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): ${err?.message ?? err}`
                      );
                    }
                  }

                  if (!active || !ctx.isActive()) return;

                  if (
                    (!placeError && methodUsed === 'none') ||
                    (placeError && typeof (bot as any).activateBlock === 'function')
                  ) {
                    if (typeof (bot as any).activateBlock === 'function') {
                      try {
                        methodUsed = placeError ? 'activateBlock (fallback)' : 'activateBlock';
                        logger?.info(
                          `[farming] Executing ${methodUsed} on farmland (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                        );
                        await (bot as any).activateBlock(farmlandBlock, new Vec3(0, 1, 0));
                        if (!active || !ctx.isActive()) return;
                        if (typeof (bot as any).swingArm === 'function') {
                          (bot as any).swingArm('right');
                        }
                      } catch (actErr: any) {
                        if (!active || !ctx.isActive()) return;
                        logger?.warn(
                          `[farming] activateBlock error on (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): ${actErr?.message ?? actErr}`
                        );
                      }
                    }
                  }

                  if (!active || !ctx.isActive()) return;

                  // 5. Verification delay to allow server block update to propagate
                  await new Promise(r => setTimeout(r, 100));
                  if (!active || !ctx.isActive()) return;

                  // 6. Verify success: check block above or seed count
                  const abovePos = new Vec3(targetPos.x, targetPos.y + 1, targetPos.z);
                  const aboveBlock =
                    typeof (bot as any).blockAt === 'function'
                      ? (bot as any).blockAt(abovePos)
                      : null;
                  const newItems = typeof inv?.items === 'function' ? inv.items() : [];
                  const newCount = newItems
                    .filter((i: any) => i?.name === seedItem)
                    .reduce((acc: number, cur: any) => acc + (cur.count ?? 1), 0);

                  const blockChanged =
                    aboveBlock && aboveBlock.name !== 'air' && aboveBlock.name !== 'cave_air';
                  const seedDecreased = newCount < initialCount;

                  logger?.info(
                    `[farming] Verification on (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): method=${methodUsed}, aboveBlock=${aboveBlock?.name ?? 'null'}, seeds: ${initialCount} -> ${newCount}`
                  );

                  const isSuccess = blockChanged || seedDecreased || !aboveBlock;

                  if (isSuccess) {
                    options.onCropPlanted?.(cropType, targetPos);
                    logger?.info(
                      `[farming] Successfully planted ${seedItem} on (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                    );
                    finishedResult = { status: 'SUCCESS' };
                  } else {
                    logger?.warn(
                      `[farming] Planting verification failed on (${targetPos.x}, ${targetPos.y}, ${targetPos.z}): aboveBlock is still ${aboveBlock?.name ?? 'air'}, seeds unchanged (${newCount}/${initialCount}), error=${placeError?.message ?? 'none'}`
                    );
                    options.onFarmlandFailed?.(targetPos);
                    finishedResult = {
                      status: 'FAILURE',
                      reason: `Planting verification failed: aboveBlock=${aboveBlock?.name ?? 'air'}, error=${placeError?.message ?? 'none'}`,
                    };
                  }
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
          }
        },

        cancel(): void {
          active = false;
          bot.pathfinder?.setGoal(null);
          bot.setControlState?.('forward', false);
          bot.setControlState?.('jump', false);
          logger?.info('[farming] FarmPlant cancelled');
        },

        isStopped(): boolean {
          return !active && !inFlight;
        },
      };
    },
  };
}
