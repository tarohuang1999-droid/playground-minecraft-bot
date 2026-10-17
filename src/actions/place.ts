import { Vec3 } from 'vec3';
import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
} from '../execution/types.ts';
import type { Logger } from '../logger.ts';

export interface PlaceBlockBot {
  entity?: {
    position?: { x: number; y: number; z: number };
    yaw?: number;
    pitch?: number;
  };
  heldItem?: { name?: string } | null;
  quickBarSlot?: number;
  inventory?: {
    items?(): Array<{ name?: string; type?: number; id?: number; slot?: number }>;
  };
  blockAt?(pos: unknown): unknown;
  equip?(item: unknown, destination: string): Promise<void>;
  lookAt?(point: unknown, force?: boolean): Promise<void>;
  placeBlock?(referenceBlock: unknown, faceVector: unknown): Promise<void>;
}

export interface PlaceBlockOptions {
  onPlaceFinished?: (success: boolean, msg: string) => void;
  chat?: { enqueue(msg: string): void };
}

export function createPlaceBlock(
  bot: PlaceBlockBot,
  logger?: Logger,
  options: PlaceBlockOptions = {}
): (request: ActionRequest) => ActionAdapter {
  return (_request: ActionRequest): ActionAdapter => {
    let active = true;

    return {
      start(ctx: ActionContext): void | ActionResult | Promise<ActionResult | void> {
        if (!ctx.isActive()) return;

        const targetQuery = String(_request.params?.item ?? 'dirt').toLowerCase();
        const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
        const targetItem = items.find(i => {
          if (!i?.name) return false;
          const n = i.name.toLowerCase();
          return (
            n === targetQuery ||
            (targetQuery === 'dirt' && (n.includes('dirt') || n.includes('grass_block')))
          );
        });

        if (!targetItem) {
          const errMsg = `No ${targetQuery} in inventory!`;
          logger?.warn(`[place] ${errMsg}`);
          options.chat?.enqueue(errMsg);
          options.onPlaceFinished?.(false, errMsg);
          return { status: 'FAILURE', reason: errMsg };
        }

        const pos = bot.entity?.position;
        const yaw = bot.entity?.yaw;
        if (!pos || yaw === undefined) {
          const errMsg = 'Bot position or yaw unknown';
          logger?.warn(`[place] ${errMsg}`);
          options.chat?.enqueue('Position unknown!');
          options.onPlaceFinished?.(false, errMsg);
          return { status: 'FAILURE', reason: errMsg };
        }

        const blockAt =
          typeof bot.blockAt === 'function'
            ? (p: Vec3) => (bot.blockAt as (p: Vec3) => any)(p)
            : null;
        if (!blockAt) {
          const errMsg = 'bot.blockAt unavailable';
          logger?.warn(`[place] ${errMsg}`);
          options.chat?.enqueue(errMsg);
          options.onPlaceFinished?.(false, errMsg);
          return { status: 'FAILURE', reason: errMsg };
        }

        // 1. Identify ground block under bot feet
        const footPos = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
        let underFeet = blockAt(new Vec3(pos.x, pos.y - 0.5, pos.z));
        if (!underFeet || underFeet.name === 'air') {
          underFeet = blockAt(footPos.offset(0, -1, 0));
        }

        const basePos =
          underFeet?.name !== 'air' && underFeet?.position
            ? underFeet.position
            : footPos.offset(0, -1, 0);

        logger?.info(
          `[place] bot position=(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) yaw=${yaw.toFixed(2)}`
        );
        logger?.info(
          `[place] block under feet: ${underFeet?.name ?? 'unknown'} at (${basePos.x}, ${basePos.y}, ${basePos.z})`
        );

        // 2. Compute 1-block step in front based on yaw
        const dx = -Math.sin(yaw);
        const dz = -Math.cos(yaw);
        const stepX = Math.abs(dx) > 0.38 ? Math.sign(dx) : 0;
        const stepZ = Math.abs(dz) > 0.38 ? Math.sign(dz) : 0;
        const finalStepX =
          stepX === 0 && stepZ === 0
            ? Math.abs(dx) >= Math.abs(dz)
              ? Math.sign(dx) || 1
              : 0
            : stepX;
        const finalStepZ =
          stepX === 0 && stepZ === 0
            ? Math.abs(dz) > Math.abs(dx)
              ? Math.sign(dz) || 1
              : 0
            : stepZ;

        const frontGroundPos = basePos.offset(finalStepX, 0, finalStepZ);

        // 3. Search for solid reference block with air above it
        let refBlock: any = null;
        const candidates = [
          frontGroundPos,
          frontGroundPos.offset(0, -1, 0),
          frontGroundPos.offset(0, 1, 0),
        ];

        for (const candPos of candidates) {
          const cand = blockAt(candPos);
          const above = blockAt(candPos.offset(0, 1, 0));
          if (
            cand &&
            cand.name !== 'air' &&
            cand.type !== 0 &&
            (!above || above.name === 'air' || above.type === 0)
          ) {
            refBlock = cand;
            break;
          }
        }

        if (!refBlock || refBlock.name === 'air' || refBlock.type === 0) {
          const errMsg = `Cannot place: no solid block in front!`;
          logger?.warn(
            `[place] ${errMsg} (tested frontGroundPos=${frontGroundPos.x},${frontGroundPos.y},${frontGroundPos.z})`
          );
          options.chat?.enqueue(errMsg);
          options.onPlaceFinished?.(false, errMsg);
          return { status: 'FAILURE', reason: errMsg };
        }

        logger?.info(
          `[place] target reference block in front: ${refBlock.name} at (${refBlock.position.x}, ${refBlock.position.y}, ${refBlock.position.z})`
        );

        return (async (): Promise<ActionResult> => {
          try {
            // Equip target item to hand
            if (typeof bot.equip === 'function') {
              const heldBefore = bot.heldItem?.name ?? 'empty';
              logger?.info(
                `[place] item switch START: target=${targetItem.name} (type=${targetItem.type}) | held before switch=${heldBefore}`
              );
              await bot.equip(targetItem, 'hand');
              await new Promise(resolve => setTimeout(resolve, 200));
              const heldAfter = bot.heldItem?.name ?? 'empty';
              logger?.info(`[place] item switch END: held after switch=${heldAfter}`);

              if (heldAfter !== targetItem.name) {
                const errMsg = `Equip failed: holding ${heldAfter} instead of ${targetItem.name}!`;
                logger?.error(`[place] ${errMsg}`);
                options.chat?.enqueue(errMsg);
                options.onPlaceFinished?.(false, errMsg);
                return { status: 'FAILURE', reason: errMsg };
              }
            }

            if (!active || !ctx.isActive())
              return { status: 'FAILURE', reason: 'Action cancelled or inactive' };

            options.chat?.enqueue(
              `Holding ${bot.heldItem?.name ?? targetItem.name}, placing on ${refBlock.name}...`
            );

            // Look at target surface
            const targetLook = refBlock.position.offset(0.5, 1.0, 0.5);
            if (typeof bot.lookAt === 'function') {
              logger?.info(
                `[place] looking at target: (${targetLook.x.toFixed(2)}, ${targetLook.y.toFixed(2)}, ${targetLook.z.toFixed(2)})`
              );
              await bot.lookAt(targetLook, true);
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (!active || !ctx.isActive())
              return { status: 'FAILURE', reason: 'Action cancelled or inactive' };

            // Place block
            if (typeof bot.placeBlock === 'function') {
              logger?.info(
                `[place] executing bot.placeBlock(refBlock=${refBlock.name} at (${refBlock.position.x}, ${refBlock.position.y}, ${refBlock.position.z}), face=(0, 1, 0))`
              );
              await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
              const msg = `Placed ${targetItem.name} on ${refBlock.name} at (${refBlock.position.x}, ${refBlock.position.y + 1}, ${refBlock.position.z})`;
              logger?.info(`[place] ${msg}`);
              options.chat?.enqueue(msg);
              options.onPlaceFinished?.(true, msg);
              return { status: 'SUCCESS' };
            } else {
              const errMsg = 'bot.placeBlock is not a function';
              logger?.warn(`[place] ${errMsg}`);
              options.chat?.enqueue(errMsg);
              options.onPlaceFinished?.(false, errMsg);
              return { status: 'FAILURE', reason: errMsg };
            }
          } catch (err: unknown) {
            const errMsg = (err as Error)?.message ?? String(err);
            logger?.error(`[place] placeBlock failed: ${errMsg}`);
            options.chat?.enqueue(`placeBlock failed: ${errMsg}`);
            options.onPlaceFinished?.(false, errMsg);
            return { status: 'FAILURE', reason: errMsg };
          }
        })();
      },

      cancel() {
        active = false;
        logger?.info('[place] PlaceBlock cancelled');
      },
    };
  };
}
