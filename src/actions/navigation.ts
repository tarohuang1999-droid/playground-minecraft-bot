import { goals, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { THRESHOLDS } from '../policy.ts';
import type { ActionAdapter, ActionContext, ActionRequest, ActionResult, AdapterFactory } from '../execution/types.ts';

const { GoalFollow, GoalNear, GoalNearXZ } = goals;

export interface NavigationEntity {
  id: number;
  position: { x: number; y: number; z: number };
}

export interface NavigationBot {
  entity?: {
    position: { x: number; y: number; z: number };
    yaw?: number;
    onGround?: boolean;
    isCollidedHorizontally?: boolean;
  };
  pathfinder?: {
    setGoal(goal: unknown, dynamic?: boolean): void;
    setMovements?(movements: unknown): void;
    isMoving?(): boolean;
  };
  setControlState?(control: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak', state: boolean): void;
  blockAt?(pos: any): any;
  activateBlock?(block: any): Promise<void>;
  entities: Record<string | number, NavigationEntity>;
  players: Record<string, { entity?: NavigationEntity }>;
  registry?: unknown;
}

export interface NavigationLogger {
  info(m: string, d?: unknown): void;
  warn(m: string, d?: unknown): void;
  error?(m: string, d?: unknown): void;
}

export function safeBlockAt(bot: NavigationBot, pos: { x: number; y: number; z: number }): any {
  if (!bot || typeof bot.blockAt !== 'function' || !pos) return null;
  try {
    const v = (pos as any)?.floored ? (pos as any) : new Vec3(pos.x, pos.y, pos.z);
    return bot.blockAt(v);
  } catch {
    return null;
  }
}

export function isDoorBlock(block: any): boolean {
  if (!block || !block.name) return false;
  const name = block.name.toLowerCase();
  return (name.includes('door') || name.includes('gate') || name.includes('trapdoor')) && !name.includes('iron');
}

export function isDoorOpen(block: any): boolean {
  if (!block) return false;
  const props = block._properties || (typeof block.getProperties === 'function' ? block.getProperties() : {});
  return props.open === true || props.open === 'true';
}

export function isPassable(block: any): boolean {
  if (!block) return true;
  if (block.boundingBox === 'empty') return true;
  if (!Array.isArray(block.shapes) || block.shapes.length === 0) return true;
  if (isDoorBlock(block) && isDoorOpen(block)) return true;
  const name = block.name ? block.name.toLowerCase() : '';
  if (name.includes('torch') || name.includes('sign') || name.includes('ladder') || name.includes('vine')) {
    return true;
  }
  return false;
}

export function getBlockTopY(block: any, fallbackPos?: { x: number; y: number; z: number }): number | null {
  if (!block) return null;
  const posY = block.position?.y ?? fallbackPos?.y;
  if (typeof posY !== 'number') return null;
  if (Array.isArray(block.shapes) && block.shapes.length > 0) {
    let maxY = 0;
    for (const shape of block.shapes) {
      if (Array.isArray(shape) && shape.length >= 5 && shape[4] > maxY) {
        maxY = shape[4];
      }
    }
    if (maxY > 0) return posY + maxY;
  }
  if (block.boundingBox === 'block') {
    return posY + 1.0;
  }
  return null;
}

export class DoorManager {
  private doorCooldowns = new Map<string, number>();
  private inFlight = false;

  tryOpenDoorInFront(bot: NavigationBot, logger?: NavigationLogger): boolean {
    if (this.inFlight) return false;
    if (typeof bot.blockAt !== 'function' || !bot.entity?.position) return false;

    const yaw = bot.entity.yaw ?? 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const pos = bot.entity.position;
    const now = Date.now();

    // Clean up old cooldown entries (> 10s)
    for (const [key, time] of this.doorCooldowns) {
      if (now - time > 10000) this.doorCooldowns.delete(key);
    }

    // Candidate offsets:
    // 1. Raycast along facing direction at distances 0.5, 0.9, 1.3, 1.7 at foot (0.1) and torso (1.0)
    const candidates: Array<{ x: number; y: number; z: number }> = [];
    for (const dist of [0.5, 0.9, 1.3, 1.7]) {
      for (const yOffset of [0.1, 1.0]) {
        candidates.push({ x: pos.x + fx * dist, y: pos.y + yOffset, z: pos.z + fz * dist });
      }
    }

    // 2. If collided horizontally, also check adjacent cardinal neighbors that are roughly in front
    if (bot.entity.isCollidedHorizontally) {
      const neighbors = [
        { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
      ];
      for (const n of neighbors) {
        const dot = n.dx * fx + n.dz * fz;
        if (dot >= -0.2) {
          candidates.push({ x: pos.x + n.dx, y: pos.y + 0.1, z: pos.z + n.dz });
          candidates.push({ x: pos.x + n.dx, y: pos.y + 1.0, z: pos.z + n.dz });
        }
      }
    }

    for (const pt of candidates) {
      const block = safeBlockAt(bot, pt);
      if (isDoorBlock(block)) {
        // If the door is already open, NEVER touch it!
        if (isDoorOpen(block)) {
          continue;
        }

        const props = block._properties || (typeof block.getProperties === 'function' ? block.getProperties() : {});
        const isUpper = props.half === 'upper';
        const rootY = isUpper && block.position ? block.position.y - 1 : (block.position?.y ?? Math.floor(pt.y));
        const rootX = block.position?.x ?? Math.floor(pt.x);
        const rootZ = block.position?.z ?? Math.floor(pt.z);
        const doorKey = `${rootX},${rootY},${rootZ}`;

        const lastInteraction = this.doorCooldowns.get(doorKey) ?? 0;
        if (now - lastInteraction < 1500) {
          // Cooldown active for this door, prevent rapid open/close flapping
          continue;
        }

        if (typeof bot.activateBlock === 'function') {
          this.doorCooldowns.set(doorKey, now);
          this.inFlight = true;
          logger?.info('[navigation] opening closed door: ' + block.name, { doorKey });

          // Prefer activating the lower block if upper half was detected
          let targetBlock = block;
          if (isUpper && block.position) {
            const lower = safeBlockAt(bot, { x: block.position.x, y: block.position.y - 1, z: block.position.z });
            if (lower && isDoorBlock(lower)) targetBlock = lower;
          }

          try {
            const p = bot.activateBlock(targetBlock);
            if (p && typeof p.catch === 'function') {
              p.catch(err => {
                logger?.warn('[navigation] activateBlock error: ' + (err?.message ?? String(err)));
              }).finally(() => {
                this.inFlight = false;
              });
            } else {
              this.inFlight = false;
            }
          } catch (err: any) {
            this.inFlight = false;
            logger?.warn('[navigation] activateBlock sync error: ' + (err?.message ?? String(err)));
          }
          return true;
        }
      }
    }
    return false;
  }

  reset() {
    this.inFlight = false;
  }
}

const defaultDoorManager = new DoorManager();
export function tryOpenDoorInFront(bot: NavigationBot, logger?: NavigationLogger): boolean {
  return defaultDoorManager.tryOpenDoorInFront(bot, logger);
}

export function isClimbingLadder(bot: NavigationBot): boolean {
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) return false;
  const pos = bot.entity.position;
  const current = safeBlockAt(bot, pos);
  if (current?.name && (current.name.includes('ladder') || current.name.includes('vine'))) return true;
  const below = safeBlockAt(bot, { x: pos.x, y: pos.y - 0.5, z: pos.z });
  if (below?.name && (below.name.includes('ladder') || below.name.includes('vine'))) return true;
  return false;
}

export function shouldJumpObstacle(bot: NavigationBot): boolean {
  if (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally) return false;
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) return false;

  const yaw = bot.entity.yaw ?? 0;
  // Minecraft forward vector
  const dx = -Math.sin(yaw) * 0.7;
  const dz = -Math.cos(yaw) * 0.7;
  const pos = bot.entity.position;

  const frontBlock = safeBlockAt(bot, { x: pos.x + dx, y: pos.y + 0.1, z: pos.z + dz });
  if (!frontBlock) return false;

  // Doors are handled by tryOpenDoorInFront, not jumping
  if (isDoorBlock(frontBlock)) return false;

  const topY = getBlockTopY(frontBlock, { x: pos.x + dx, y: Math.floor(pos.y + 0.1), z: pos.z + dz });
  if (topY === null) return false;

  const heightDiff = topY - pos.y;
  // Step/jump height in Minecraft is between 0.05 (slab/step) and 1.25 blocks
  if (heightDiff > 0.05 && heightDiff <= 1.25) {
    const head1 = safeBlockAt(bot, { x: pos.x + dx, y: topY + 0.5, z: pos.z + dz });
    const head2 = safeBlockAt(bot, { x: pos.x + dx, y: topY + 1.5, z: pos.z + dz });
    const ownHead = safeBlockAt(bot, { x: pos.x, y: pos.y + 2.0, z: pos.z });
    return isPassable(head1) && isPassable(head2) && isPassable(ownHead);
  }

  return false;
}

export function setupMovements(bot: NavigationBot, logger?: NavigationLogger): Movements | null {
  if (!bot.pathfinder) {
    logger?.warn('[navigation] cannot setup movements: pathfinder plugin not loaded');
    return null;
  }
  if (!bot.registry) {
    logger?.warn('[navigation] cannot setup movements: bot.registry not ready');
    return null;
  }
  try {
    const movements = new Movements(bot as any);
    movements.canDig = false;           // Detour around obstacles instead of digging through them
    movements.allowParkour = true;      // Jump over 1-block gaps
    movements.allowSprinting = false;   // Prevent sprint-simulation jump suppression bug
    movements.canOpenDoors = false;     // Keep false in pathfinder! Our DoorManager handles opening doors cleanly without pathfinder's useOne bug
    movements.allow1by1towers = false;  // Do not place scaffolding blocks under self

    const registry = bot.registry as any;
    if (registry?.blocksByName?.vine) {
      movements.climbables.add(registry.blocksByName.vine.id);
    }

    // Patch movements.getBlock to ensure open doors and closed wooden doors are walkable in A*
    const origGetBlock = movements.getBlock;
    movements.getBlock = function (pos: any, dx: number, dy: number, dz: number) {
      const b = origGetBlock.call(this, pos, dx, dy, dz);
      if (b && isDoorBlock(b)) {
        b.physical = false;
        b.safe = true;
      }
      return b;
    };

    bot.pathfinder.setMovements?.(movements);
    logger?.info('[navigation] Movements successfully configured', {
      canDig: movements.canDig,
      allowParkour: movements.allowParkour,
      allowSprinting: movements.allowSprinting,
      canOpenDoors: movements.canOpenDoors,
    });
    return movements;
  } catch (err: any) {
    logger?.warn('[navigation] Failed to setup movements: ' + (err?.message ?? String(err)));
    return null;
  }
}

function resolveTarget(bot: NavigationBot, targetId: number | null, owner: string): NavigationEntity | null {
  if (targetId !== null && (bot.entities as any)[targetId]) {
    return (bot.entities as any)[targetId];
  }
  const playerObj = Object.values(bot.players).find(p => (p as any).username?.toLowerCase() === owner.toLowerCase());
  if (playerObj?.entity) return playerObj.entity;
  const entityObj = Object.values(bot.entities).find(e => ((e as any).username ?? (e as any).name ?? '').toLowerCase() === owner.toLowerCase());
  if (entityObj) return entityObj;
  return null;
}

export function findWalkableY(
  bot: NavigationBot,
  x: number,
  startY: number,
  z: number
): number | null {
  if (typeof bot.blockAt !== 'function') return startY;

  let testedAnyBlock = false;

  // Search vertical offset within [-4, +4] for open space with solid footing
  for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const testY = Math.floor(startY + dy);
    const feet = safeBlockAt(bot, { x, y: testY, z });
    const head = safeBlockAt(bot, { x, y: testY + 1, z });
    const ground = safeBlockAt(bot, { x, y: testY - 1, z });

    if (feet || head || ground) {
      testedAnyBlock = true;
    }

    if (!feet || !head || !ground) continue;

    const feetSolid = feet.boundingBox === 'block';
    const headSolid = head.boundingBox === 'block';
    const groundSolid = ground.boundingBox === 'block';
    const hasLava = feet.name?.includes('lava') || ground.name?.includes('lava');

    // Walkable space: passable at feet and head, solid footing underneath, not lava
    if (!feetSolid && !headSolid && groundSolid && !hasLava) {
      return testY;
    }
  }

  // If no block info was returned (unloaded chunks or test mocks returning null)
  if (!testedAnyBlock) {
    return startY;
  }

  return null;
}

