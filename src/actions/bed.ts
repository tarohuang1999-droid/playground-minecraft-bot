import goals from 'mineflayer-pathfinder';
import type { Position } from '../blackboard.ts';
import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
} from '../execution/types.ts';
import type { Logger } from '../logger.ts';
import { findNearbyBed } from '../perception.ts';
import { safeBlockAt, setupMovements } from './navigation.ts';

const { GoalNear } = goals.goals;

export interface SetBedBot {
  entity?: { position: Position; [key: string]: unknown };
  pathfinder?: {
    setGoal(goal: unknown, dynamic?: boolean): void;
    isMoving?(): boolean;
  };
  findBlock?(options: unknown): unknown;
  activateBlock?(block: unknown): Promise<void>;
  blockAt?(pos: unknown): unknown;
  blocks?: Record<string, unknown>;
  setControlState?(control: string, state: boolean): void;
}

export interface SetBedOptions {
  onSpawnSet?: (pos: Position) => void;
  onNoBedFound?: () => void;
}

export function createSetBedAdapter(
  bot: SetBedBot,
  logger?: Logger,
  options: SetBedOptions = {}
): (request: ActionRequest) => ActionAdapter {
  return (_request: ActionRequest): ActionAdapter => {
    let active = true;
    let targetPos: Position | null = null;
    let startTime = 0;

    return {
      start(ctx: ActionContext): void | ActionResult {
        if (!ctx.isActive()) return;
        const center = bot.entity?.position ?? ctx.getSnapshot().world.self.position;
        const bed = findNearbyBed(bot, 10, center);
        if (!bed || !bed.position) {
          logger?.info('[bed] SetBed: no bed found within 10 blocks');
          options.onNoBedFound?.();
          return { status: 'FAILURE', reason: 'No bed found within 10 blocks' };
        }

        targetPos = {
          x: Math.round(bed.position.x * 10) / 10,
          y: Math.round(bed.position.y * 10) / 10,
          z: Math.round(bed.position.z * 10) / 10,
        };
        startTime = Date.now();

        const dist = Math.hypot(
          targetPos.x - center.x,
          targetPos.y - center.y,
          targetPos.z - center.z
        );

        if (dist <= 2.5) {
          const bedBlock = safeBlockAt(bot as any, targetPos) ?? bed;
          if (bedBlock && typeof bot.activateBlock === 'function') {
            bot.activateBlock(bedBlock).catch(err => {
              logger?.warn('[bed] activateBlock error: ' + err);
            });
          }
          logger?.info(
            `[bed] SetBed reached bed immediately at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`
          );
          options.onSpawnSet?.(targetPos);
          return { status: 'SUCCESS' };
        }

        if (bot.pathfinder) {
          setupMovements(bot as any, logger, { canDig: false, allowBridge: false });
          bot.pathfinder.setGoal(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0), false);
        }
      },

      update(ctx: ActionContext): void | ActionResult {
        if (!active || !ctx.isActive() || !targetPos) return;

        const now = Date.now();
        if (now - startTime > 30000) {
          logger?.warn('[bed] SetBed timed out after 30s');
          bot.pathfinder?.setGoal(null);
          bot.setControlState?.('jump', false);
          return { status: 'FAILURE', reason: 'SetBed timed out after 30000ms' };
        }

        const currentPos = bot.entity?.position ?? ctx.getSnapshot().world.self.position;
        const dist = Math.hypot(
          targetPos.x - currentPos.x,
          targetPos.y - currentPos.y,
          targetPos.z - currentPos.z
        );

        if (dist <= 2.5) {
          bot.pathfinder?.setGoal(null);
          bot.setControlState?.('jump', false);
          const bedBlock = safeBlockAt(bot as any, targetPos);
          if (bedBlock && typeof bot.activateBlock === 'function') {
            bot.activateBlock(bedBlock).catch(err => {
              logger?.warn('[bed] activateBlock error: ' + err);
            });
          }
          logger?.info(
            `[bed] SetBed successfully arrived at bed (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`
          );
          options.onSpawnSet?.(targetPos);
          return { status: 'SUCCESS' };
        }
      },

      cancel() {
        active = false;
        bot.pathfinder?.setGoal(null);
        bot.setControlState?.('jump', false);
      },

      isStopped() {
        return !active;
      },
    };
  };
}
