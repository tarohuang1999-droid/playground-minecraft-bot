const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;

const ADMIN_USERS = ['YourUsername']; // 改成你的遊戲名稱

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25565,
  username: 'SmartWorker'
  // 移除寫死的無效 version，讓 mineflayer 自動與伺服器交握判定版本
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

let currentTask = 'idle';

bot.once('spawn', () => {
  const defaultMove = new Movements(bot);
  bot.pathfinder.setMovements(defaultMove);
  console.log('Bot 載入成功，已在伺服器就位！');
});

// 重置與停止當前所有行為
function stopAll() {
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
  currentTask = 'idle';
}

bot.on('chat', async (username, message) => {
  if (username === bot.username || !ADMIN_USERS.includes(username)) return;

  const targetPlayer = bot.players[username]?.entity;

  // 指令：stop
  if (message === 'stop') {
    stopAll();
    bot.chat('已強制終止當前任務');
    return;
  }

  // 避免指令競爭
  if (currentTask !== 'idle') {
    bot.chat(`正在執行 [${currentTask}]，請先輸入 stop`);
    return;
  }

  // 指令：come
  if (message === 'come') {
    if (!targetPlayer) {
      bot.chat('找不到你的實體 (可能超出視距)');
      return;
    }

    currentTask = 'moving';
    bot.chat('前往你的位置...');

    try {
      const goal = new goals.GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 1);
      // 使用 goto 取代 setGoal + once('goal_reached')，確保 Promise 能夠正確等待或捕獲中斷
      await bot.pathfinder.goto(goal);
      bot.chat('已抵達！');
    } catch (err) {
      // 被 stopAll() 中斷時會拋出異常，屬正常中斷流程
      if (err.name !== 'PathfinderError') {
        console.error(err);
      }
    } finally {
      if (currentTask === 'moving') currentTask = 'idle';
    }
    return;
  }

  // 指令：follow
  if (message === 'follow') {
    if (!targetPlayer) {
      bot.chat('找不到你的實體');
      return;
    }
    currentTask = 'following';
    bot.chat('啟動跟隨');
    bot.pathfinder.setGoal(new goals.GoalFollow(targetPlayer, 2), true);
    return;
  }

  // 指令：wood
  if (message === 'wood') {
    if (bot.inventory.emptySlotCount() === 0) {
      bot.chat('背包空間不足！');
      return;
    }

    // 移除不存在的 safeToBreak，改為直接搜尋符合名稱的 log 方塊
    const block = bot.findBlock({
      matching: (blk) => blk.name.endsWith('_log'),
      maxDistance: 32
    });

    if (!block) {
      bot.chat('半徑 32 格內找不到原木');
      return;
    }

    currentTask = 'collecting';
    bot.chat(`鎖定目標原木: (${block.position.x}, ${block.position.y}, ${block.position.z})`);

    try {
      await bot.collectBlock.collect(block);
      bot.chat('採集完畢！');
    } catch (err) {
      bot.chat(`採集失敗: ${err.message}`);
    } finally {
      currentTask = 'idle';
    }
  }
});

// 死亡、踢出或斷線時清空狀態
bot.on('death', stopAll);
bot.on('kicked', stopAll);
bot.on('end', stopAll);