export function findSafestEscapePosition(
  bot: NavigationBot,
  threats: readonly { position: { x: number; y: number; z: number } }[],
  origin: { x: number; y: number; z: number },
  options: {
    radius?: number | undefined;
    dangerRadius?: number | undefined;
    angleCount?: number | undefined;
    avoidAngle?: number | undefined;
  } = {}
): { x: number; y: number; z: number } {
  const baseRadius = options.radius ?? 12;
  const dangerRadius = options.dangerRadius ?? 10;
  const angleCount = options.angleCount ?? 16;

  // Try multiple radii (e.g. 12, 8, 5) in case large radius is obstructed by cave walls
  const radiiToTry = [baseRadius];
  if (baseRadius > 8) radiiToTry.push(8);
  if (baseRadius > 5) radiiToTry.push(5);

  let bestCandidate: { x: number; y: number; z: number } | null = null;
  let lowestThreatCount = Infinity;
  let maxMinDistance = -Infinity;

  for (const radius of radiiToTry) {
    for (let i = 0; i < angleCount; i++) {
      const angle = (i * 2 * Math.PI) / angleCount;

      // If avoidAngle is specified, skip directions within 30 degrees
      if (options.avoidAngle !== undefined) {
        let diff = Math.abs(angle - options.avoidAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < Math.PI / 6) continue;
      }

      const cx = origin.x + radius * Math.cos(angle);
      const cz = origin.z + radius * Math.sin(angle);
      const cy = findWalkableY(bot, cx, origin.y, cz);

      // If candidate is inside solid wall or has no walkable ground, skip!
      if (cy === null) {
        continue;
      }

      let threatCount = 0;
      let minThreatDist = Infinity;

      for (const threat of threats) {
        const d = Math.hypot(threat.position.x - cx, threat.position.z - cz);
        if (d <= dangerRadius) {
          threatCount++;
        }
        if (d < minThreatDist) {
          minThreatDist = d;
        }
      }

      if (threats.length === 0) {
        minThreatDist = radius;
      }

      // Prioritize fewest threats in the area; break ties with maximum distance to closest threat
      if (threatCount < lowestThreatCount || (threatCount === lowestThreatCount && minThreatDist > maxMinDistance)) {
        lowestThreatCount = threatCount;
        maxMinDistance = minThreatDist;
        bestCandidate = { x: cx, y: cy, z: cz };
      }
    }

    if (bestCandidate !== null) {
      break;
    }
  }

  // Fallback: if all directions are blocked by walls, step away from closest threat
  if (!bestCandidate && threats.length > 0 && threats[0]) {
    const closest = threats[0];
    const dx = origin.x - closest.position.x;
    const dz = origin.z - closest.position.z;
    const len = Math.hypot(dx, dz) || 1;
    return {
      x: origin.x + (dx / len) * 4,
      y: origin.y,
      z: origin.z + (dz / len) * 4,
    };
  }

  return bestCandidate ?? { x: origin.x - baseRadius, y: origin.y, z: origin.z };
}

