import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseCommand } from '../../src/commands.ts';
import { attachCompanion } from '../../src/bot.ts';

test('commands parser: ignores plain text and non-owner, parses ! commands', () => {
  // 1. Plain text without '!' is ignored
  assert.strictEqual(parseCommand('dakaz', 'dakaz', 'follow'), null);
  assert.strictEqual(parseCommand('dakaz', 'dakaz', 'hello bot'), null);
  assert.strictEqual(parseCommand('dakaz', 'dakaz', 'stop'), null);

  // 2. Non-owner sending '!' command is ignored
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!follow'), null);
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!status'), null);

  // 3. Valid commands with '!'
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!follow'), { type: 'intent', mode: 'FOLLOW' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!unfollow'), { type: 'intent', mode: 'STAY' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!stop'), { type: 'intent', mode: 'STAY' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!status'), { type: 'status' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!state'), { type: 'status' });

  // 4. Case and whitespace insensitivity
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !FoLLoW  '), { type: 'intent', mode: 'FOLLOW' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!UNFOLLOW'), { type: 'intent', mode: 'STAY' });

  // 5. !base command
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!base'), { type: 'set_base' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !BASE  '), { type: 'set_base' });

  // 6. !come command
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!come'), { type: 'come' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !COME  '), { type: 'come' });

  // 7. Unknown '!' command returns unknown type with raw name
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!foo'), { type: 'unknown', raw: 'foo' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dance_now'), { type: 'unknown', raw: 'dance_now' });
});

test('commands integration: unknown !command sends "command unknown" to chat', () => {
  class ChatTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new ChatTestBot();
  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Normal conversation without '!' -> no response
  bot.emit('chat', 'dakaz', 'hello there');
  bot.emit('physicsTick');
  assert.strictEqual(bot.sent.length, 0);

  // Unknown command starting with '!' -> response "command unknown"
  bot.emit('chat', 'dakaz', '!jump');
  bot.emit('physicsTick');
  assert.ok(bot.sent.includes('command unknown'));

  companion.dispose();
});

test('commands integration: !base sets base coordinate and confirms in chat', () => {
  class BaseTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 10, y: 64, z: 10 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new BaseTestBot();
  const ownerEntity = { id: 2, position: { x: 125.4, y: 70.0, z: -45.6 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Master sends !base
  bot.emit('chat', 'dakaz', '!base');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Verify chat confirmation
  assert.ok(bot.sent.some(msg => msg.includes('Base set to (125.4, 70.0, -45.6)')));

  // Verify snapshot has base coordinate
  const snap = companion.snapshot();
  assert.deepStrictEqual(snap.world.base, { x: 125.4, y: 70.0, z: -45.6 });

  companion.dispose();
});

test('commands integration: !state and !status output comprehensive status telemetry to chat', () => {
  class StateTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 19;
    food = 18;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 28, items: () => [], slots: [] };
    heldItem: any = { name: 'iron_sword' };
    sent: string[] = [];
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new StateTestBot();
  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Master sends !state
  bot.emit('chat', 'dakaz', '!state');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Verify status telemetry message was broadcast
  const statusMsg = bot.sent.find(m => m.includes('HP=19/20') && m.includes('Food=18/20'));
  assert.ok(statusMsg, 'Expected status message in chat, got: ' + JSON.stringify(bot.sent));
  assert.ok(statusMsg.includes('Intent=IDLE'));
  assert.ok(statusMsg.includes('Base=None'));
  assert.ok(statusMsg.includes('Spawn=None'));
  assert.ok(statusMsg.includes('Weapon=iron_sword'));
  assert.ok(statusMsg.includes('FreeSlots=28'));

  companion.dispose();
});

test('commands integration: !come navigates to static coordinates and transitions to STAY upon arrival', () => {
  class ComeTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    goalsSet: any[] = [];
    pathfinder = {
      setGoal: (goal: any) => { this.goalsSet.push(goal); },
      isMoving: () => false,
    };
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new ComeTestBot();
  const ownerEntity = { id: 2, position: { x: 10, y: 64, z: 10 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  let simulatedTime = 1000;
  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  // Master sends !come
  bot.emit('chat', 'dakaz', '!come');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // 1. Bot intent changes to COME, confirms in chat
  assert.ok(bot.sent.includes('Intent=COME'));
  const snap1 = companion.snapshot();
  assert.strictEqual(snap1.intent.mode, 'COME');
  assert.deepStrictEqual(snap1.intent.targetPosition, { x: 10, y: 64, z: 10 });
  assert.match(snap1.runtime.lockedResources.MOVE ?? '', /ComeOnce/);

  // 2. Master moves far away (e.g. to (100, 64, 100))
  ownerEntity.position = { x: 100, y: 64, z: 100 };
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Bot's target position remains static (10, 64, 10), does NOT follow master
  const snap2 = companion.snapshot();
  assert.deepStrictEqual(snap2.intent.targetPosition, { x: 10, y: 64, z: 10 });

  // 3. Bot arrives near the static target (distance <= 2.0 blocks)
  simulatedTime += 2000; // Advance time beyond chat rate limit (1000ms)
  bot.entity.position = { x: 10.5, y: 64, z: 10.2 };
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // 4. Bot stops, intent switches to STAY, and notifies arrival in chat
  const snap3 = companion.snapshot();
  assert.strictEqual(snap3.intent.mode, 'STAY');
  assert.ok(bot.sent.includes('Arrived at your location.'));

  // 5. Test override: !come can be overridden mid-flight by !stop
  bot.emit('chat', 'dakaz', '!come');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().intent.mode, 'COME');

  bot.emit('chat', 'dakaz', '!stop');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.strictEqual(companion.snapshot().intent.mode, 'STAY');

  companion.dispose();
});

test('commands integration: !come without visible master replies "Cannot see you!"', () => {
  class BlindTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    chat(message: string) { this.sent.push(message); }
  }

  const bot = new BlindTestBot();
  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Master sends !come but master is offline / not in render distance
  bot.emit('chat', 'dakaz', '!come');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.ok(bot.sent.includes('Cannot see you!'));
  assert.notStrictEqual(companion.snapshot().intent.mode, 'COME');

  companion.dispose();
});


