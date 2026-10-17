import type { createChat } from './actions/chat.ts';
import type { BlackboardSnapshot } from './blackboard.ts';
import type { Runner } from './bt/runner.ts';
import { parseCommand } from './commands.ts';
import { workConfig, survivalConfig } from './config/index.ts';

import type { Logger } from './logger.ts';
import { findNearbyBed, type createPerception } from './perception.ts';
import type { TaskSessionManager } from './sessions/task-session-manager.ts';

export interface CommandInventoryItem {
  name?: string | undefined;
  count?: number | undefined;
}

export interface CommandBotPort {
  username?: string | undefined;
  entity?: {
    id?: number | undefined;
    username?: string | undefined;
    position?: { x: number; y: number; z: number } | undefined;
  };
  heldItem?: { name?: string | undefined } | null | undefined;
  quickBarSlot?: number | undefined;
  inventory?: {
    slots?: Array<{ name?: string | undefined } | null | undefined> | undefined;
    items?(): CommandInventoryItem[];
    emptySlotCount?(): number;
  };
  findBlock?(options: unknown): unknown;
  activateBlock?(block: unknown): Promise<void>;
  blocks?: Record<string, unknown> | undefined;
}

export interface CommandControllerDeps {
  bot: CommandBotPort;
  owner: string;
  logger?: Logger | undefined;
  now: () => number;
  perception: ReturnType<typeof createPerception>;
  sessionManager: TaskSessionManager;
  chat: ReturnType<typeof createChat>;
  runner: Runner;
  sample: () => void;
  isActive: () => boolean;
}

