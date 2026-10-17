import fs from 'node:fs';
import { createBot, type BotEvents } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { createChat } from './actions/chat.ts';
import { createActionAdapters, type ActionBotPort } from './actions/index.ts';
import { setupMovements, type NavigationBot } from './actions/navigation.ts';
import { createBlackboard } from './blackboard.ts';
import { createCompanionTree } from './bt/companion-tree.ts';
import { createRunner, type Runner } from './bt/runner.ts';
import { createCommandController } from './command-controller.ts';
import { createArbiter } from './execution/arbiter.ts';
import { createExecutor } from './execution/executor.ts';
import type { AdapterRegistry } from './execution/types.ts';
import { createLogger, type Logger } from './logger.ts';
import { createPerception } from './perception.ts';
import { createTaskSessionManager } from './sessions/task-session-manager.ts';
import { DEFAULT_STATE_FILE } from './state-storage.ts';

export interface EventEntity {
  id?: number | undefined;
  name?: string | undefined;
  username?: string | undefined;
  type?: string | undefined;
  position?: { x: number; y: number; z: number } | undefined;
}

export interface CompanionPort extends ActionBotPort {
  username?: string | undefined;
  on<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  on(event: string, listener: (...args: EventEntity[]) => void): unknown;
  removeListener<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  removeListener(event: string, listener: (...args: EventEntity[]) => void): unknown;
  chat(message: string): void;
}

export type CompanionOptions = {
  adapters?: AdapterRegistry;
  now?: () => number;
  logger?: Logger;
  storagePath?: string;
};

export function attachCompanion(bot: CompanionPort, owner: string, options: CompanionOptions = {}) {
  const { logger, now = () => Date.now() } = options;
  const board = createBlackboard(owner);
  const perception = createPerception(bot, owner, { now, storagePath: options.storagePath });
  const chat = createChat(message => bot.chat(message));
  const sessionManager = createTaskSessionManager();
  let runner!: Runner;
  const sample = () =>
    runner.enqueue({ type: 'world', world: perception.sample(executor.runtime().cooldowns) });
  const actionAdapters = createActionAdapters(bot, {
    logger,
    now,
    perception,
    sessionManager,
    chat,
    enqueueEvent: event => runner.enqueue(event),
    requestUrgentTick: () => runner.requestUrgentTick(),
    sample,
    customAdapters: options.adapters,
  });
  const executor = createExecutor(createArbiter(), actionAdapters.adapters, logger);
  const tree = createCompanionTree(executor.availableActions(), actionAdapters.treeOptions);
  let active = false;
  let disposed = false;
  const recentArmSwings = new Map<number, number>();
  runner = createRunner({
    board,
    executor,
    tree,
    now,
    collectRequests: chat.requests,
    onStatus: snapshot => commandController.handleStatus(snapshot),
  });
  const commandController = createCommandController({
    bot,
    owner,
    logger,
    now,
    perception,
    sessionManager,
    chat,
    runner,
    sample,
    isActive: () => active,
  });

  function reset() {
    active = false;
    logger?.info('[lifecycle] bot reset/pause');
    recentArmSwings.clear();
    perception.clearDynamicThreats();
    perception.clearAnimalCooldowns();
    sessionManager.reset();
    runner.pause();
    chat.reset();
  }
  function spawn() {
    if (active) reset();
    setupMovements(bot as unknown as NavigationBot, logger);
    active = true;
    logger?.info('[lifecycle] bot spawned & active');
    runner.resume();
    sample();
  }
  function entityDead(entity?: EventEntity) {
    if (entity?.id == null) return;
    perception.markAnimalCooldown(entity.id, 60_000);
    if (sessionManager.recordAnimalDead(entity.id)) {
      logger?.info(
        `[hunting] entityDead kill id=${entity.id} (${sessionManager.getHuntedCount()})`
      );
    }
  }
  function entityHurt(entity?: EventEntity, source?: EventEntity) {
    if (!active || (entity !== bot.entity && entity?.id !== bot.entity?.id)) return;
    logger?.info('[combat] bot took damage, requesting urgent tick');
    const nowTime = now();
    let attacker = source;
    if (!attacker && bot.entities) {
      const p = bot.entity?.position;
      const candidates = Object.values(bot.entities).filter(e => {
        const t = e?.id != null ? recentArmSwings.get(e.id) : undefined;
        if (!e?.position || e.id === bot.entity?.id || (e.type !== 'player' && !e.username))
          return false;
        const d = p ? Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) : 99;
        return t !== undefined && nowTime - t <= 1000 && d <= 4.5;
      });
      candidates.sort(
        (a, b) => (recentArmSwings.get(b.id) ?? 0) - (recentArmSwings.get(a.id) ?? 0)
      );
      attacker = candidates[0];
    }
    if (attacker?.id != null && (attacker.type === 'player' || !!attacker.username)) {
      const name = (attacker.username ?? attacker.name ?? '').trim().toLowerCase();
      const isOwner = !!owner && name === owner.trim().toLowerCase();
      const target = attacker as { id: number; username?: string; name?: string };
      if (isOwner) {
        logger?.info('[combat] owner attacked bot: unfollowing (intent -> STAY) and 1-hit counter');
        runner.enqueue({ type: 'intent', mode: 'STAY' });
        chat.enqueue('Intent=STAY');
        perception.recordAttacker(target, { durationMs: 3000, maxHits: 1, isOwner: true });
      } else {
        logger?.info(`[combat] non-owner "${attacker.username ?? attacker.id}" attacked: 30s`);
        perception.recordAttacker(target, { durationMs: 30000, isOwner: false });
      }
    }
    sample();
    runner.requestUrgentTick();
  }

  const listeners: ReadonlyArray<readonly [string, (...args: EventEntity[]) => void]> = [
    ['spawn', spawn],
    ['respawn', () => active && reset()],
    ['death', reset],
    ['end', reset],
    ['physicsTick', () => active && (sample(), runner.physicsTick())],
    ['health', () => active && (sample(), runner.requestUrgentTick())],
    ['entitySwingArm', e => e?.id != null && recentArmSwings.set(e.id, now())],
    ['entityDead', entityDead],
    ['entityGone', e => e?.id != null && perception.markAnimalCooldown(e.id, 30_000)],
    ['entityHurt', entityHurt],
  ];
  for (const [ev, fn] of listeners) bot.on(ev, fn);
  bot.on('chat', commandController.handleCommand);
  bot.on('whisper', commandController.handleCommand);

  return {
    snapshot: runner.snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      actionAdapters.dispose();
      for (const [ev, fn] of listeners) bot.removeListener(ev, fn);
      bot.removeListener('chat', commandController.handleCommand);
      bot.removeListener('whisper', commandController.handleCommand);
    },
  };
}

function loadEnvDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!fs.existsSync('.env')) return env;
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const [k, ...rest] = line.trim().split('=');
    if (k && !k.startsWith('#') && rest.length > 0 && !env[k.trim()])
      env[k.trim()] = rest.join('=').trim();
  }
  return env;
}

export function startBot(rawEnv: NodeJS.ProcessEnv = process.env) {
  const env = loadEnvDefaults({ ...rawEnv });
  const owner = env.BOT_OWNER || '';
  const port = Number(env.BOT_PORT ?? '25565');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('BOT_PORT must be between 1 and 65535');
  const username = env.BOT_USERNAME ?? 'CompanionBot';
  const host = env.BOT_HOST ?? '127.0.0.1';
  const logger = createLogger(username);
  logger.info(`Starting ${username} for owner="${owner}" on ${host}:${port}`);
  const bot = createBot({ host, port, username, auth: 'offline' });
  bot.loadPlugin(pathfinder);
  const companion = attachCompanion(bot, owner, { logger, storagePath: DEFAULT_STATE_FILE });
  bot.on('spawn', () => logger.info(`[companion] spawned; owner=${owner}; Stage 3`));
  bot.on('death', () => logger.warn('[companion] died!'));
  bot.on('respawn', () => logger.info('[companion] respawned'));
  bot.on('error', error => logger.error('[companion] error: ' + error.message));
  bot.on('kicked', reason => logger.error('[companion] kicked: ' + String(reason)));
  bot.once('end', () => companion.dispose());
  return { bot, companion, logger };
}

if (typeof require !== 'undefined' && require.main === module) startBot();
