import { safeBlockAt, isDoorBlock, type NavigationBot, type NavigationLogger } from './navigation.ts';
import type { NavigationTaskState } from './navigation-guard.ts';

export function isSafeSupportBlock(block: any): boolean {
  if (!block || !block.name) return false;
  const name = block.name.toLowerCase();
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return false;
  if (name === 'lava' || name === 'water' || name.includes('fire')) return false;
  if (block.boundingBox === 'empty') return false;
  return true;
}

export function isPassableBlock(block: any): boolean {
  if (!block || !block.name) return false;
  const name = block.name.toLowerCase();
  if (name === 'lava' || name.includes('fire')) return false;
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return true;
  if (block.boundingBox === 'empty') return true;
  if (isDoorBlock(block)) return true;
  if (name.includes('carpet') || name.includes('vine') || name.includes('ladder') || name.includes('grass')) return true;
  return false;
}

export function checkLateralSafety(
  bot: NavigationBot,
  side: 'left' | 'right'
): { safe: boolean; lateralVec: { dx: number; dz: number } | null } {
  if (!bot.entity?.onGround || !bot.entity.position) {
    return { safe: false, lateralVec: null };
  }

  const yaw = bot.entity.yaw ?? 0;
  // Perpendicular angle: left is +PI/2, right is -PI/2
  const angle = side === 'left' ? yaw + Math.PI / 2 : yaw - Math.PI / 2;
  const stepDistance = 0.5; // Short segment (max 0.5 blocks) per spec
  const dx = -Math.sin(angle) * stepDistance;
  const dz = Math.cos(angle) * stepDistance;

  const curPos = bot.entity.position;
  const targetX = curPos.x + dx;
  const targetY = curPos.y;
  const targetZ = curPos.z + dz;

  // 1. Must have solid ground / foot support at y - 1 (not a cliff/void)
  const support = safeBlockAt(bot, { x: targetX, y: targetY - 0.5, z: targetZ });
  if (!support || !isSafeSupportBlock(support)) {
    return { safe: false, lateralVec: null };
  }

  // 2. Foot block at y must be passable
  const foot = safeBlockAt(bot, { x: targetX, y: targetY + 0.1, z: targetZ });
  if (!foot || !isPassableBlock(foot)) {
    return { safe: false, lateralVec: null };
  }

  // 3. Head space at y + 1 must be passable
  const head = safeBlockAt(bot, { x: targetX, y: targetY + 1.1, z: targetZ });
  if (!head || !isPassableBlock(head)) {
    return { safe: false, lateralVec: null };
  }

  return { safe: true, lateralVec: { dx, dz } };
}

export function isSafeBackward(bot: NavigationBot): boolean {
  if (!bot.entity?.onGround || !bot.entity.position) return false;
  const yaw = bot.entity.yaw ?? 0;
  // Minecraft back vector: yaw 0 faces -z, so back is +z
  const bx = Math.sin(yaw) * 0.4;
  const bz = Math.cos(yaw) * 0.4;
  const curPos = bot.entity.position;
  const targetX = curPos.x + bx;
  const targetY = curPos.y;
  const targetZ = curPos.z + bz;

  const support = safeBlockAt(bot, { x: targetX, y: targetY - 0.5, z: targetZ });
  if (!support || !isSafeSupportBlock(support)) return false;

  const foot = safeBlockAt(bot, { x: targetX, y: targetY + 0.1, z: targetZ });
  if (!foot || !isPassableBlock(foot)) return false;

  const head = safeBlockAt(bot, { x: targetX, y: targetY + 1.1, z: targetZ });
  if (!head || !isPassableBlock(head)) return false;

  return true;
}

export function startMicroUnstuck(
  bot: NavigationBot,
  taskState: NavigationTaskState,
  now: number,
  logger?: NavigationLogger
): boolean {
  if (taskState.microUnstuckAttempts >= 3) {
    taskState.microUnstuckDone = true;
    return false;
  }

  const left = checkLateralSafety(bot, 'left');
  const right = checkLateralSafety(bot, 'right');

  let chosenSide: 'left' | 'right' | null = null;
  // If this is a retry and previous attempt used preferredSide, alternate if alternative is safe
  if (taskState.microUnstuckAttempts > 0 && taskState.preferredSide) {
    const otherSide = taskState.preferredSide === 'left' ? 'right' : 'left';
    const otherSafe = otherSide === 'left' ? left.safe : right.safe;
    const prefSafe = taskState.preferredSide === 'left' ? left.safe : right.safe;
    if (otherSafe) {
      chosenSide = otherSide;
    } else if (prefSafe) {
      chosenSide = taskState.preferredSide;
    }
  } else {
    if (left.safe) {
      chosenSide = 'left';
    } else if (right.safe) {
      chosenSide = 'right';
    }
  }

  if (!chosenSide) {
    logger?.info('[recovery] micro-unstuck skipped: no safe lateral ground or cliff detected');
    taskState.microUnstuckAttempts++;
    taskState.microUnstuckDone = (taskState.microUnstuckAttempts >= 3);
    return false;
  }

  taskState.microUnstuckAttempts++;
  taskState.microUnstuckDone = (taskState.microUnstuckAttempts >= 3);

  // Pathfinder and manual controls must never compete simultaneously
  try {
    (bot.pathfinder as any)?.stop?.();
  } catch {}
  try {
    (bot as any).clearControlStates?.();
  } catch {}

  // Phase 1: Disengage (200ms) - back off + lateral to pull away from corner edge
  const canBack = isSafeBackward(bot);
  if (canBack) {
    bot.setControlState?.('back', true);
  }
  bot.setControlState?.(chosenSide, true);

  taskState.microUnstuckActive = true;
  taskState.microUnstuckPhase = 'disengage';
  taskState.microUnstuckPhaseUntil = now + 200;
  taskState.microUnstuckUntil = now + 450; // total 450ms (~500ms limit)
  taskState.preferredSide = chosenSide;

  logger?.info(`[recovery] micro-unstuck attempt ${taskState.microUnstuckAttempts}/3 started: side=${chosenSide}, back=${canBack}`);
  return true;
}

