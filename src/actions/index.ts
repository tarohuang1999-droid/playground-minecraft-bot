import type { Position } from '../blackboard.ts';
import type { RunnerEvent } from '../bt/runner.ts';
import type { WorkSubtreeOptions } from '../bt/subtrees/work.ts';
import type { AdapterRegistry } from '../execution/types.ts';
import type { Logger } from '../logger.ts';
import { isHostileMob, type createPerception, type PerceptionSource } from '../perception.ts';
import type { TaskSessionManager } from '../sessions/task-session-manager.ts';
import type { createChat } from './chat.ts';
import { createCombatAdapter, type CombatBot } from './combat.ts';
import { createFarming } from './farming.ts';
import { createHunting, type HuntingBot } from './hunting.ts';
import { createInventoryAdapters, type InventoryBot } from './inventory.ts';
import { createNavigation, type NavigationBot } from './navigation.ts';
import { createSleepAdapter, type SleepBot } from './sleep.ts';
import { createSetBedAdapter, type SetBedBot } from './bed.ts';

export interface ActionBotPort extends PerceptionSource {
  pathfinder?: NavigationBot['pathfinder'];
  loadPlugin?: ((plugin: never) => void) | undefined;
}

export interface CreateActionAdaptersDeps {
  logger?: Logger | undefined;
  now: () => number;
  perception: ReturnType<typeof createPerception>;
  sessionManager: TaskSessionManager;
  chat: ReturnType<typeof createChat>;
  enqueueEvent: (event: RunnerEvent) => void;
  requestUrgentTick: () => void;
  sample: () => void;
  customAdapters?: AdapterRegistry | undefined;
}

