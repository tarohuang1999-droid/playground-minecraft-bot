# 給 agent 的 Coding Guidelines

> 適用新NPC；行為規格以 [npc-architecture.md](npc-architecture.md) 為準。
> 這份rules是開發規範。不要另外建立遊戲用的rules.js。

## 1. 禁止提前抽象

- 使用JavaScript/CommonJS、2 spaces、單引號、分號，沿用專案風格；重要參數以JSDoc說明即可。
- 先用普通物件與函式。Controller需要保存當前run，才使用`createController()` closure。不建立BaseBehavior、service/repository、DI container、全域singleton。
- 依架構的`bot.js / commands.js / controller.js / behaviors / skills`寫程式。不為未來模型、情緒、Manager建立空資料夾。
- 優先用具名小函式整理同一檔案；只有職責已經獨立且複雜，或多處確實共用時才拆檔。不要只因「以後可能會用」增加一層。
- 不用class繼承行為，不動態掃描檔案註冊；不要求為五個行為建立通用框架。
- 不新增runtime依賴，不改舊companion/base腳本，不修改node_modules。沒有實測證據不加跳躍等導航hack。

## 2. 各部分的界線

| 放在哪裡 | 寫什麼 | 不寫什麼 |
| --- | --- | --- |
| bot.js | 連線、observe、事件、state存檔、明確註冊behaviors | combat/chop等流程 |
| commands.js | 解析指令、主人權限、更新master/task | 移動／攻擊 |
| controller.js | 比較priority、管理唯一run、取消與重試 | 「有多餓該吃飯」等遊戲條件 |
| behaviors/*.js | priority條件、run流程、目標選擇helper | 自己啟動背景timer控制bot、呼叫其他behavior |
| skills/*.js | 具體Mineflayer操作、目標重驗、取消 | 讀主人task、決定哪個behavior優先 |

非同步工作一定有擁有者並追蹤Promise。不要`void skill()`後直接換行為；finally清理完成前不能把控制權交出去。

## 3. Behavior template

例如`src/behaviors/chop.js`。priority只讀view；run取得最新view，呼叫skill。Skill結果為`{ status: 'done' }`或`{ status: 'blocked' }`，未知錯誤照常拋出。

```js
const { mineLog } = require('../skills/gather');

function priority(view) {
  if (view.task !== 'chop') return 0;
  if (view.self.inventoryFull || !view.nearestLog) return 0;
  return 40;
}

async function run({ bot, getView }, signal) {
  signal.throwIfAborted();
  const view = getView();
  if (priority(view) === 0) return { status: 'blocked' };

  const result = await mineLog(bot, [...view.nearestLog.pos], signal);
  signal.throwIfAborted();
  return result;
}

module.exports = { name: 'chop', priority, run };
```

Continuous behavior如follow/combat，在run中定期讀getView；不保留第一份view用到底。迴圈等待要支援signal，不用忙碌迴圈。舊目標消失時結束，讓下一輪重新選擇。

在bot.js明確加入行為；順序同分時才有影響：

```js
const behaviors = [
  require('./behaviors/flee'),
  require('./behaviors/combat'),
  require('./behaviors/follow'),
  require('./behaviors/chop'),
  require('./behaviors/idle')
];
```

新增功能只改真正相關的behavior、skill、commands及這份清單。不要為新增一個檔案先做registry abstraction。

## 4. Commands template

`parseCommand`只接受定向語法與白名單，回傳命令字串或null；`unfollow`在解析時轉成stop。以下是同檔的權限與狀態更新函式，無I/O，可直接測試。

```js
const COMMANDS = new Set(['claim', 'unclaim', 'follow', 'chop', 'stop']);

function applyCommand(state, username, command) {
  if (!COMMANDS.has(command)) return { accepted: false, changed: false };
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username)) {
    return { accepted: false, changed: false };
  }

  if (command === 'claim') {
    if (state.master === username) return { accepted: true, changed: false };
    if (state.master !== null) return { accepted: false, changed: false };
    state.master = username;
    state.task = 'none';
    return { accepted: true, changed: true };
  }

  if (state.master !== username) return { accepted: false, changed: false };
  const task = command === 'follow' || command === 'chop' ? command : 'none';
  const changed = state.task !== task || command === 'unclaim';
  state.task = task;
  if (command === 'unclaim') state.master = null;
  return { accepted: true, changed };
}

module.exports = { applyCommand };
```

完整commands.js的exports再加入parseCommand。bot.js接線時：accepted且（changed或命令為stop）就呼叫controller.cancel；只有changed才存檔；master改變另清敵人清單。拒絕不動作。這樣stop即使task已經none也能停止當前run。

## 5. Skill 的寫法

Skill以普通函式匯出，直接呼叫Mineflayer與已安裝插件提供的現成方法（`Vec3`、`bot.pathfinder.goto` / `setGoal`、`bot.collectBlock.collect` / `cancelTask`、`bot.pvp.attack` / `stop`），不要自己重寫底層尋路、選工具、挖掘或攻擊冷卻邏輯。

透過 `skills/async.js` 的 `withAbort(fn, onAbort, signal)` 串接非同步中斷：

```text
開始前 signal.throwIfAborted()
註冊 abort listener：觸發時呼叫插件停止方法（cancelTask / pvp.stop / setGoal(null)）
await 插件方法完成
signal.throwIfAborted()
finally 移除 abort listener
```

取消錯誤維持signal語義；預期遊戲阻礙（如 `NoPath`、`Timeout`、`NoItem`）回傳 `{ status: 'blocked' }`；未知錯誤照常拋出。不要空catch，不把失敗轉成成功。

## 6. Test template 與驗證

使用`node:test`、`node:assert/strict`。純函式直接測；操作用最小fake bot；取消測試用可手動resolve的Promise，確認舊run結束前新run沒開始，不靠長時間sleep。

以下可放`test/commands.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCommand } = require('../src/commands');

test('別人不能搶主人或改跟隨任務', () => {
  const state = { master: 'dakaz', task: 'follow' };
  assert.equal(applyCommand(state, 'other', 'claim').accepted, false);
  assert.equal(applyCommand(state, 'other', 'stop').accepted, false);
  assert.deepEqual(state, { master: 'dakaz', task: 'follow' });
});

test('stop清掉任務，但保留主人', () => {
  const state = { master: 'dakaz', task: 'follow' };
  assert.deepEqual(applyCommand(state, 'dakaz', 'stop'), {
    accepted: true, changed: true
  });
  assert.deepEqual(state, { master: 'dakaz', task: 'none' });
});
```

實作時保留舊scripts，將test改`node --test`以找到巢狀測試，新增`bot:npc`為`node src/bot.js`。現在這些scripts尚未修改：

```bash
npm test
# 新入口完成後才可執行：
npm run bot:npc -- bots/worker1.json
```

不用追求100% coverage，不新增build/lint系統來完成這次功能。必測主人權限、優先級、取消競態、敵人過期、失敗重試和存檔；導航與戰鬥另做Paper驗收，不用mock宣稱遊戲已成功。