export interface NavigationCallbacks {
  onComeArrived?: () => void;
  onReturnArrived?: () => void;
}

export function createNavigation(bot: NavigationBot, logger?: NavigationLogger, callbacks?: NavigationCallbacks) {
  const doorManager = new DoorManager();

  function followAdapter(range: number, exitDistance: number): AdapterFactory {
    return (request: ActionRequest): ActionAdapter => {
      let activeGoal: unknown = null;
      let lastPos: { x: number; y: number; z: number } | null = null;
      let lastProgressTime = 0;
      let lastRepathTime = 0;
      let isJumping = false;

      return {
        start(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          if (!bot.pathfinder) {
            logger?.warn('[navigation] cannot follow: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }
          const snapshot = ctx.getSnapshot();
          const target = resolveTarget(bot, request.targetId, snapshot.world.master.username);
          if (!target) {
            logger?.warn('[navigation] target not visible for owner: ' + snapshot.world.master.username);
            bot.pathfinder.setGoal(null);
            return { status: 'FAILURE', reason: 'Target not visible' };
          }
          logger?.info(`[navigation] GoalFollow started towards ${snapshot.world.master.username}`, {
            range,
            distance: snapshot.world.master.distance,
            targetPos: target.position,
          });
          const now = Date.now();
          lastProgressTime = now;
          lastRepathTime = now;
          if (bot.entity?.position) {
            lastPos = { ...bot.entity.position };
          }
          activeGoal = new GoalFollow(target as any, range);
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }
          bot.pathfinder.setGoal(activeGoal, true);
        },
        update(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          const snapshot = ctx.getSnapshot();
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }
          const target = resolveTarget(bot, request.targetId, snapshot.world.master.username);
          if (!target) {
            logger?.warn('[navigation] target lost during follow');
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'FAILURE', reason: 'Target lost' };
          }

          const selfPos = bot.entity?.position ?? snapshot.world.self.position;
          const dx = target.position.x - selfPos.x;
          const dy = target.position.y - selfPos.y;
          const dz = target.position.z - selfPos.z;
          const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const vertDist = Math.abs(dy);

          // Exit only when close in 3D space (within 1.2 blocks) AND height-aligned (|dy| <= 1.2)
          if (dist3D <= exitDistance && vertDist <= 1.2) {
            logger?.info(`[navigation] reached target (distance ${dist3D.toFixed(1)} <= ${exitDistance}, dy=${dy.toFixed(1)})`);
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'SUCCESS' };
          }

          const now = Date.now();

          // 1. Proactive Door Opening:
          const openedDoor = doorManager.tryOpenDoorInFront(bot, logger);
          if (openedDoor) {
            lastProgressTime = now;
            if (now - lastRepathTime > 500) {
              lastRepathTime = now;
              activeGoal = new GoalFollow(target as any, range);
              bot.pathfinder?.setGoal(activeGoal, true);
            }
          }

          // 2. Ladder / Vine Climbing Check:
          if (isClimbingLadder(bot)) {
            if (dy > 0.3) {
              bot.setControlState?.('jump', true);
              isJumping = true;
            } else {
              bot.setControlState?.('jump', false);
              isJumping = false;
            }
          } else {
            // 3. Obstacle (Slab, Stair, 1-Block Step) Jump Check:
            if (shouldJumpObstacle(bot)) {
              bot.setControlState?.('jump', true);
              isJumping = true;
            } else if (isJumping && (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally)) {
              bot.setControlState?.('jump', false);
              isJumping = false;
            }
          }

          // 4. Obstruction Detour & Stuck Detection:
          // If bot hasn't made progress towards goal, or path is empty/idle while distance > exitDistance
          const currentPos = bot.entity?.position;
          if (currentPos && lastPos) {
            const mdx = currentPos.x - lastPos.x;
            const mdy = currentPos.y - lastPos.y;
            const mdz = currentPos.z - lastPos.z;
            const movedDist = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
            if (movedDist >= 0.15) {
              lastPos = { ...currentPos };
              lastProgressTime = now;
            }
          } else if (currentPos) {
            lastPos = { ...currentPos };
            lastProgressTime = now;
          }

          const isMoving = bot.pathfinder?.isMoving ? bot.pathfinder.isMoving() : true;
          const progressStalled = (now - lastProgressTime) > 1000;
          const pathfinderIdle = !isMoving && (now - lastProgressTime) > 600;

          if ((progressStalled || pathfinderIdle) && (now - lastRepathTime) > 1200) {
            logger?.info('[navigation] path obstructed or idle, recalculating detour around obstacle...', {
              distance: dist3D,
              progressStalled,
              pathfinderIdle,
            });
            lastRepathTime = now;
            lastProgressTime = now;
            if (currentPos) lastPos = { ...currentPos };
            activeGoal = new GoalFollow(target as any, range);
            bot.pathfinder?.setGoal(activeGoal, true);
          }
        },
        cancel() {
          logger?.info('[navigation] GoalFollow cancelled');
          activeGoal = null;
          bot.setControlState?.('jump', false);
          bot.pathfinder?.setGoal(null);
          doorManager.reset();
        },
      };
    };
  }

  function pickupItemAdapter(): AdapterFactory {
    return (request: ActionRequest): ActionAdapter => {
      let startTime = 0;
      let activeGoal: unknown = null;
      let targetEntityId: number | null = request.targetId;
      let lastPos: { x: number; y: number; z: number } | null = null;
      let lastProgressTime = 0;
      let lastRepathTime = 0;
      let isJumping = false;

      return {
        start(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          if (!bot.pathfinder) {
            logger?.warn('[navigation] cannot pickup: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }
          startTime = Date.now();
          lastProgressTime = startTime;
          lastRepathTime = startTime;
          targetEntityId = request.targetId;
          const target = targetEntityId !== null ? bot.entities[targetEntityId] : null;
          if (!target || !target.position) {
            logger?.warn('[navigation] pickup target not found: ' + targetEntityId);
            return { status: 'FAILURE', reason: 'Target item not found' };
          }
          if (bot.entity?.position) {
            lastPos = { ...bot.entity.position };
          }
          logger?.info(`[navigation] PickupItem started towards entity ${targetEntityId}`, {
            itemPos: target.position,
          });
          activeGoal = new GoalNear(target.position.x, target.position.y, target.position.z, 0.8);
          bot.pathfinder.setGoal(activeGoal, false);
        },
        update(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          const now = Date.now();

          // 1. Check 4-second timeout
          if (now - startTime > 4000) {
            logger?.warn(`[navigation] PickupItem timed out (> 4s) for entity ${targetEntityId}`);
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'FAILURE', reason: 'Pickup timed out after 4000ms' };
          }

          // 2. Check if item has been picked up (target entity disappeared from bot.entities)
          const target = targetEntityId !== null ? bot.entities[targetEntityId] : null;
          if (!target || !target.position) {
            logger?.info(`[navigation] PickupItem success: entity ${targetEntityId} collected`);
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'SUCCESS' };
          }

          // 3. Proactive door opening
          const openedDoor = doorManager.tryOpenDoorInFront(bot, logger);
          if (openedDoor) {
            lastProgressTime = now;
            if (now - lastRepathTime > 500) {
              lastRepathTime = now;
              activeGoal = new GoalNear(target.position.x, target.position.y, target.position.z, 0.8);
              bot.pathfinder?.setGoal(activeGoal, false);
            }
          }

          // 4. Climbing ladder
          if (isClimbingLadder(bot)) {
            bot.setControlState?.('jump', true);
            isJumping = true;
          } else {
            // 5. Obstacle Jump Check
            if (shouldJumpObstacle(bot)) {
              bot.setControlState?.('jump', true);
              isJumping = true;
            } else if (isJumping && (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally)) {
              bot.setControlState?.('jump', false);
              isJumping = false;
            }
          }

          // 6. Obstruction & Stuck Detection
          const currentPos = bot.entity?.position;
          if (currentPos && lastPos) {
            const mdx = currentPos.x - lastPos.x;
            const mdy = currentPos.y - lastPos.y;
            const mdz = currentPos.z - lastPos.z;
            const movedDist = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
            if (movedDist >= 0.15) {
              lastPos = { ...currentPos };
              lastProgressTime = now;
            }
          } else if (currentPos) {
            lastPos = { ...currentPos };
            lastProgressTime = now;
          }

          const isMoving = bot.pathfinder?.isMoving ? bot.pathfinder.isMoving() : true;
          const progressStalled = (now - lastProgressTime) > 1500;
          if (progressStalled && !isMoving) {
            logger?.warn(`[navigation] PickupItem path obstructed or idle for entity ${targetEntityId}`);
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'FAILURE', reason: 'Unreachable item drop' };
          }
        },
        cancel() {
          logger?.info('[navigation] PickupItem cancelled');
          activeGoal = null;
          bot.setControlState?.('jump', false);
          bot.pathfinder?.setGoal(null);
          doorManager.reset();
        },
      };
    };
  }

  function retreatAdapter(): AdapterFactory {
    return (_request: ActionRequest): ActionAdapter => {
      let activeGoal: unknown = null;
      let targetPos: { x: number; y: number; z: number } | null = null;
      let isJumping = false;
      let lastPos: { x: number; y: number; z: number } | null = null;
      let lastProgressTime = 0;
      let lastRepathTime = 0;
      let lastAngle: number | undefined = undefined;

      return {
        start(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          if (!bot.pathfinder) {
            logger?.warn('[navigation] cannot retreat: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }

          const snapshot = ctx.getSnapshot();
          const origin = bot.entity?.position ?? snapshot.world.self.position;
          const threats = snapshot.world.threats;

          const now = Date.now();
          lastProgressTime = now;
          lastRepathTime = now;
          if (bot.entity?.position) {
            lastPos = { ...bot.entity.position };
          }

          targetPos = findSafestEscapePosition(bot, threats, origin);
          lastAngle = Math.atan2(targetPos.z - origin.z, targetPos.x - origin.x);
          logger?.info(`[navigation] Retreat started towards safest position (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);

          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = false;
          }

          activeGoal = new GoalNearXZ(targetPos.x, targetPos.z, 2.0);
          bot.pathfinder.setGoal(activeGoal); // Static goal, dynamic must be false
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;

          const snapshot = ctx.getSnapshot();
          const threats = snapshot.world.threats;
          const threatsInRange = threats.filter(t => t.distance < THRESHOLDS.retreatExit);

          // All threats reached safe distance (>= 18 blocks) or gone
          if (threatsInRange.length === 0) {
            logger?.info('[navigation] Retreat completed: reached safe distance from all threats');
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'SUCCESS' };
          }

          const now = Date.now();
          const currentPos = bot.entity?.position ?? snapshot.world.self.position;

          // 1. Proactive Door Opening
          doorManager.tryOpenDoorInFront(bot, logger);

          // 2. Obstacle jump check
          if (shouldJumpObstacle(bot)) {
            bot.setControlState?.('jump', true);
            isJumping = true;
          } else if (isJumping && (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally)) {
            bot.setControlState?.('jump', false);
            isJumping = false;
          }

          // 3. Movement progress & Stuck detection
          if (currentPos && lastPos) {
            const mdist = Math.hypot(currentPos.x - lastPos.x, currentPos.z - lastPos.z);
            if (mdist >= 0.2) {
              lastPos = { ...currentPos };
              lastProgressTime = now;
            }
          } else if (currentPos) {
            lastPos = { ...currentPos };
            lastProgressTime = now;
          }

          const isMoving = bot.pathfinder?.isMoving ? bot.pathfinder.isMoving() : true;
          const progressStalled = (now - lastProgressTime) > 1200;
          const pathfinderIdle = !isMoving && (now - lastProgressTime) > 800;

          // Fail-safe: if stuck/stalled for > 3.5 seconds, bot is trapped in a corner or boxed in!
          // Abort retreat so Combat can take over and defend against the attacking mobs!
          if (now - lastProgressTime > 3500) {
            logger?.warn('[navigation] Retreat path trapped or stalled for > 3.5s, aborting retreat so bot can defend');
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            return { status: 'FAILURE', reason: 'Retreat path trapped or obstructed' };
          }

          // Re-route if path is stalled or idle
          if ((progressStalled || pathfinderIdle) && (now - lastRepathTime) > 1000) {
            logger?.info('[navigation] retreat path obstructed or idle, re-sampling safe direction...');
            lastRepathTime = now;
            targetPos = findSafestEscapePosition(bot, threats, currentPos, {
              radius: 8,
              avoidAngle: lastAngle,
            });
            lastAngle = Math.atan2(targetPos.z - currentPos.z, targetPos.x - currentPos.x);
            activeGoal = new GoalNearXZ(targetPos.x, targetPos.z, 2.0);
            bot.pathfinder?.setGoal(activeGoal);
          }

          // If reached current target point but threats are still pursuing (< retreatExit)
          if (targetPos) {
            const distToGoal = Math.hypot(targetPos.x - currentPos.x, targetPos.z - currentPos.z);
            if (distToGoal <= 2.0 && (now - lastRepathTime) > 800) {
              lastRepathTime = now;
              targetPos = findSafestEscapePosition(bot, threats, currentPos);
              lastAngle = Math.atan2(targetPos.z - currentPos.z, targetPos.x - currentPos.x);
              logger?.info(`[navigation] Re-sampling retreat position to (${targetPos.x.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
              activeGoal = new GoalNearXZ(targetPos.x, targetPos.z, 2.0);
              bot.pathfinder?.setGoal(activeGoal);
            }
          }
        },

        cancel() {
          logger?.info('[navigation] Retreat cancelled');
          activeGoal = null;
          targetPos = null;
          bot.setControlState?.('jump', false);
          bot.pathfinder?.setGoal(null);
          doorManager.reset();
        },
      };
    };
  }

  function comeOnceAdapter(onArrival?: () => void): AdapterFactory {
    return (request: ActionRequest): ActionAdapter => {
      let activeGoal: unknown = null;
      let targetPos: { x: number; y: number; z: number } | null = null;
      let lastPos: { x: number; y: number; z: number } | null = null;
      let lastProgressTime = 0;
      let lastRepathTime = 0;
      let isJumping = false;

      return {
        start(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          if (!bot.pathfinder) {
            logger?.warn('[navigation] cannot come: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }
          const snapshot = ctx.getSnapshot();
          const target = (typeof request.params.x === 'number' && typeof request.params.y === 'number' && typeof request.params.z === 'number')
            ? { x: request.params.x, y: request.params.y, z: request.params.z }
            : snapshot.intent.targetPosition;
          if (!target) {
            logger?.warn('[navigation] ComeOnce target position is missing');
            bot.pathfinder.setGoal(null);
            return { status: 'FAILURE', reason: 'Target position missing' };
          }
          targetPos = { x: target.x, y: target.y, z: target.z };
          const currentPos = bot.entity?.position ?? snapshot.world.self.position;
          const dist = Math.hypot(targetPos.x - currentPos.x, targetPos.y - currentPos.y, targetPos.z - currentPos.z);
          if (dist <= 2.0) {
            logger?.info('[navigation] ComeOnce already within 2.0 blocks of target');
            onArrival?.();
            return { status: 'SUCCESS' };
          }

          logger?.info(`[navigation] ComeOnce started towards (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
          const now = Date.now();
          lastProgressTime = now;
          lastRepathTime = now;
          if (bot.entity?.position) {
            lastPos = { ...bot.entity.position };
          }
          activeGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0);
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }
          bot.pathfinder.setGoal(activeGoal, false);
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          const snapshot = ctx.getSnapshot();
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }

          if (!targetPos) {
            const target = (typeof request.params.x === 'number' && typeof request.params.y === 'number' && typeof request.params.z === 'number')
              ? { x: request.params.x, y: request.params.y, z: request.params.z }
              : snapshot.intent.targetPosition;
            if (target) targetPos = { x: target.x, y: target.y, z: target.z };
            else return { status: 'FAILURE', reason: 'Target position missing' };
          }

          const currentPos = bot.entity?.position ?? snapshot.world.self.position;
          const dist = Math.hypot(targetPos.x - currentPos.x, targetPos.y - currentPos.y, targetPos.z - currentPos.z);
          if (dist <= 2.0) {
            logger?.info('[navigation] ComeOnce arrived at target position');
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            onArrival?.();
            return { status: 'SUCCESS' };
          }

          const now = Date.now();
          doorManager.tryOpenDoorInFront(bot, logger);

          if (isClimbingLadder(bot)) {
            const dy = targetPos.y - currentPos.y;
            bot.setControlState?.('jump', dy > 0.3);
            isJumping = dy > 0.3;
          } else {
            if (shouldJumpObstacle(bot)) {
              bot.setControlState?.('jump', true);
              isJumping = true;
            } else if (isJumping && (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally)) {
              bot.setControlState?.('jump', false);
              isJumping = false;
            }
          }

          if (currentPos && lastPos) {
            const mdist = Math.hypot(currentPos.x - lastPos.x, currentPos.y - lastPos.y, currentPos.z - lastPos.z);
            if (mdist >= 0.15) {
              lastPos = { ...currentPos };
              lastProgressTime = now;
            }
          } else if (currentPos) {
            lastPos = { ...currentPos };
            lastProgressTime = now;
          }

          const isMoving = bot.pathfinder?.isMoving ? bot.pathfinder.isMoving() : true;
          const progressStalled = (now - lastProgressTime) > 1200;
          const pathfinderIdle = !isMoving && (now - lastProgressTime) > 600;

          if ((progressStalled || pathfinderIdle) && (now - lastRepathTime) > 1200) {
            logger?.info('[navigation] ComeOnce path obstructed or idle, recalculating...', { dist });
            lastRepathTime = now;
            lastProgressTime = now;
            if (currentPos) lastPos = { ...currentPos };
            activeGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0);
            bot.pathfinder?.setGoal(activeGoal, false);
          }
        },

        cancel() {
          logger?.info('[navigation] ComeOnce cancelled');
          activeGoal = null;
          targetPos = null;
          bot.setControlState?.('jump', false);
          bot.pathfinder?.setGoal(null);
          doorManager.reset();
        },
      };
    };
  }

  function returnToBaseAdapter(onArrival?: () => void): AdapterFactory {
    return (request: ActionRequest): ActionAdapter => {
      let activeGoal: unknown = null;
      let targetPos: { x: number; y: number; z: number } | null = null;
      let lastPos: { x: number; y: number; z: number } | null = null;
      let lastProgressTime = 0;
      let lastRepathTime = 0;
      let isJumping = false;

      return {
        start(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          if (!bot.pathfinder) {
            logger?.warn('[navigation] cannot return to base: pathfinder is not loaded');
            return { status: 'FAILURE', reason: 'Pathfinder is not loaded on bot' };
          }
          const snapshot = ctx.getSnapshot();
          const target = (typeof request.params.x === 'number' && typeof request.params.y === 'number' && typeof request.params.z === 'number')
            ? { x: request.params.x, y: request.params.y, z: request.params.z }
            : (snapshot.world.base ?? snapshot.world.spawnPoint);
          if (!target) {
            logger?.warn('[navigation] ReturnToBase destination is missing');
            bot.pathfinder.setGoal(null);
            return { status: 'FAILURE', reason: 'Destination missing' };
          }
          targetPos = { x: target.x, y: target.y, z: target.z };
          const currentPos = bot.entity?.position ?? snapshot.world.self.position;
          const dist = Math.hypot(targetPos.x - currentPos.x, targetPos.y - currentPos.y, targetPos.z - currentPos.z);
          if (dist <= 2.0) {
            logger?.info('[navigation] ReturnToBase already within 2.0 blocks of destination');
            onArrival?.();
            return { status: 'SUCCESS' };
          }

          logger?.info(`[navigation] ReturnToBase started towards (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
          const now = Date.now();
          lastProgressTime = now;
          lastRepathTime = now;
          if (bot.entity?.position) {
            lastPos = { ...bot.entity.position };
          }
          activeGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0);
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }
          bot.pathfinder.setGoal(activeGoal, false);
        },

        update(ctx: ActionContext): void | ActionResult {
          if (!ctx.isActive()) return;
          const snapshot = ctx.getSnapshot();
          const handLocked = snapshot.runtime.lockedResources.HAND !== null;
          if ((bot.pathfinder as any)?.movements) {
            (bot.pathfinder as any).movements.canDig = !handLocked;
          }

          if (!targetPos) {
            const target = (typeof request.params.x === 'number' && typeof request.params.y === 'number' && typeof request.params.z === 'number')
              ? { x: request.params.x, y: request.params.y, z: request.params.z }
              : (snapshot.world.base ?? snapshot.world.spawnPoint);
            if (target) targetPos = { x: target.x, y: target.y, z: target.z };
            else return { status: 'FAILURE', reason: 'Destination missing' };
          }

          const currentPos = bot.entity?.position ?? snapshot.world.self.position;
          const dist = Math.hypot(targetPos.x - currentPos.x, targetPos.y - currentPos.y, targetPos.z - currentPos.z);
          if (dist <= 2.0) {
            logger?.info('[navigation] ReturnToBase arrived at destination');
            bot.pathfinder?.setGoal(null);
            bot.setControlState?.('jump', false);
            onArrival?.();
            return { status: 'SUCCESS' };
          }

          const now = Date.now();
          doorManager.tryOpenDoorInFront(bot, logger);

          if (isClimbingLadder(bot)) {
            const dy = targetPos.y - currentPos.y;
            bot.setControlState?.('jump', dy > 0.3);
            isJumping = dy > 0.3;
          } else {
            if (shouldJumpObstacle(bot)) {
              bot.setControlState?.('jump', true);
              isJumping = true;
            } else if (isJumping && (!bot.entity?.onGround || !bot.entity?.isCollidedHorizontally)) {
              bot.setControlState?.('jump', false);
              isJumping = false;
            }
          }

          if (currentPos && lastPos) {
            const mdist = Math.hypot(currentPos.x - lastPos.x, currentPos.y - lastPos.y, currentPos.z - lastPos.z);
            if (mdist >= 0.15) {
              lastPos = { ...currentPos };
              lastProgressTime = now;
            }
          } else if (currentPos) {
            lastPos = { ...currentPos };
            lastProgressTime = now;
          }

          const isMoving = bot.pathfinder?.isMoving ? bot.pathfinder.isMoving() : true;
          const progressStalled = (now - lastProgressTime) > 1200;
          const pathfinderIdle = !isMoving && (now - lastProgressTime) > 600;

          if ((progressStalled || pathfinderIdle) && (now - lastRepathTime) > 1200) {
            logger?.info('[navigation] ReturnToBase path obstructed or idle, recalculating...', { dist });
            lastRepathTime = now;
            lastProgressTime = now;
            if (currentPos) lastPos = { ...currentPos };
            activeGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2.0);
            bot.pathfinder?.setGoal(activeGoal, false);
          }
        },

        cancel() {
          logger?.info('[navigation] ReturnToBase cancelled');
          activeGoal = null;
          targetPos = null;
          bot.setControlState?.('jump', false);
          bot.pathfinder?.setGoal(null);
          doorManager.reset();
        },
      };
    };
  }

  return {
    normalFollow: followAdapter(THRESHOLDS.followExit, THRESHOLDS.followExit),
    catchUpFollow: followAdapter(THRESHOLDS.catchUpExit, THRESHOLDS.catchUpExit),
    pickupItem: pickupItemAdapter(),
    retreat: retreatAdapter(),
    comeOnce: comeOnceAdapter(callbacks?.onComeArrived),
    returnToBase: returnToBaseAdapter(callbacks?.onReturnArrived),
  };
}
