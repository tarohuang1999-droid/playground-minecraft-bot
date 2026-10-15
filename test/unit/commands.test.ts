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

  // 5. Unknown '!' command returns unknown type with raw name
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
