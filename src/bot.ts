import { createBot, type BotEvents } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { createBlackboard } from './blackboard.ts';
import { createRunner } from './bt/runner.ts';
import { createCompanionTree } from './bt/companion-tree.ts';
import { createArbiter } from './execution/arbiter.ts';
import { createExecutor } from './execution/executor.ts';
import type { AdapterRegistry } from './execution/types.ts';
import { createChat } from './actions/chat.ts';
import { createPerception, type PerceptionSource } from './perception.ts';
import { parseCommand } from './commands.ts';

export interface CompanionPort extends PerceptionSource {
  on<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  removeListener<K extends keyof BotEvents>(event: K, listener: BotEvents[K]): unknown;
  chat(message: string): void;
}

export function attachCompanion(bot: CompanionPort, owner: string, options: { adapters?: AdapterRegistry; now?: () => number } = {}) {
  const board = createBlackboard(owner);
  const perception = createPerception(bot, owner);
  const chat = createChat(message => bot.chat(message));
  const executor = createExecutor(createArbiter(), {
    Idle: () => ({ start() {}, cancel() {} }), Chat: chat.adapter, ...options.adapters,
  });
  const tree = createCompanionTree(executor.availableActions());
  const runner = createRunner({ board, executor, tree, ...(options.now ? { now: options.now } : {}),
    collectRequests: chat.requests,
    onStatus(snapshot) {
      const actions = Object.values(snapshot.runtime.activeRuns).filter(run => run.status === 'RUNNING').map(run => run.actionType);
      chat.enqueue(`Intent=${snapshot.intent.mode}; HP=${snapshot.world.self.health}; Food=${snapshot.world.self.food}; Actions=${actions.join(',') || 'Idle'}`);
    },
  });
  let active = false;
  let disposed = false;
  function sample() { runner.enqueue({ type: 'world', world: perception.sample() }); }
  function reset() { active = false; runner.pause(); chat.reset(); }
  function spawn() {
    if (active) reset();
    active = true; runner.resume(); sample();
  }
  function respawn() { if (active) reset(); }
  function physicsTick() { if (active) { sample(); runner.physicsTick(); } }
  function health() { if (active) { sample(); runner.requestUrgentTick(); } }
  function command(username: string, message: string) {
    if (!active) return;
    const event = parseCommand(owner, username, message);
    if (!event) return;
    runner.enqueue(event);
    if (event.type === 'intent') chat.enqueue(`Intent=${event.mode}`);
    runner.requestUrgentTick();
  }
  bot.on('spawn', spawn);
  bot.on('respawn', respawn);
  bot.on('death', reset);
  bot.on('end', reset);
  bot.on('physicsTick', physicsTick);
  bot.on('health', health);
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
      bot.removeListener('chat', command);
      bot.removeListener('whisper', command);
    },
  };
}

export function startBot(env: NodeJS.ProcessEnv = process.env) {
  const owner = env.BOT_OWNER;
  if (!owner || !/^[A-Za-z0-9_]{1,16}$/.test(owner)) throw new Error('Set BOT_OWNER to your Minecraft username (1–16 letters, digits or underscores)');
  const port = Number(env.BOT_PORT ?? '25565');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BOT_PORT must be between 1 and 65535');
  const bot = createBot({ host: env.BOT_HOST ?? '127.0.0.1', port, username: env.BOT_USERNAME ?? 'CompanionBot', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  const companion = attachCompanion(bot, owner);
  bot.on('spawn', () => console.log(`[companion] spawned; owner=${owner}; Stage 2 (body actions pending)`));
  bot.on('error', error => console.error('[companion]', error.message));
  bot.on('kicked', reason => console.error('[companion] kicked:', reason));
  bot.once('end', () => companion.dispose());
  return { bot, companion };
}

if (require.main === module) startBot();