export function createCommandController(deps: CommandControllerDeps) {
  const { bot, owner, logger, now, perception, sessionManager, chat, runner, sample, isActive } =
    deps;

  function handleStatus(snapshot: BlackboardSnapshot) {
    const actions = Object.values(snapshot.runtime.activeRuns)
      .filter(run => run.status === 'RUNNING')
      .map(run => run.actionType);
    const baseStr = snapshot.world.base
      ? `(${snapshot.world.base.x.toFixed(1)},${snapshot.world.base.y.toFixed(1)},${snapshot.world.base.z.toFixed(1)})`
      : 'None';
    const spawnStr = snapshot.world.spawnPoint
      ? `(${snapshot.world.spawnPoint.x.toFixed(1)},${snapshot.world.spawnPoint.y.toFixed(1)},${snapshot.world.spawnPoint.z.toFixed(1)})`
      : 'None';
    const weapon = snapshot.world.inventory.bestWeapon?.name ?? bot.heldItem?.name ?? 'None';
    const digStr = snapshot.intent.canDig ? 'on' : 'off';
    const bridgeStr = snapshot.intent.allowBridge ? 'on' : 'off';
    const msg = `Intent=${snapshot.intent.mode} HP=${snapshot.world.self.health}/20 Food=${snapshot.world.self.food}/20 Action=${actions.join(',') || 'Idle'} Base=${baseStr} Spawn=${spawnStr} Weapon=${weapon} FreeSlots=${snapshot.world.inventory.freeSlots} Dig=${digStr} Bridge=${bridgeStr}`;
    logger?.info('[status] ' + msg);
    chat.enqueue(msg);
  }

  function handleCommand(username: string, message: string) {
    const selfName = (bot.username ?? bot.entity?.username ?? '').trim().toLowerCase();
    if (selfName && username.trim().toLowerCase() === selfName) return;

    logger?.info(`[chat] from=${username}: "${message}" (configured owner=${owner})`);
    if (!isActive()) {
      logger?.warn('[chat] ignored: bot is currently dead or inactive');
      return;
    }
    const event = parseCommand(owner, username, message);
    if (!event) {
      if (username.trim().toLowerCase() !== owner.trim().toLowerCase()) {
        logger?.warn(`[chat] rejected: sender "${username}" does not match owner "${owner}"`);
      }
      return;
    }

    if (event.type === 'unknown') {
      logger?.warn(`[chat] unknown command "!${event.raw}" from ${username}`);
      chat.enqueue('command unknown');
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'set_base') {
      const currentWorld = perception.sample();
      const basePos = currentWorld.master.position ?? currentWorld.self.position;
      perception.setBase(basePos);
      sample();
      const msg = `Base set to (${basePos.x.toFixed(1)}, ${basePos.y.toFixed(1)}, ${basePos.z.toFixed(1)})`;
      logger?.info(`[base] ${msg}`);
      chat.enqueue(msg);
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'set_bed') {
      const currentWorld = perception.sample();
      const center = bot.entity?.position ?? currentWorld.self.position;
      const bed = findNearbyBed(bot, survivalConfig.bed.searchRadius, center);
      if (!bed || !bed.position) {
        logger?.info(
          `[chat] !setbed: no bed found within ${survivalConfig.bed.searchRadius} blocks`
        );
        chat.enqueue('沒看到');
        runner.requestUrgentTick();
        return;
      }
      const bedPos = {
        x: Math.round(bed.position.x * 10) / 10,
        y: Math.round(bed.position.y * 10) / 10,
        z: Math.round(bed.position.z * 10) / 10,
      };
      perception.setSpawnPoint(bedPos);
      sample();
      const msg = `Spawn point set to (${bedPos.x.toFixed(1)}, ${bedPos.y.toFixed(1)}, ${bedPos.z.toFixed(1)})`;
      logger?.info(`[spawn] ${msg}`);
      chat.enqueue(msg);
      if (typeof bot.activateBlock === 'function') {
        const dist = Math.hypot(bedPos.x - center.x, bedPos.y - center.y, bedPos.z - center.z);
        if (dist <= survivalConfig.bed.reachDistance) {
          bot.activateBlock(bed).catch(err => {
            logger?.warn('[spawn] activateBlock error: ' + err);
          });
        }
      }

      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'sleep') {
      const currentWorld = perception.sample();
      const center = bot.entity?.position ?? currentWorld.self.position;
      let spawnPoint = currentWorld.spawnPoint;

      if (!spawnPoint) {
        const bed = findNearbyBed(bot, survivalConfig.bed.searchRadius, center);
        if (!bed || !bed.position) {
          logger?.info(
            `[chat] !sleep: no bed found within ${survivalConfig.bed.searchRadius} blocks`
          );
          chat.enqueue('沒看到');
          runner.requestUrgentTick();
          return;
        }
        const bedPos = {
          x: Math.round(bed.position.x * 10) / 10,
          y: Math.round(bed.position.y * 10) / 10,
          z: Math.round(bed.position.z * 10) / 10,
        };
        perception.setSpawnPoint(bedPos);
        sample();
        const msg = `Spawn point set to (${bedPos.x.toFixed(1)}, ${bedPos.y.toFixed(1)}, ${bedPos.z.toFixed(1)})`;
        logger?.info(`[spawn] ${msg}`);
        chat.enqueue(msg);
        if (typeof bot.activateBlock === 'function') {
          const dist = Math.hypot(bedPos.x - center.x, bedPos.y - center.y, bedPos.z - center.z);
          if (dist <= survivalConfig.bed.reachDistance) {
            bot.activateBlock(bed).catch(err => {
              logger?.warn('[spawn] activateBlock error: ' + err);
            });
          }
        }
        spawnPoint = bedPos;
      }

      logger?.info(
        `[chat] accepted command: sleep at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)})`
      );
      runner.enqueue({ type: 'intent', mode: 'SLEEP' });
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'come') {
      const currentWorld = perception.sample();
      const masterPos = currentWorld.master.position;
      if (!masterPos) {
        logger?.warn('[chat] !come rejected: master position is unknown or not visible');
        chat.enqueue('Cannot see you!');
        runner.requestUrgentTick();
        return;
      }
      logger?.info(
        `[chat] accepted command: come to (${masterPos.x.toFixed(1)}, ${masterPos.y.toFixed(1)}, ${masterPos.z.toFixed(1)})`
      );
      runner.enqueue({ type: 'intent', mode: 'COME', targetPosition: masterPos });
      chat.enqueue('Intent=COME');
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'intent' && event.mode === 'RETURN') {
      const currentWorld = perception.sample();
      const dest = currentWorld.base ?? currentWorld.spawnPoint;
      if (!dest) {
        logger?.warn('[chat] !return rejected: no base or spawn point set');
        chat.enqueue('No base or spawn point set!');
        runner.requestUrgentTick();
        return;
      }
    }

    if (event.type === 'command_usage') {
      logger?.warn(`[chat] command usage error: ${event.message}`);
      chat.enqueue(event.message);
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'set_dig') {
      logger?.info(`[chat] accepted command: dig ${event.enabled ? 'on' : 'off'}`);
      runner.enqueue(event);
      chat.enqueue(`Dig=${event.enabled ? 'on' : 'off'}`);
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'set_bridge') {
      logger?.info(`[chat] accepted command: bridge ${event.enabled ? 'on' : 'off'}`);
      runner.enqueue(event);
      chat.enqueue(`Bridge=${event.enabled ? 'on' : 'off'}`);
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'item') {
      if (event.target === 'equipment') {
        const slots = bot.inventory?.slots ?? [];
        const head = slots[5]?.name ?? 'none';
        const chest = slots[6]?.name ?? 'none';
        const legs = slots[7]?.name ?? 'none';
        const feet = slots[8]?.name ?? 'none';
        const hand = bot.heldItem?.name ?? slots[(bot.quickBarSlot ?? 0) + 36]?.name ?? 'none';
        const offhand = slots[45]?.name ?? 'none';
        const msg = `[Equipment] Head: ${head} | Chest: ${chest} | Legs: ${legs} | Feet: ${feet} | Hand: ${hand} | OffHand: ${offhand}`;
        logger?.info(`[item] ${msg}`);
        chat.enqueue(msg);
      } else {
        const items = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : [];
        const counts = new Map<string, number>();
        for (const item of items) {
          if (!item?.name) continue;
          counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
        }
        const freeSlots =
          typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 0;
        const itemsStr = Array.from(counts.entries())
          .map(([n, c]) => `${n} x${c}`)
          .join(', ');
        const msg = `[Inventory] (${freeSlots} slots free) ${itemsStr || 'Empty'}`;
        logger?.info(`[item] ${msg}`);
        chat.enqueue(msg);
      }
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'farm') {
      const currentWorld = perception.sample();
      const availableSeeds = currentWorld.inventory.plantableSeeds ?? [];
      const matchingSeed = event.crop
        ? availableSeeds.find(s => s.cropType === event.crop)
        : availableSeeds[0];

      if (!matchingSeed) {
        logger?.warn('[chat] !farm rejected: no plantable seeds in inventory');
        chat.enqueue('No plantable seeds in inventory!');
        runner.requestUrgentTick();
        return;
      }

      sessionManager.startFarming();
      perception.clearFarmlandCooldowns();
      const selfPos = currentWorld.self.position;
      const rallyPoint = { x: selfPos.x, y: selfPos.y, z: selfPos.z };
      logger?.info(
        `[chat] accepted command: farm (targetCrop=${matchingSeed.cropType}, rally=(${rallyPoint.x.toFixed(1)}, ${rallyPoint.y.toFixed(1)}, ${rallyPoint.z.toFixed(1)}))`
      );
      runner.enqueue({
        type: 'intent',
        mode: 'FARM',
        workArea: {
          rallyPoint,
          maxRadius: workConfig.farmWorkRadius,
          startedAt: now(),
          maxDurationMs: workConfig.farmMaxDurationMs,
          cropType: event.crop ?? matchingSeed.cropType,
        },
      });
      chat.enqueue('Intent=FARM');
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'hunt') {
      const currentWorld = perception.sample();
      const selfPos = currentWorld.self.position;
      const rallyPoint = { x: selfPos.x, y: selfPos.y, z: selfPos.z };

      sessionManager.startHunting();
      perception.clearAnimalCooldowns();

      logger?.info(
        `[chat] accepted command: hunt (target=${event.target ?? 'all'}, rally=(${rallyPoint.x.toFixed(1)}, ${rallyPoint.y.toFixed(1)}, ${rallyPoint.z.toFixed(1)}))`
      );
      runner.enqueue({
        type: 'intent',
        mode: 'HUNT',
        workArea: {
          rallyPoint,
          maxRadius: workConfig.huntWorkRadius,
          startedAt: now(),
          maxDurationMs: workConfig.huntMaxDurationMs,
          targetAnimal: event.target,
        },
      });
      chat.enqueue('Intent=HUNT');
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'intent') {
      logger?.info(`[chat] accepted command: intent (${event.mode})`);
      runner.enqueue({ type: 'intent', mode: event.mode });
      chat.enqueue(`Intent=${event.mode}`);
      runner.requestUrgentTick();
      return;
    }

    if (event.type === 'status') {
      logger?.info('[chat] accepted command: status');
      runner.enqueue({ type: 'status' });
      runner.requestUrgentTick();
      return;
    }
  }

  return {
    handleCommand,
    handleStatus,
  };
}