export function createActionAdapters(bot: ActionBotPort, deps: CreateActionAdaptersDeps) {
  const {
    logger,
    now,
    perception,
    sessionManager,
    chat,
    enqueueEvent,
    requestUrgentTick,
    sample,
    customAdapters,
  } = deps;

  const navBot = bot as unknown as NavigationBot;
  const navigation = createNavigation(navBot, logger, {
    clock: { now },
    onComeArrived: () => {
      logger?.info('[navigation] ComeOnce arrived at target position, switching intent to STAY');
      enqueueEvent({ type: 'intent', mode: 'STAY' });
      chat.enqueue('Arrived at your location.');
      requestUrgentTick();
    },
    onReturnArrived: () => {
      logger?.info('[navigation] ReturnToBase arrived at base, switching intent to STAY');
      enqueueEvent({ type: 'intent', mode: 'STAY' });
      chat.enqueue('Arrived at base.');
      requestUrgentTick();
    },
    onSpawnSet: (pos: Position) => {
      perception.setSpawnPoint(pos);
      const msg = `Spawn point set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
      logger?.info(`[spawn] ${msg}`);
      chat.enqueue(msg);
      sample();
      requestUrgentTick();
    },
    onSpawnFailed: () => {
      logger?.warn('[spawn] Bed unreachable, entering 60s cooldown');
      perception.setBedCooldown(60000);
      sample();
      requestUrgentTick();
    },
  });

  const inventory = createInventoryAdapters(bot as unknown as InventoryBot, logger);

  const combat = createCombatAdapter(bot as unknown as CombatBot, logger, {
    isThreat: targetId => {
      const entity = bot.entities?.[String(targetId)];
      if (entity && isHostileMob(entity)) return true;
      return perception.isThreat(targetId);
    },
    onAttack: targetId => {
      perception.notifyAttack(targetId);
      sample();
      requestUrgentTick();
    },
  });

  const farming = createFarming(navBot, {
    logger,
    now,
    onCropPlanted: (cropType, pos) => {
      const total = sessionManager.recordCropPlanted();
      if (pos) {
        perception.markFarmlandCooldown(pos, 30_000);
      }
      logger?.info(`[farming] Planted ${cropType} (total: ${total})`);
    },
    onFarmlandFailed: pos => {
      const { consecutiveFailures, shouldAbort } = sessionManager.recordFarmFailure();
      perception.markFarmlandCooldown(pos, 30_000);
      logger?.warn(
        `[farming] Farmland at (${pos.x}, ${pos.y}, ${pos.z}) marked as failed (consecutive: ${consecutiveFailures})`
      );
      if (shouldAbort) {
        logger?.error('[farming] 5 consecutive planting attempts failed. Aborting farm mode.');
        chat.enqueue('Farming failed: 5 consecutive planting attempts failed.');
        enqueueEvent({ type: 'intent', mode: 'IDLE' });
        requestUrgentTick();
      }
    },
  });

  const hunting = createHunting(
    bot as unknown as HuntingBot,
    {
      now,
      onAnimalAttacked: (entityId, animalName) => {
        sessionManager.recordAnimalAttacked(entityId);
        logger?.info(`[hunting] attacked ${animalName} (id=${entityId})`);
      },
      onAnimalKilled: (animalName, entityId) => {
        const { counted, totalKilled } = sessionManager.recordAnimalKilled(entityId);
        if (!counted) {
          logger?.info(
            `[hunting] animal ${entityId} already counted as killed, ignoring duplicate`
          );
          return;
        }
        perception.markAnimalCooldown(entityId, 60_000);
        logger?.info(
          `[hunting] killed ${animalName} (id=${entityId}, session total: ${totalKilled})`
        );
      },
      onAnimalEscaped: entityId => {
        perception.markAnimalCooldown(entityId, 30_000);
        logger?.info(`[hunting] animal ${entityId} escaped, put on 30s cooldown`);
      },
    },
    logger
  );

  const hasPathfinderOrPlugin = !!bot.pathfinder || typeof bot.loadPlugin === 'function';

  const navigationAdapters: AdapterRegistry = hasPathfinderOrPlugin
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

  const farmingAdapters: AdapterRegistry = hasPathfinderOrPlugin
    ? {
        FarmPlant: farming.farmPlant,
      }
    : {};

  const huntingAdapters: AdapterRegistry = hasPathfinderOrPlugin
    ? {
        HuntAnimal: hunting.huntAnimal,
      }
    : {};

  const inventoryAdapters: AdapterRegistry = {
    RoutineEat: inventory.routineEat,
    EmergencyEat: inventory.emergencyEat,
    EquipBest: inventory.equipBest,
  };

  const sleepAdapter = createSleepAdapter(bot as unknown as SleepBot, logger, {
    chat,
    onGoodMorning: () => {
      enqueueEvent({ type: 'intent', mode: 'IDLE' });
      requestUrgentTick();
    },
  });

  const setBedAdapter = createSetBedAdapter(bot as unknown as SetBedBot, logger, {
    onSpawnSet: (pos: Position) => {
      perception.setSpawnPoint(pos);
      const msg = `Spawn point set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
      logger?.info(`[spawn] ${msg}`);
      chat.enqueue(msg);
      sample();
      requestUrgentTick();
    },
    onNoBedFound: () => {
      chat.enqueue('沒看到');
      requestUrgentTick();
    },
  });

  const adapters: AdapterRegistry = {
    Idle: () => ({ start() {}, cancel() {} }),
    Chat: chat.adapter,
    Combat: combat,
    SleepAtBed: sleepAdapter,
    SetBed: setBedAdapter,
    ...navigationAdapters,
    ...farmingAdapters,
    ...huntingAdapters,
    ...inventoryAdapters,
    ...customAdapters,
  };

  const treeOptions: WorkSubtreeOptions = {
    logger,
    onNavigationFailed: (reason, missionId) => {
      logger?.warn(`[navigation] navigation failed for mission "${missionId}": ${reason}`);
      enqueueEvent({ type: 'intent', mode: 'STAY' });
      chat.enqueue(reason);
      requestUrgentTick();
    },
    getAvailableFarmland: (rallyPoint, maxRadius) =>
      perception.getAvailableFarmland(rallyPoint, maxRadius),
    onFarmingFinished: (reason, missionId) => {
      const { completed, count } = sessionManager.tryCompleteTask(missionId, reason);
      if (!completed) return;
      logger?.info(`[farming] shift finished (${reason}), total planted: ${count}`);
      enqueueEvent({ type: 'intent', mode: 'IDLE' });
      chat.enqueue(
        reason === 'TIMEOUT'
          ? `Farming shift completed (1 day limit reached). Planted ${count} crops.`
          : `Farming completed. Planted ${count} crops.`
      );
      requestUrgentTick();
    },
    getHuntableAnimal: (rallyPoint, maxRadius, targetAnimal, currentTargetId) =>
      perception.getHuntableAnimal(rallyPoint, maxRadius, targetAnimal, currentTargetId),
    onHuntingFinished: (reason, missionId) => {
      const { completed, count } = sessionManager.tryCompleteTask(missionId, reason);
      if (!completed) return;
      logger?.info(`[hunting] shift finished (${reason}), total hunted: ${count}`);
      enqueueEvent({ type: 'intent', mode: 'IDLE' });
      chat.enqueue(
        reason === 'TIMEOUT'
          ? `Hunting shift completed (1 day limit reached). Hunted ${count} animals.`
          : `Hunting completed. Hunted ${count} animals.`
      );
      requestUrgentTick();
    },
  };

  return {
    adapters,
    treeOptions,
    dispose() {
      navigation.dispose();
    },
  };
}
