# [Superseded] JavaScript 開發規範與 AI Agent 編碼鐵律 (rule-javascript-coding.md)

> **狀態：已廢棄（Superseded by [rule-typescript-coding.md](rule-typescript-coding.md)）**。本專案已全面遷移至 TypeScript，此檔案僅作早期歷史紀錄保留，AI Agent 請一律遵守 `rule-typescript-coding.md`。

- **適用對象**：早期 CommonJS 歷史腳本（`base_bot*.js`）。
- **參考架構**：系統設計以 `docs/sys-design/system-design-v1.1.md` 與 `docs/implement-plan.md` 為準。

---

## 1. 核心設計原則 (Anti-Overengineering & Pragmatic Design)

* **KISS 原則**：優先選擇滿足需求的最簡解法。嚴禁無實質效益的抽象封裝與過度設計模式。
* **YAGNI 原則**：嚴禁「為未來可能的需求」預先實作未明確要求的功能或建立空資料夾/空框架。
* **禁止提前抽象**：
  * 使用 JavaScript / CommonJS、2 空格縮排、單引號、分號。
  * 優先使用普通物件、工廠函式與 Closure（如 `createArbiter()`、`createExecutor()`），不使用 Class 繼承行為，不引入 DI Container、Service/Repository 模式或全域 Singleton。
  * 優先在同一檔案內以具名小函式組織邏輯；只有當職責完全獨立且複雜，或確實被多處共用時才拆檔。
  * 不為動態掃描、自動註冊行為編寫反射或掃描器，所有模組採明確匯入與組裝。
* **依賴最小化**：
  * 嚴格禁止安裝或引入未列於 `package.json` 的第三方套件。
  * 全過程嚴禁引入 `mineflayer-pvp`、`mineflayer-statemachine`、`mistreevous` 等非受控高層狀態插件。

---

## 2. AI Coding Agent 強制編碼鐵律 (Strict Coding Rules)

任何負責實作本專案的 AI Agent 必須逐條遵守以下 10 條鐵律，違反任一條視為實作失敗：

1. **[RULE-01] 語言與模組規範**：全專案 JavaScript 部分使用純 CommonJS (`require` / `module.exports`)，檔案頂部必須加上 `'use strict';`，關鍵介面使用 JSDoc 標註型別。禁止引入 Babel 或未經核准的轉譯器。
2. **[RULE-02] 禁止在 BT 內執行副作用**：`src/bt/**` 目錄下的所有檔案**嚴禁** `require('mineflayer')` 或持有 `bot` 實例，也**嚴禁**使用 `async / await`。BT 節點只能讀取 `snapshot` 並同步回傳 `{ status, requests }`。
3. **[RULE-03] 資源請求原子性 (All-or-Nothing)**：任何 Action 不得在執行中途動態追加資源鎖（Lock Escalation），也不得在只拿到部分鎖時偷跑。所有需要的資源必須在 `ActionRequest.requiredResources` 一次宣告完畢。
4. **[RULE-04] 強制 Token 與 Generation 雙重檢查**：在 `src/actions/**` 中，任何 `await` 語句的下一行，或是任何 `setTimeout` / Event Listener 回呼的第一行，**必須**執行：
   ```js
   if (!ctx.isActive()) return; // 內部同時檢查 token === currentToken && gen === sessionGeneration
   ```
   未加此檢查的非同步程式碼一律不准提交。
5. **[RULE-05] 禁止死等懸空 Promise 釋放鎖**：`executor.js` 在取消舊動作時，呼叫 `adapter.cancel()` 後只需經過 **1 個 `physicsTick` (50ms)** 的 `stopping` 緩衝期，即強制將資源狀態設為 `free` 並交給新勝者；**嚴禁** `await oldRun.promise` 完成才移交資源鎖。
6. **[RULE-06] 尋路控制唯一入口**：禁止在全專案任何地方出現 `bot.pathfinder.goto` 或 `bot.pathfinder.stop`。更新尋路唯一允許 `bot.pathfinder.setGoal(goal, dynamic)`，停止尋路唯一允許 `bot.pathfinder.setGoal(null)`。
7. **[RULE-07] 避免尋路抖動 (No Goal Spamming)**：當 `Follow`、`Retreat` 或 `Combat` 在連續多輪 Tick 中維持同一個 `runId` 與目標時，Adapter **不得**每輪重複呼叫 `bot.pathfinder.setGoal()` 重設相同目標（動態目標交由 `setGoal(goal, true)` 內部追蹤）。
8. **[RULE-08] 傷害來源安全推斷**：處理 `entityHurt` 事件時，Mineflayer 不保證提供攻擊者 ID。自衛邏輯只針對「自身周圍 8 格內已存在的敵對生物（Hostile Mob）」觸發，**禁止**盲目將「距離最近的玩家或中立生物」當作攻擊者進行反擊。
9. **[RULE-09] 死亡與斷線強制清空**：當觸發 `bot.on('death')` 或 `bot.on('end')` 時，必須立即遞增 `sessionGeneration`，同步呼叫所有活動中 Action 的 `cancel()`，清空 `arbiter` 所有鎖與 `blackboard.runtime`，確保重生後不會延續死前的逃跑或攻擊狀態。
10. **[RULE-10] 測試先行交付順序 (Implementation Order)**：
    * **Step 1**：實作 `policy.js`、`blackboard.js`、`bt/nodes.js`、`execution/arbiter.js`、`execution/executor.js`，並通過所有不依賴 Minecraft 伺服器的單元測試（Fake Actions 驗證搶佔與懸空 Promise 隔離）。
    * **Step 2**：實作 `actions/*` 與 `perception.js`。
    * **Step 3**：組裝 `companion-tree.js` 與 `bot.js`，進行 Paper 伺服器實機驗收。

