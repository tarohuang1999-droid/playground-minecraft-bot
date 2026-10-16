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
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!follow'), {
    type: 'intent',
    mode: 'FOLLOW',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!unfollow'), {
    type: 'intent',
    mode: 'STAY',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!stop'), { type: 'intent', mode: 'STAY' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!status'), { type: 'status' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!state'), { type: 'status' });

  // 4. Case and whitespace insensitivity
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !FoLLoW  '), {
    type: 'intent',
    mode: 'FOLLOW',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!UNFOLLOW'), {
    type: 'intent',
    mode: 'STAY',
  });

  // 5. !base command
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!base'), { type: 'set_base' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !BASE  '), { type: 'set_base' });

  // 6. !come command
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!come'), { type: 'come' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !COME  '), { type: 'come' });

  // 7. !return command
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!return'), {
    type: 'intent',
    mode: 'RETURN',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !RETURN  '), {
    type: 'intent',
    mode: 'RETURN',
  });

  // 8. !dig and !bridge commands
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dig on'), {
    type: 'set_dig',
    enabled: true,
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dig off'), {
    type: 'set_dig',
    enabled: false,
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!bridge on'), {
    type: 'set_bridge',
    enabled: true,
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!bridge off'), {
    type: 'set_bridge',
    enabled: false,
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dig maybe'), {
    type: 'command_usage',
    message: 'Usage: !dig on|off',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dig'), {
    type: 'command_usage',
    message: 'Usage: !dig on|off',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!bridge fast'), {
    type: 'command_usage',
    message: 'Usage: !bridge on|off',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!bridge'), {
    type: 'command_usage',
    message: 'Usage: !bridge on|off',
  });
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!dig on'), null);
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!bridge on'), null);

  // 9. !item command (equipment and inventory)
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item equipment'), {
    type: 'item',
    target: 'equipment',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item equip'), {
    type: 'item',
    target: 'equipment',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !ITEM  EQUIPMENT  '), {
    type: 'item',
    target: 'equipment',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item inventory'), {
    type: 'item',
    target: 'inventory',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item inv'), {
    type: 'item',
    target: 'inventory',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '  !ITEM  INV  '), {
    type: 'item',
    target: 'inventory',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item'), {
    type: 'command_usage',
    message: 'Usage: !item equipment | !item inventory',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item foo'), {
    type: 'command_usage',
    message: 'Usage: !item equipment | !item inventory',
  });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!item equipment extra'), {
    type: 'command_usage',
    message: 'Usage: !item equipment | !item inventory',
  });
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!item equipment'), null);
  assert.strictEqual(parseCommand('dakaz', 'stranger', '!item inventory'), null);

  // 10. Unknown '!' command returns unknown type with raw name
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!foo'), { type: 'unknown', raw: 'foo' });
  assert.deepStrictEqual(parseCommand('dakaz', 'dakaz', '!dance_now'), {
    type: 'unknown',
    raw: 'dance_now',
  });
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
    chat(message: string) {
      this.sent.push(message);
    }
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
    findBlock = (options: any) => {
      const point = (options.point || this.entity.position).floored();
      assert.strictEqual(typeof point.x, 'number');
      return null;
    };
    chat(message: string) {
      this.sent.push(message);
    }
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
    chat(message: string) {
      this.sent.push(message);
    }
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
      setGoal: (goal: any) => {
        this.goalsSet.push(goal);
      },
      isMoving: () => false,
    };
    chat(message: string) {
      this.sent.push(message);
    }
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
    chat(message: string) {
      this.sent.push(message);
    }
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

test('commands integration: !return without base or spawn point replies "No base or spawn point set!"', () => {
  class NoBaseReturnBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new NoBaseReturnBot();
  const companion = attachCompanion(bot as any, 'dakaz');
  bot.emit('spawn');

  // Master sends !return before any base or bed is set
  bot.emit('chat', 'dakaz', '!return');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.ok(bot.sent.includes('No base or spawn point set!'));
  assert.notStrictEqual(companion.snapshot().intent.mode, 'RETURN');

  companion.dispose();
});

