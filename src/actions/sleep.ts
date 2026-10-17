import goals from 'mineflayer-pathfinder';
import type { Position } from '../blackboard.ts';
import { survivalConfig } from '../config/index.ts';
import type {
  ActionAdapter,
  ActionContext,
  ActionRequest,
  ActionResult,
} from '../execution/types.ts';
import type { Logger } from '../logger.ts';
import { safeBlockAt, setupMovements } from './navigation.ts';

const { GoalNear } = goals.goals;

export interface SleepBot {
  entity?: { position: Position; [key: string]: unknown };
  pathfinder?: {
    setGoal(goal: unknown, dynamic?: boolean): void;
    isMoving?(): boolean;
  };
  blockAt?(pos: unknown): unknown;
  sleep?(bedBlock: unknown): Promise<void>;
  wake?(): Promise<void>;
  isSleeping?: boolean;
  time?: { timeOfDay?: number };
  isRaining?: boolean;
  setControlState?(control: string, state: boolean): void;
}

export interface SleepOptions {
  chat?: { enqueue(message: string): void };
  onWake?: () => void;
  onGoodMorning?: () => void;
}

export function createSleepAdapter(
  bot: SleepBot,
  logger?: Logger,
  options: SleepOptions = {}
): (request: ActionRequest) => ActionAdapter {
  return (request: ActionRequest): ActionAdapter => {
    let active = true;
    let inFlight = false;
    let targetPos: Position | null = null;
    let morningGreeted = false;
    let currentCtx: ActionContext | null = null;

    return {
      start(ctx: ActionContext): void | ActionResult {
        if (!ctx.isActive()) return;
        currentCtx = ctx;
        const snapshot = ctx.getSnapshot();

        const target =
          typeof request.params.x === 'number' &&
          typeof request.params.y === 'number' &&
          typeof request.params.z === 'number'
            ? { x: request.params.x, y: request.params.y, z: request.params.z }
            : snapshot.world.spawnPoint;

        if (!target) {
          logger?.warn('[sleep] SleepAtBed rejected: no spawn point set');
          return { status: 'FAILURE', reason: 'No spawn point set' };
        }

        targetPos = { x: target.x, y: target.y, z: target.z };
        active = true;
        inFlight = false;
        morningGreeted = false;

        if (bot.isSleeping) {
          return;
        }

        const currentPos = bot.entity?.position ?? snapshot.world.self.position;
        const dist = Math.hypot(
          targetPos.x - currentPos.x,
          targetPos.y - currentPos.y,
          targetPos.z - currentPos.z
        );

        if (dist <= survivalConfig.bed.sleepReachDistance) {
          bot.pathfinder?.setGoal(null);
          const bedBlock = safeBlockAt(bot as any, targetPos);
          if (bedBlock && typeof bot.sleep === 'function' && !bot.isSleeping && !inFlight) {
            inFlight = true;
            logger?.info(
              `[sleep] calling bot.sleep at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`
            );
            bot
              .sleep(bedBlock)
              .then(() => {
                inFlight = false;
              })
              .catch(err => {
                inFlight = false;
                if (!active || !ctx.isActive()) return;
                logger?.warn('[sleep] bot.sleep error: ' + err);
              });
          }
          return;
        }

        if (bot.pathfinder) {
          setupMovements(bot as any, logger, { canDig: false, allowBridge: false });
          logger?.info(
            `[sleep] heading to bed at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`
          );
          bot.pathfinder.setGoal(
            new GoalNear(
              targetPos.x,
              targetPos.y,
              targetPos.z,
              survivalConfig.bed.sleepApproachGoal
            ),
            false
          );
        }
      },

      update(ctx: ActionContext): void | ActionResult {
        if (!active || !ctx.isActive() || !targetPos) return;
        currentCtx = ctx;

        const snapshot = ctx.getSnapshot();

        // 1. Under attack or threatened: wake up and fail immediately to yield to combat / retreat
        if (snapshot.world.self.tookDamageRecently || snapshot.world.threats.length > 0) {
          logger?.warn('[sleep] Under attack or threats detected while sleeping/approaching bed!');
          if (bot.isSleeping && typeof bot.wake === 'function') {
            bot.wake().catch(err => {
              logger?.warn('[sleep] wake on attack error: ' + err);
            });
          }
          bot.pathfinder?.setGoal(null);
          return { status: 'FAILURE', reason: 'Under attack' };
        }

        // 2. Check if morning has arrived
        const isNight =
          snapshot.world.timeOfDay >= survivalConfig.sleepMinTime &&
          snapshot.world.timeOfDay <= survivalConfig.sleepMaxTime;
        const isRaining = snapshot.world.isRaining;

        if (!isNight && !isRaining) {
          logger?.info('[sleep] Morning arrived or rain stopped, waking up');
          if (bot.isSleeping && typeof bot.wake === 'function') {
            bot.wake().catch(err => {
              logger?.warn('[sleep] wake error: ' + err);
            });
          }
          bot.pathfinder?.setGoal(null);
          if (!morningGreeted) {
            morningGreeted = true;
            options.chat?.enqueue('Good morning!');
            options.onGoodMorning?.();
          }
          return { status: 'SUCCESS' };
        }

        // 3. If already sleeping, stay asleep
        if (bot.isSleeping) {
          return;
        }

        // 4. If approaching, check distance to bed
        const currentPos = bot.entity?.position ?? snapshot.world.self.position;
        const dist = Math.hypot(
          targetPos.x - currentPos.x,
          targetPos.y - currentPos.y,
          targetPos.z - currentPos.z
        );

        if (dist <= survivalConfig.bed.sleepReachDistance) {
          bot.pathfinder?.setGoal(null);
          if (!inFlight && !bot.isSleeping && typeof bot.sleep === 'function') {
            const bedBlock = safeBlockAt(bot as any, targetPos);
            if (bedBlock) {
              inFlight = true;
              logger?.info(
                `[sleep] reached bed, calling bot.sleep at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`
              );
              bot
                .sleep(bedBlock)
                .then(() => {
                  inFlight = false;
                })
                .catch(err => {
                  inFlight = false;
                  if (!active || !ctx.isActive()) return;
                  logger?.warn('[sleep] bot.sleep error: ' + err);
                });
            }
          }
        }
      },

      cancel() {
        active = false;
        const wasSleeping = Boolean(bot.isSleeping);
        if (wasSleeping && typeof bot.wake === 'function') {
          bot.wake().catch(err => {
            logger?.warn('[sleep] wake on cancel error: ' + err);
          });
        }
        if (currentCtx) {
          const snapshot = currentCtx.getSnapshot();
          const isNight =
            snapshot.world.timeOfDay >= survivalConfig.sleepMinTime &&
            snapshot.world.timeOfDay <= survivalConfig.sleepMaxTime;
          const isRaining = snapshot.world.isRaining;
          if (wasSleeping && !isNight && !isRaining && !morningGreeted) {
            morningGreeted = true;
            options.chat?.enqueue('Good morning!');
            options.onGoodMorning?.();
          }
        }
        bot.pathfinder?.setGoal(null);
        bot.setControlState?.('jump', false);
      },

      isStopped() {
        return !active;
      },
    };
  };
}