---

## 3. 架構職責與模組界線 (Architectural Boundaries)

各模組邊界必須嚴格遵守以下職責劃分：

| 模組路徑 | 職責 (該做什麼) | 限制 (嚴禁做什麼) |
| :--- | :--- | :--- |
| `src/bot.js` | 機器人連線、事件分發、生命週期監聽（`death`, `end`）、啟動主循環 | 撰寫具體戰鬥、尋路或物品使用邏輯 |
| `src/commands.js` | 解析主人聊天室指令、白名單權限校驗、更新 `blackboard.intent` | 直接操作機器人移動、跳躍或攻擊 |
| `src/blackboard.js` | 管理世界狀態快照、支援 `world/intent/runtime` 分區、發布唯讀凍結快照 (`Object.freeze`) | 撰寫遊戲決策或調度邏輯 |
| `src/policy.js` | 定義資源通道常數 (`MOVE`, `LOOK`, `HAND`, `INVENTORY`, `VOICE`)、動作優先級與遲滯閥值 | 包含執行期邏輯或 I/O 操作 |
| `src/bt/**` | 行為樹節點與子樹結構、純同步決策評估、收集當輪 `ActionRequest` | 引入 `mineflayer`、持有 `bot` 實例、使用 `async/await` 或啟動定時器 |
| `src/execution/arbiter.js` | 資源通道權限分配、穩定優先級排序、All-or-Nothing 整組原子鎖定 | 操作 Mineflayer API 或發起非同步呼叫 |
| `src/execution/executor.js` | 管理 `runId`、`token`、`sessionGeneration`、50ms 搶佔 Fencing、失敗冷卻表 | 決定誰優先獲得資源（應交由 Arbiter） |
| `src/perception.js` | 定期與事件採集周圍環境狀態（血量、食物、實體、主人），推入感知佇列 | 直接修改機器人控制狀態或觸發動作 |
| `src/actions/**` | 執行具體 Mineflayer 操作、監聽中斷信號、目標驗證、清理控制狀態 | 自行決定優先級、跨越自身所獲資源存取未鎖定通道 |

---

## 4. 實作範本與模式 (Implementation Patterns)

### 4.1 指令解析範本 (`src/commands.js`)
指令解析必須為無副作用之純函式，僅接受白名單指令與已認證的主人：

```js
'use strict';

const COMMANDS = new Set(['follow', 'unfollow', 'stop', 'status']);

function parseCommand(rawMessage) {
  if (typeof rawMessage !== 'string') return null;
  const trimmed = rawMessage.trim().toLowerCase();
  const parts = trimmed.split(/\s+/);
  const command = parts[0];
  if (!COMMANDS.has(command)) return null;
  return { command, args: parts.slice(1) };
}

function applyCommand(intent, masterUsername, sender, command) {
  if (sender !== masterUsername) {
    return { accepted: false, reason: 'unauthorized' };
  }
  if (command === 'follow') {
    intent.task = 'follow';
    return { accepted: true, changed: true };
  }
  if (command === 'stop' || command === 'unfollow') {
    intent.task = 'stop';
    return { accepted: true, changed: true };
  }
  return { accepted: true, changed: false };
}

module.exports = { parseCommand, applyCommand };
```

### 4.2 動作適配器與非同步安全範本 (`src/actions/**`)
非同步動作必須妥善處理取消信號與 `ctx.isActive()` 檢查：

```js
'use strict';

function createActionAdapter(bot) {
  return {
    async start(ctx, request) {
      if (!ctx.isActive()) return;

      // 步驟 1: 前置準備
      await bot.equip(request.params.item, 'hand');
      if (!ctx.isActive()) return; // [RULE-04] 每次 await 後必須立即檢查

      // 步驟 2: 執行主動作
      try {
        await bot.consume();
      } catch (err) {
        // 捕捉非預期異常，預期中斷交由 isActive 攔截
      }
      if (!ctx.isActive()) return;

      ctx.reportDone('SUCCESS');
    },

    cancel(ctx) {
      // 快速發出硬體/協議層級停止，不等待完成
      bot.deactivateItem();
    }
  };
}

module.exports = { createActionAdapter };
```

---

## 5. 測試規範 (Testing Guidelines)

* **測試框架**：一律使用 Node.js 原生測試模組 `node:test` 與 `node:assert/strict`。
* **純邏輯優先**：BT 節點、Arbiter 仲裁器、Commands 指令解析與 Blackboard 黑板必須達到 100% 純單元測試覆蓋，不建立假 Mineflayer 連線。
* **懸空 Promise 與搶佔模擬**：
  * 使用手動控制 resolve/reject 的 Promise 模擬長時間運行動作。
  * 驗證在 50ms（1 tick）緩衝期後新動作能否順利接管資源，且舊動作之後 resolve 不會污染新狀態。
* **實機整合驗收**：
  * 實機測試直接連接本地 PaperMC 伺服器驗收。
  * 嚴格驗證邊界遲滯（Hysteresis），避免尋路抖動與來回抽搐。