export function stepMicroUnstuck(
  bot: NavigationBot,
  taskState: NavigationTaskState,
  now: number,
  logger?: NavigationLogger
): { active: boolean; finishedJustNow: boolean } {
  if (!taskState.microUnstuckActive) {
    return { active: false, finishedJustNow: false };
  }

  const side = taskState.preferredSide ?? 'left';

  // Phase 2 completion or total time expired
  if (now >= taskState.microUnstuckUntil) {
    cancelMicroUnstuck(bot, taskState);
    logger?.info(`[recovery] micro-unstuck attempt ${taskState.microUnstuckAttempts}/3 completed; restored controls`);
    return { active: false, finishedJustNow: true };
  }

  // Transition from Phase 1 (Disengage) to Phase 2 (Clearance)
  if (taskState.microUnstuckPhase === 'disengage') {
    if (now >= taskState.microUnstuckPhaseUntil) {
      bot.setControlState?.('back', false);
      bot.setControlState?.('forward', true);
      bot.setControlState?.(side, true);
      if (bot.entity?.isCollidedHorizontally) {
        bot.setControlState?.('jump', true);
      }
      taskState.microUnstuckPhase = 'clearance';
      taskState.microUnstuckPhaseUntil = taskState.microUnstuckUntil;
      logger?.info('[recovery] micro-unstuck entered phase 2: outer arc clearance forward + side');
    }
    return { active: true, finishedJustNow: false };
  }

  return { active: true, finishedJustNow: false };
}

export function cancelMicroUnstuck(
  bot: NavigationBot,
  taskState: NavigationTaskState
): void {
  if (taskState.microUnstuckActive) {
    try {
      (bot as any).clearControlStates?.();
    } catch {}
    bot.setControlState?.('left', false);
    bot.setControlState?.('right', false);
    bot.setControlState?.('jump', false);
    bot.setControlState?.('forward', false);
    bot.setControlState?.('back', false);
    taskState.microUnstuckActive = false;
    taskState.microUnstuckPhase = 'none';
  }
}

export class NavigationRecoveryCoordinator {
  private lastPos: { x: number; y: number; z: number } | null = null;
  private lastProgressTime = 0;
  private pathStatus: string | null = null;
  private pathResetReason: string | null = null;
  private bot: NavigationBot;
  private taskStateGetter: () => NavigationTaskState | null;
  private boundary: { isInFlight(): boolean };
  private doorManager: { isInFlight(): boolean };
  private getTime: () => number;
  private logger: NavigationLogger | undefined;

  private onPathUpdate = (r: any) => {
    this.pathStatus = r?.status ?? null;
    if (this.pathStatus === 'partial') {
      this.lastProgressTime = this.getTime();
    }
  };

  private onPathReset = (reason: any) => {
    this.pathResetReason = typeof reason === 'string' ? reason : String(reason);
  };

  constructor(
    bot: NavigationBot,
    taskStateGetter: () => NavigationTaskState | null,
    boundary: { isInFlight(): boolean },
    doorManager: { isInFlight(): boolean },
    getTime: () => number,
    logger?: NavigationLogger
  ) {
    this.bot = bot;
    this.taskStateGetter = taskStateGetter;
    this.boundary = boundary;
    this.doorManager = doorManager;
    this.getTime = getTime;
    this.logger = logger;
  }

  start() {
    const now = this.getTime();
    this.lastProgressTime = now;
    if (this.bot.entity?.position) {
      this.lastPos = { ...this.bot.entity.position };
    }
    this.pathStatus = null;
    this.pathResetReason = null;
    (this.bot as any).on?.('path_update', this.onPathUpdate);
    (this.bot as any).on?.('path_reset', this.onPathReset);
  }

