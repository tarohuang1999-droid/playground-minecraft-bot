const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25565,
  username: 'SmartWorker',
  version: '26.1.2'
});

// 1. 載入外掛
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

bot.once('spawn', () => {
  // 初始化物理移動邏輯（包含允許搭橋、開門、破壞阻擋方塊）
  const defaultMove = new Movements(bot);
  bot.pathfinder.setMovements(defaultMove);
  console.log('Bot 技能載入完畢，已就緒！');
});

// 2. 透過遊戲聊天室指揮 Bot
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;

  const targetPlayer = bot.players[username]?.entity;

  // 指令：come -> 自動尋路走到你面前
  if (message === 'come') {
    if (!targetPlayer) {
      bot.chat('我看不到你在哪裡！');
      return;
    }
    bot.chat('來了！');
    const { GoalNear } = goals;
    bot.pathfinder.setGoal(new GoalNear(targetPlayer.position.x, targetPlayer.position.y, targetPlayer.position.z, 1));
  }

  // 指令：follow -> 持續跟隨你移動
  if (message === 'follow') {
    if (!targetPlayer) return;
    bot.chat('跟隨模式啟動');
    const { GoalFollow } = goals;
    bot.pathfinder.setGoal(new GoalFollow(targetPlayer, 2), true);
  }

  // 指令：stop -> 停止所有當前動作
  if (message === 'stop') {
    bot.chat('已停止動作');
    bot.pathfinder.setGoal(null);
  }

  // 指令：wood -> 自動尋找附近的原木並採集
  if (message === 'wood') {
    bot.chat('尋找附近的原木中...');
    const block = bot.findBlock({
      matching: (blk) => blk.name.includes('log'),
      maxDistance: 32
    });

    if (!block) {
      bot.chat('32 格內找不到木頭！');
      return;
    }

    try {
      await bot.collectBlock.collect(block);
      bot.chat('原木採集完成！');
    } catch (err) {
      bot.chat(`採集失敗: ${err.message}`);
    }
  }
});