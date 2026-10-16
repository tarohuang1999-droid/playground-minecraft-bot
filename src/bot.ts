import fs from 'node:fs';
import { createBot, type BotEvents } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { createBlackboard } from './blackboard.ts';
import { createRunner } from './bt/runner.ts';
import { createCompanionTree } from './bt/companion-tree.ts';
import { createArbiter } from './execution/arbiter.ts';
import { createExecutor } from './execution/executor.ts';
import type { AdapterRegistry } from './execution/types.ts';
import { createChat } from './actions/chat.ts';
import { createPerception, isHostileMob, type PerceptionSource } from './perception.ts';
import { parseCommand } from './commands.ts';
import { createNavigation, setupMovements } from './actions/navigation.ts';
import { createInventoryAdapters } from './actions/inventory.ts';
import { createCombatAdapter } from './actions/combat.ts';
import { createLogger, type Logger } from './logger.ts';
import { DEFAULT_STATE_FILE } from './state-storage.ts';

export interface CompanionPort extends PerceptionSource {
  username?: string;
  on<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  removeListener<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  chat(message: string): void;
}

export function attachCompanion(
  bot: CompanionPort,
  owner: string,
  options: {
    adapters?: AdapterRegistry;
    now?: () => number;
    logger?: Logger;
    storagePath?: string;
  } = {}
) {
  const logger = options.logger;
  const board = createBlackboard(owner);
  const perception = createPerception(bot, owner, {
    now: options.now,
    storagePath: options.storagePath,
  });
  const chat = createChat(message => bot.chat(message));
  const navigation = createNavigation(bot as any, logger, {
    onComeArrived: () => {
      logger?.info('[navigation] ComeOnce arrived at target position, switching intent to STAY');
      runner.enqueue({ type: 'intent', mode: 'STAY' });
      chat.enqueue('Arrived at your location.');
      runner.requestUrgentTick();
    },
    onReturnArrived: () => {
      logger?.info('[navigation] ReturnToBase arrived at base, switching intent to STAY');
      runner.enqueue({ type: 'intent', mode: 'STAY' });
      chat.enqueue('Arrived at base.');
      runner.requestUrgentTick();
    },
    onSpawnSet: pos => {
      perception.setSpawnPoint(pos);
      const msg = `Spawn point set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
      logger?.info(`[spawn] ${msg}`);
      chat.enqueue(msg);
      sample();
      runner.requestUrgentTick();
    },
    onSpawnFailed: () => {
      logger?.warn('[spawn] Bed unreachable, entering 60s cooldown');
      perception.setBedCooldown(60000);
      sample();
      runner.requestUrgentTick();
    },
  });
  const handleNavigationFailed = (reason: string, missionId: string) => {
    logger?.warn(`[navigation] navigation failed for mission "${missionId}": ${reason}`);
    runner.enqueue({ type: 'intent', mode: 'STAY' });
    chat.enqueue(reason);
    runner.requestUrgentTick();
  };
  const inventory = createInventoryAdapters(bot as any, logger);
  const combat = createCombatAdapter(bot as any, logger, {
    isThreat: targetId => {
      const entity = (bot as any).entities?.[targetId];
      if (entity && isHostileMob(entity)) return true;
      return perception.isThreat(targetId);
    },
    onAttack: targetId => {
      perception.notifyAttack(targetId);
      sample();
      runner.requestUrgentTick();
    },
  });
  const hasPathfinderOrPlugin =
    !!(bot as any).pathfinder || typeof (bot as any).loadPlugin === 'function';
  const navigationAdapters = hasPathfinderOrPlugin
    ? {
        NormalFollow: navigation.normalFollow,
        CatchUpFollow: navigation.catchUpFollow,
        PickupItem: navigation.pickupItem,
        Retreat: navigation.retreat,
        ComeOnce: navigation.comeOnce,
        ReturnToBase: navigation.returnToBase,
        SetSpawn: navigation.setSpawn,
      }
    : {};
  const inventoryAdapters = {
    RoutineEat: inventory.routineEat,
    EmergencyEat: inventory.emergencyEat,
    EquipBest: inventory.equipBest,
  };
  const executor = createExecutor(
    createArbiter(),
    {
      Idle: () => ({ start() {}, cancel() {} }),
      Chat: chat.adapter,
      Combat: combat,
      ...navigationAdapters,
      ...inventoryAdapters,
      ...options.adapters,
    },
    logger
  );
  const tree = createCompanionTree(executor.availableActions(), {
    onNavigationFailed: handleNavigationFailed,
    logger,
  });
  const runner = createRunner({
    board,
    executor,
    tree,
    ...(options.now ? { now: options.now } : {}),
    collectRequests: chat.requests,
    onStatus(snapshot) {
      const actions = Object.values(snapshot.runtime.activeRuns)
        .filter(run => run.status === 'RUNNING')
        .map(run => run.actionType);
      const baseStr = snapshot.world.base
        ? `(${snapshot.world.base.x.toFixed(1)},${snapshot.world.base.y.toFixed(1)},${snapshot.world.base.z.toFixed(1)})`
        : 'None';
      const spawnStr = snapshot.world.spawnPoint
        ? `(${snapshot.world.spawnPoint.x.toFixed(1)},${snapshot.world.spawnPoint.y.toFixed(1)},${snapshot.world.spawnPoint.z.toFixed(1)})`
        : 'None';
      const weapon =
        snapshot.world.inventory.bestWeapon?.name ?? (bot as any).heldItem?.name ?? 'None';
      const digStr = snapshot.intent.canDig ? 'on' : 'off';
      const bridgeStr = snapshot.intent.allowBridge ? 'on' : 'off';
      const msg = `Intent=${snapshot.intent.mode} HP=${snapshot.world.self.health}/20 Food=${snapshot.world.self.food}/20 Action=${actions.join(',') || 'Idle'} Base=${baseStr} Spawn=${spawnStr} Weapon=${weapon} FreeSlots=${snapshot.world.inventory.freeSlots} Dig=${digStr} Bridge=${bridgeStr}`;
      logger?.info('[status] ' + msg);
      chat.enqueue(msg);
    },
  });
  let active = false;
  let disposed = false;
  const recentArmSwings = new Map<number, number>();

  function sample() {
    const runtime = executor.runtime();
    runner.enqueue({ type: 'world', world: perception.sample(runtime.cooldowns) });
  }
  function reset() {
    active = false;
    logger?.info('[lifecycle] bot reset/pause');
    recentArmSwings.clear();
    perception.clearDynamicThreats();
    runner.pause();
    chat.reset();
  }
  function spawn() {
    if (active) reset();
    setupMovements(bot as any, logger);
    active = true;
    logger?.info('[lifecycle] bot spawned & active');
    runner.resume();
    sample();
  }
  function respawn() {
    if (active) reset();
  }
  function physicsTick() {
    if (active) {
      sample();
      runner.physicsTick();
    }
  }
  function health() {
    if (active) {
      sample();
      runner.requestUrgentTick();
    }
  }
  function entitySwingArm(entity: any) {
    if (entity?.id != null) {
      recentArmSwings.set(entity.id, Date.now());
    }
  }
  function entityHurt(entity: any, source?: any) {
    if (active && (entity === (bot as any).entity || entity?.id === (bot as any).entity?.id)) {
      logger?.info('[combat] bot took damage, requesting urgent tick');

      let attacker = source;
      if (!attacker && (bot as any).entities) {
        const selfPos = (bot as any).entity?.position;
        const candidates = Object.values((bot as any).entities as Record<string, any>).filter(
          (e: any) => {
            if (!e?.position || e.id === (bot as any).entity?.id) return false;
            const isPlayer = e.type === 'player' || !!e.username;
            if (!isPlayer) return false;
            const dist = selfPos
              ? Math.hypot(
                  e.position.x - selfPos.x,
                  e.position.y - selfPos.y,
                  e.position.z - selfPos.z
                )
              : Infinity;
            return dist <= 4.5;
          }
        );
        candidates.sort((a: any, b: any) => {
          const swingA = recentArmSwings.get(a.id) ?? 0;
          const swingB = recentArmSwings.get(b.id) ?? 0;
          return swingB - swingA;
        });
        attacker = candidates[0];
      }

      if (attacker) {
        const isPlayer = attacker.type === 'player' || !!attacker.username;
        if (isPlayer) {
          const attackerName = (attacker.username ?? attacker.name ?? '').trim().toLowerCase();
          const isOwner = !!owner && attackerName === owner.trim().toLowerCase();
          if (isOwner) {
            logger?.info(
              '[combat] owner attacked bot: unfollowing (intent -> STAY) and counter-attacking once (3s threat)'
            );
            runner.enqueue({ type: 'intent', mode: 'STAY' });
            chat.enqueue('Intent=STAY');
            perception.recordAttacker(attacker, { durationMs: 3000, maxHits: 1, isOwner: true });
          } else {
            logger?.info(
              `[combat] non-owner player "${attacker.username ?? attacker.id}" attacked bot: counter-attacking for 30s`
            );
            perception.recordAttacker(attacker, { durationMs: 30000, isOwner: false });
          }
        }
      }

      sample();
      runner.requestUrgentTick();
    }
  }
  function command(username: string, message: string) {
    const selfName = (bot.username ?? (bot.entity as any)?.username ?? '').trim().toLowerCase();
    if (selfName && username.trim().toLowerCase() === selfName) return;

    logger?.info(`[chat] from=${username}: "${message}" (configured owner=${owner})`);
    if (!active) {
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
        const slots = (bot as any).inventory?.slots ?? [];
        const head = slots[5]?.name ?? 'none';
        const chest = slots[6]?.name ?? 'none';
        const legs = slots[7]?.name ?? 'none';
        const feet = slots[8]?.name ?? 'none';
        const hand =
          (bot as any).heldItem?.name ??
          slots[((bot as any).quickBarSlot ?? 0) + 36]?.name ??
          'none';
        const offhand = slots[45]?.name ?? 'none';
        const msg = `[Equipment] Head: ${head} | Chest: ${chest} | Legs: ${legs} | Feet: ${feet} | Hand: ${hand} | OffHand: ${offhand}`;
        logger?.info(`[item] ${msg}`);
        chat.enqueue(msg);
      } else {
        const items =
          typeof (bot as any).inventory?.items === 'function' ? (bot as any).inventory.items() : [];
        const counts = new Map<string, number>();
        for (const item of items) {
          if (!item?.name) continue;
          counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
        }
        const freeSlots =
          typeof (bot as any).inventory?.emptySlotCount === 'function'
            ? (bot as any).inventory.emptySlotCount()
            : 0;
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
  bot.on('spawn', spawn);
  bot.on('respawn', respawn);
  bot.on('death', reset);
  bot.on('end', reset);
  bot.on('physicsTick', physicsTick);
  bot.on('health', health);
  bot.on('entitySwingArm' as any, entitySwingArm as any);
  bot.on('entityHurt' as any, entityHurt as any);
  bot.on('chat', command);
  bot.on('whisper', command);
  return {
    snapshot: runner.snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      bot.removeListener('spawn', spawn);
      bot.removeListener('respawn', respawn);
      bot.removeListener('death', reset);
      bot.removeListener('end', reset);
      bot.removeListener('physicsTick', physicsTick);
      bot.removeListener('health', health);
      bot.removeListener('entitySwingArm' as any, entitySwingArm as any);
      bot.removeListener('entityHurt' as any, entityHurt as any);
      bot.removeListener('chat', command);
      bot.removeListener('whisper', command);
    },
  };
}

function loadEnvDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (fs.existsSync('.env')) {
    try {
      const content = fs.readFileSync('.env', 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (key && !env[key]) {
            env[key] = val;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return env;
}

export function startBot(rawEnv: NodeJS.ProcessEnv = process.env) {
  const env = loadEnvDefaults({ ...rawEnv });
  const owner = env.BOT_OWNER || '';
  // if (!owner || !/^[A-Za-z0-9_]{1,16}$/.test(owner)) throw new Error('Set BOT_OWNER to your Minecraft username (1–16 letters, digits or underscores)');
  const port = Number(env.BOT_PORT ?? '25565');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('BOT_PORT must be between 1 and 65535');
  const botName = env.BOT_USERNAME ?? 'CompanionBot';
  const logger = createLogger(botName);
  logger.info(
    `Starting CompanionBot for owner="${owner}" on ${env.BOT_HOST ?? '127.0.0.1'}:${port}`
  );
  logger.info(`File logging active at: ${logger.logFilePath}`);
  const bot = createBot({
    host: env.BOT_HOST ?? '127.0.0.1',
    port,
    username: botName,
    auth: 'offline',
  });
  bot.loadPlugin(pathfinder);
  const companion = attachCompanion(bot, owner, { logger, storagePath: DEFAULT_STATE_FILE });
  bot.on('spawn', () =>
    logger.info(`[companion] spawned; owner=${owner}; Stage 3 (follow active)`)
  );
  bot.on('death', () => logger.warn('[companion] died!'));
  bot.on('respawn', () => logger.info('[companion] respawned'));
  bot.on('error', error => logger.error('[companion] error: ' + error.message));
  bot.on('kicked', reason => logger.error('[companion] kicked: ' + String(reason)));
  bot.once('end', () => {
    logger.info('[companion] connection ended');
    companion.dispose();
  });
  return { bot, companion, logger };
}

if (typeof require !== 'undefined' && require.main === module) {
  startBot();
}