  update(restoreGoal: () => void): { actionResult?: { status: 'FAILURE'; reason: string }; isStuckHandling: boolean } {
    const taskState = this.taskStateGetter();
    const now = this.getTime();

    // 1. If micro-unstuck is active, step it
    if (taskState?.microUnstuckActive) {
      const unstuck = stepMicroUnstuck(this.bot, taskState, now, this.logger);
      if (unstuck.finishedJustNow) {
        // Restore original goal once
        restoreGoal();
        this.lastProgressTime = now;
        if (this.bot.entity?.position) this.lastPos = { ...this.bot.entity.position };
        this.pathStatus = null;
        this.pathResetReason = null;
        taskState.normalMovingStart = now;
        return { isStuckHandling: false };
      }
      return { isStuckHandling: true };
    }

    // 2. Track position progress
    const currentPos = this.bot.entity?.position;
    if (currentPos && this.lastPos) {
      const mdx = currentPos.x - this.lastPos.x;
      const mdy = currentPos.y - this.lastPos.y;
      const mdz = currentPos.z - this.lastPos.z;
      const movedDist = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
      if (movedDist >= 0.15) {
        this.lastPos = { ...currentPos };
        this.lastProgressTime = now;
        if (taskState?.recoveryActive && taskState.normalMovingStart === 0) {
          taskState.normalMovingStart = now;
        }
      }
    } else if (currentPos) {
      this.lastPos = { ...currentPos };
      this.lastProgressTime = now;
    }

    // 3. Waiting for legal digging/placing or door opening does NOT count as stalled
    if (this.boundary.isInFlight() || this.doorManager.isInFlight()) {
      this.lastProgressTime = now;
    }

    // 4. partial extends search, does NOT count as stalled
    if (this.pathStatus === 'partial') {
      this.lastProgressTime = now;
    }

    // 5. Check if stalled
    const stalledByTime = (now - this.lastProgressTime) >= 1500;
    const stalledByPath = this.pathStatus === 'noPath' || this.pathStatus === 'timeout' || this.pathResetReason === 'stuck';

    if (stalledByTime || stalledByPath) {
      if (taskState) {
        taskState.normalMovingStart = 0;
        if (!taskState.recoveryActive) {
          taskState.recoveryActive = true;
          taskState.recoveryStart = now;
          taskState.recoveryDeadline = now + 15000;
          taskState.originPos = currentPos ? { ...currentPos } : null;
          taskState.microUnstuckDone = false;
          taskState.waypointAttempts = 0;
          this.logger?.info('[recovery] entering recovery due to stall', {
            stalledByTime,
            stalledByPath,
            pathStatus: this.pathStatus,
            pathResetReason: this.pathResetReason,
          });
        }

        if (now >= taskState.recoveryDeadline) {
          this.logger?.warn('[recovery] recovery deadline expired (15s), stopping navigation');
          return {
            actionResult: {
              status: 'FAILURE',
              reason: 'Path obstructed. Stopped; send !follow, !come or !return to retry.',
            },
            isStuckHandling: true,
          };
        }

        if (taskState.microUnstuckAttempts < 3) {
          const started = startMicroUnstuck(this.bot, taskState, now, this.logger);
          if (started) {
            return { isStuckHandling: true };
          }
        } else {
          this.logger?.warn('[recovery] micro-unstuck attempts exhausted (3/3), path obstructed');
          return {
            actionResult: {
              status: 'FAILURE',
              reason: 'Path obstructed. Stopped; send !follow, !come or !return to retry.',
            },
            isStuckHandling: true,
          };
        }
      }
    }

    // 6. Check recovery exit condition: >= 5s normal movement and >= 6 blocks net displacement
    if (taskState?.recoveryActive && !taskState.microUnstuckActive && taskState.normalMovingStart > 0) {
      if (taskState.originPos && currentPos) {
        const netDist = Math.hypot(currentPos.x - taskState.originPos.x, currentPos.z - taskState.originPos.z);
        if (now - taskState.normalMovingStart >= 5000 && netDist >= 6.0) {
          this.logger?.info('[recovery] recovery completed successfully, net displacement >= 6 blocks in >= 5s');
          taskState.recoveryActive = false;
          taskState.microUnstuckAttempts = 0;
          taskState.microUnstuckDone = false;
          taskState.waypointAttempts = 0;
          taskState.normalMovingStart = 0;
        }
      }
    }

    return { isStuckHandling: false };
  }

  cancel() {
    (this.bot as any).removeListener?.('path_update', this.onPathUpdate);
    (this.bot as any).removeListener?.('path_reset', this.onPathReset);
    const taskState = this.taskStateGetter();
    if (taskState) {
      cancelMicroUnstuck(this.bot, taskState);
    }
  }

  isStopped(): boolean {
    const taskState = this.taskStateGetter();
    return !this.boundary.isInFlight() && !this.doorManager.isInFlight() && !(taskState?.microUnstuckActive);
  }

  getPathStatus(): string | null {
    return this.pathStatus;
  }

  getPathResetReason(): string | null {
    return this.pathResetReason;
  }
}
