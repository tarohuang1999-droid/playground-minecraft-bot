import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot, type Bot } from 'mineflayer';
import { startBot } from '../../src/bot.ts';

// Explicit opt-in: connect to a locally running, offline-mode Paper server.
test('Paper: owner chat switches FOLLOW/STAY and Stage 2 remains Idle', { timeout: 45_000 }, async t => {
  const host = process.env.BOT_HOST ?? '127.0.0.1';
  const port = process.env.BOT_PORT ?? '25565';
  const { bot, companion } = startBot({ BOT_HOST: host, BOT_PORT: port, BOT_OWNER: 'Stage2Owner', BOT_USERNAME: 'Stage2Bot' });
  const owner = createBot({ host, port: Number(port), username: 'Stage2Owner', auth: 'offline' });
  owner.on('error', error => console.error('[test owner]', error.message));
  t.after(() => { companion.dispose(); bot.quit(); owner.quit(); });
  function spawned(client: Bot): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Spawn timed out')), 20_000);
      const onSpawn = () => finish();
      const onError = (error: Error) => finish(error);
      function finish(error?: Error) {
        clearTimeout(timer); client.removeListener('spawn', onSpawn); client.removeListener('error', onError);
        if (error) reject(error); else resolve();
      }
      client.once('spawn', onSpawn); client.once('error', onError);
    });
  }
  await Promise.all([spawned(bot), spawned(owner)]);
  async function until(check: () => boolean) {
    const deadline = performance.now() + 8000;
    while (!check()) {
      if (performance.now() >= deadline) throw new Error('Timed out waiting for expected bot state');
      await delay(25);
    }
  }
  const hasIdle = () => Object.values(companion.snapshot().runtime.activeRuns).some(run => run.actionType === 'Idle');
  await until(() => hasIdle() && companion.snapshot().world.master.entityId !== null);
  owner.chat('follow');
  await until(() => companion.snapshot().intent.mode === 'FOLLOW');
  assert.ok(hasIdle());
  assert.equal(companion.snapshot().runtime.lockedResources.MOVE, null);
  await delay(1100);
  owner.chat('stop');
  await until(() => companion.snapshot().intent.mode === 'STAY');
  assert.ok(hasIdle());
  let status = '';
  owner.on('chat', (username, message) => { if (username === 'Stage2Bot' && message.includes('HP=')) status = message; });
  await delay(1100);
  owner.chat('status');
  await until(() => status.includes('Intent=STAY') && status.includes('Idle'));
});