test('commands integration: !return navigates to base, resumes after combat preemption, and arrives at base', async () => {
  let simulatedTime = 1000;
  class ReturnTestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<number, any> = {};
    inventory = {
      emptySlotCount: () => 36,
      items: () => [{ type: 100, name: 'iron_sword', id: 100 }],
      slots: [],
    };
    heldItem: any = { name: 'iron_sword' };
    sent: string[] = [];
    goalsSet: any[] = [];
    attacks: any[] = [];
    pathfinder = {
      setGoal: (goal: any) => {
        this.goalsSet.push(goal);
      },
      isMoving: () => false,
    };
    attack = (target: any) => {
      this.attacks.push(target);
    };
    equip = async () => {};
    lookAt = async () => {};
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new ReturnTestBot();
  const ownerEntity = { id: 2, position: { x: 50, y: 64, z: 50 }, username: 'dakaz' };
  bot.entities[2] = ownerEntity;
  bot.players.dakaz = { entity: ownerEntity, username: 'dakaz' };

  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  // 1. Set base at (50, 64, 50)
  bot.emit('chat', 'dakaz', '!base');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.deepStrictEqual(companion.snapshot().world.base, { x: 50, y: 64, z: 50 });

  // 2. Master issues !return
  simulatedTime += 2000;
  bot.emit('chat', 'dakaz', '!return');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.strictEqual(companion.snapshot().intent.mode, 'RETURN');
  assert.ok(bot.sent.includes('Intent=RETURN'));
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /ReturnToBase/);

  // 3. Combat preempts ReturnToBase: A hostile zombie spawns nearby (dist = 5 blocks)
  const zombie = {
    id: 99,
    name: 'zombie',
    position: { x: 5, y: 64, z: 0 },
    isValid: true,
    health: 20,
  };
  bot.entities[99] = zombie;
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Combat (80) preempts ReturnToBase (25)
  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /Combat/);
  assert.match(companion.snapshot().runtime.lockedResources.HAND ?? '', /Combat/);
  // Intent remains RETURN (persistent mission)
  assert.strictEqual(companion.snapshot().intent.mode, 'RETURN');

  // 4. Zombie dies -> Combat ends, bot automatically resumes ReturnToBase
  delete bot.entities[99];
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  assert.match(companion.snapshot().runtime.lockedResources.MOVE ?? '', /ReturnToBase/);
  assert.strictEqual(companion.snapshot().intent.mode, 'RETURN');

  // 5. Bot arrives at base (distance <= 2.0 blocks)
  simulatedTime += 2000;
  bot.entity.position = { x: 50.5, y: 64, z: 49.8 };
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  // Intent switches to STAY upon arrival at base, notifies in chat
  assert.strictEqual(companion.snapshot().intent.mode, 'STAY');
  assert.ok(bot.sent.includes('Arrived at base.'));

  companion.dispose();
});

test('commands integration: !dig and !bridge toggle switches independently, output usage on invalid args, and status shows states', () => {
  let simulatedTime = 1000;
  class TestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    inventory = { emptySlotCount: () => 36, items: () => [], slots: [] };
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new TestBot();
  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  function tick() {
    bot.emit('physicsTick');
    bot.emit('physicsTick');
  }

  // 1. Initial status shows Dig=off Bridge=off
  simulatedTime += 1000;
  bot.emit('chat', 'dakaz', '!status');
  tick();
  assert.ok(bot.sent.some(m => m.includes('Dig=off Bridge=off')));

  // 2. Stranger cannot toggle switches
  simulatedTime += 1000;
  bot.emit('chat', 'stranger', '!dig on');
  tick();
  assert.strictEqual(companion.snapshot().intent.canDig, false);

  // 3. Invalid arguments output usage without changing state
  simulatedTime += 1000;
  bot.emit('chat', 'dakaz', '!dig maybe');
  tick();
  assert.ok(bot.sent.includes('Usage: !dig on|off'));
  assert.strictEqual(companion.snapshot().intent.canDig, false);

  simulatedTime += 1000;
  bot.emit('chat', 'dakaz', '!bridge fast');
  tick();
  assert.ok(bot.sent.includes('Usage: !bridge on|off'));
  assert.strictEqual(companion.snapshot().intent.allowBridge, false);

  // 4. Toggle dig on
  simulatedTime += 1000;
  bot.emit('chat', 'dakaz', '!dig on');
  tick();
  assert.ok(bot.sent.includes('Dig=on'));
  assert.strictEqual(companion.snapshot().intent.canDig, true);
  assert.strictEqual(companion.snapshot().intent.allowBridge, false);

  // 5. Toggle bridge on independently
  simulatedTime += 1000;
  bot.emit('chat', 'dakaz', '!bridge on');
  tick();
  assert.ok(bot.sent.includes('Bridge=on'));
  assert.strictEqual(companion.snapshot().intent.canDig, true);
  assert.strictEqual(companion.snapshot().intent.allowBridge, true);

  // 6. Status now reports Dig=on Bridge=on
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!status');
  tick();
  assert.ok(bot.sent.some(m => m.includes('Dig=on Bridge=on')));

  // 7. Death/reset resets switches to off
  bot.emit('death');
  assert.strictEqual(companion.snapshot().intent.canDig, false);
  assert.strictEqual(companion.snapshot().intent.allowBridge, false);

  companion.dispose();
});

