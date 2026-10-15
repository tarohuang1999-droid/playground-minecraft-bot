import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachCompanion } from '../../src/bot.ts';
import { createPerception } from '../../src/perception.ts';

test('spawn perception: autonomous bed discovery and base change refresh', () => {
  let simulatedTime = 1000;
  const fakeBot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    players: {},
    entities: {},
    inventory: { emptySlotCount: () => 36, items: () => [], slots: [] },
    blocks: {
      'bed1': { name: 'red_bed', position: { x: 5, y: 64, z: 5 } },
      'bed2': { name: 'blue_bed', position: { x: 100, y: 64, z: 100 } },
    },
  };

  const perception = createPerception(fakeBot as any, 'dakaz', { now: () => simulatedTime });
  
  // 1. Initially without base, finds closest bed within 24 blocks of bot
  const w1 = perception.sample();
  assert.deepStrictEqual(w1.nearbyBed, { x: 5, y: 64, z: 5 });
  assert.strictEqual(w1.spawnPoint, null);

  // 2. Spawn point is set -> no longer searches for bed
  perception.setSpawnPoint({ x: 5, y: 64, z: 5 });
  const w2 = perception.sample();
  assert.deepStrictEqual(w2.spawnPoint, { x: 5, y: 64, z: 5 });
  assert.strictEqual(w2.nearbyBed, null);

  // 3. Base updates near bed2 -> bedNeedsRefresh is true, finds bed around new base
  perception.setBase({ x: 95, y: 64, z: 95 });
  const w3 = perception.sample();
  assert.strictEqual(w3.bedNeedsRefresh, true);
  assert.deepStrictEqual(w3.nearbyBed, { x: 100, y: 64, z: 100 });

  // 4. Cooldown prevents continuous search on failure
  perception.setBedCooldown(60000);
  const w4 = perception.sample();
  assert.strictEqual(w4.nearbyBed, null);

  // 5. Base updates clears cooldown immediately
  perception.setBase({ x: 96, y: 64, z: 96 });
  const w5 = perception.sample();
  assert.deepStrictEqual(w5.nearbyBed, { x: 100, y: 64, z: 100 });
});

test('spawn integration: bot automatically sets spawn point at nearby bed, reports in chat, and re-triggers on base update', async () => {
  let simulatedTime = 1000;
  class SpawnTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<number, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    blocks: Record<string, any> = {
      'bed1': { name: 'white_bed', position: { x: 10, y: 64, z: 10 } },
    };
    activatedBlocks: any[] = [];
    sent: string[] = [];
    pathfinder = {
      setGoal: () => {},
      isMoving: () => false,
    };
    blockAt = (pos: any) => {
      const key = Object.keys(this.blocks).find(k => {
        const b = this.blocks[k];
        return Math.floor(b.position.x) === Math.floor(pos.x) &&
               Math.floor(b.position.y) === Math.floor(pos.y) &&
               Math.floor(b.position.z) === Math.floor(pos.z);
      });
      return key ? this.blocks[key] : null;
    };
    activateBlock = async (block: any) => { this.activatedBlocks.push(block); };
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new SpawnTestBot();
  const ownerEntity = { id: 2, position: { x: 0, y: 64, z: 0 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  // 1. Initial idle tick -> Bot detects nearbyBed and starts SetSpawn (Priority 15)
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /SetSpawn/);
  assert.match(companion.snapshot().runtime.lockedResources.HAND ?? '', /SetSpawn/);

  // 2. NormalFollow (Priority 20) preempts SetSpawn (15) if master moves away
  simulatedTime += 2000;
  bot.emit('chat', 'dakaz', '!follow');
  ownerEntity.position = { x: 15, y: 64, z: 0 };
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /NormalFollow/);

  // 3. Bot returns to stay/idle near bed
  simulatedTime += 2000;
  bot.emit('chat', 'dakaz', '!stop');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  bot.entity.position = { x: 9.5, y: 64, z: 10.0 }; // within 2.5 reach of bed
  simulatedTime += 2000;
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Spawn point successfully set!
  assert.deepStrictEqual(companion.snapshot().world.spawnPoint, { x: 10, y: 64, z: 10 });
  assert.ok(bot.sent.some(m => m.includes('Spawn point set to (10.0, 64.0, 10.0)')));
  assert.strictEqual(bot.activatedBlocks.length, 1);

  companion.dispose();
});

test('spawn integration: 30s timeout triggers 60s failure cooldown without deadlock', () => {
  let simulatedTime = 1000;
  class TimeoutSpawnBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<number, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    blocks: Record<string, any> = {
      'bedUnreachable': { name: 'red_bed', position: { x: 12, y: 64, z: 12 } }, // hypot(12, 12) = 16.97 <= 24
    };
    pathfinder = {
      setGoal: () => {},
      isMoving: () => false,
    };
    blockAt = () => null;
    chat() {}
  }

  const bot = new TimeoutSpawnBot();
  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  // Start SetSpawn
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /SetSpawn/);

  // Time passes past 30 seconds
  const originalNow = Date.now;
  const startRealTime = Date.now();
  try {
    Date.now = () => startRealTime + 31000;
    simulatedTime += 31000;
    bot.emit('physicsTick');
    bot.emit('physicsTick');
    bot.emit('physicsTick');
    bot.emit('physicsTick');

    // Action failed due to timeout, locks released
    assert.strictEqual(companion.snapshot().runtime.lockedResources.MOVE, null);
    assert.strictEqual(companion.snapshot().runtime.lockedResources.HAND, null);
  } finally {
    Date.now = originalNow;
  }

  companion.dispose();
});
