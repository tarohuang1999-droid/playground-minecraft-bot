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
          startTime = Date.now();

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
              standX = fcX + Math.cos(angle || 0) * 1.5;
              standZ = fcZ + Math.sin(angle || 0) * 1.5;
              bot.pathfinder?.setGoal(new GoalNear(standX, standY, standZ, 0.3), false);
              return;
            }

            // Check if arrived at safe standing spot in front of farmland
            if (
              (distToStand <= 0.6 || (distToFarmland >= 1.0 && distToFarmland <= 2.2)) &&
              dy <= 1.5
            ) {
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

                  const inv = (bot as any).inventory;
                  const items = typeof inv?.items === 'function' ? inv.items() : [];
                  const seedItems = items.filter((i: any) => i?.name === seedItem);
                  const initialCount = seedItems.reduce(
                    (acc: number, cur: any) => acc + (cur.count ?? 1),
                    0
                  );
                  if (initialCount <= 0) {
                    options.onFarmlandFailed?.(targetPos);
                    finishedResult = {
                      status: 'FAILURE',
                      reason: `Seed ${seedItem} not in inventory`,
                    };
                    return;
                  }
                  const itemToEquip = seedItems[0];

                  // 1. Look directly at farmland center
                  if (typeof (bot as any).lookAt === 'function') {
                    await (bot as any).lookAt(new Vec3(fcX, targetPos.y + 0.5, fcZ));
                  }
                  if (!active || !ctx.isActive()) return;

                  // 2. Equip seed
                  if (typeof (bot as any).equip === 'function') {
                    await (bot as any).equip(itemToEquip, 'hand');
                  }
                  if (!active || !ctx.isActive()) return;

                  // 3. Verify target farmland
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

                  // 4. Plant using activateBlock
                  if (typeof (bot as any).activateBlock === 'function') {
                    await (bot as any).activateBlock(farmlandBlock);
                  } else if (typeof (bot as any).placeBlock === 'function') {
                    await (bot as any).placeBlock(farmlandBlock, new Vec3(0, 1, 0));
                  }

                  if (typeof (bot as any).swingArm === 'function') {
                    (bot as any).swingArm('right');
                  }

                  // 5. Short verification delay
                  await new Promise(r => setTimeout(r, 150));
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

                  const isSuccess = blockChanged || seedDecreased || !aboveBlock;

                  if (isSuccess) {
                    options.onCropPlanted?.(cropType, targetPos);
                    logger?.info(
                      `[farming] Successfully planted ${seedItem} on (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                    );
                    finishedResult = { status: 'SUCCESS' };
                  } else {
                    logger?.warn(
                      `[farming] Planting verification failed on (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`
                    );
                    options.onFarmlandFailed?.(targetPos);
                    finishedResult = { status: 'FAILURE', reason: 'Planting verification failed' };
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
          return !active;
        },
      };
    },
  };
}