test('commands integration: !item equipment and !item inventory report gear and aggregated items', () => {
  let simulatedTime = 1000;
  class TestBot extends EventEmitter {
    entity = { id: 1, position: { x: 0, y: 64, z: 0 } };
    health = 20;
    food = 20;
    players: Record<string, any> = {};
    entities: Record<string, any> = {};
    heldItem: any = { name: 'iron_sword' };
    quickBarSlot = 0;
    inventory: any = {
      slots: [
        null, // 0
        null, // 1
        null, // 2
        null, // 3
        null, // 4
        { name: 'iron_helmet' }, // 5 head
        { name: 'iron_chestplate' }, // 6 chest
        null, // 7 legs
        { name: 'leather_boots' }, // 8 feet
      ],
      emptySlotCount: () => 24,
      items: () => [
        { name: 'wheat_seeds', count: 32 },
        { name: 'bread', count: 16 },
        { name: 'wheat_seeds', count: 10 },
      ],
    };
    sent: string[] = [];
    chat(message: string) {
      this.sent.push(message);
    }
  }

  const bot = new TestBot();
  const companion = attachCompanion(bot as any, 'dakaz', { now: () => simulatedTime });
  bot.emit('spawn');

  function tick() {
    bot.emit('physicsTick');
    bot.emit('physicsTick');
  }

  // 1. !item equipment (and alias !item equip)
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item equipment');
  tick();
  assert.deepStrictEqual(bot.sent, [
    '[Equipment] Head: iron_helmet | Chest: iron_chestplate | Legs: none | Feet: leather_boots | Hand: iron_sword | OffHand: none',
  ]);

  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item equip');
  tick();
  assert.deepStrictEqual(bot.sent, [
    '[Equipment] Head: iron_helmet | Chest: iron_chestplate | Legs: none | Feet: leather_boots | Hand: iron_sword | OffHand: none',
  ]);

  // 2. !item inventory (aggregates counts, shows free slots)
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item inventory');
  tick();
  assert.deepStrictEqual(bot.sent, ['[Inventory] (24 slots free) wheat_seeds x42, bread x16']);

  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item inv');
  tick();
  assert.deepStrictEqual(bot.sent, ['[Inventory] (24 slots free) wheat_seeds x42, bread x16']);

  // 3. Empty inventory output
  bot.inventory.items = () => [];
  bot.inventory.emptySlotCount = () => 36;
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item inventory');
  tick();
  assert.deepStrictEqual(bot.sent, ['[Inventory] (36 slots free) Empty']);

  // 4. Invalid subcommand returns usage error
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'dakaz', '!item something');
  tick();
  assert.deepStrictEqual(bot.sent, ['Usage: !item equipment | !item inventory']);

  // 5. Non-owner cannot query items
  simulatedTime += 1000;
  bot.sent = [];
  bot.emit('chat', 'stranger', '!item equipment');
  tick();
  assert.deepStrictEqual(bot.sent, []);

  companion.dispose();
});
