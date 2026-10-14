

-
## .給 AI Coding Agent 的強制編碼鐵律 (Strict Coding Rules)

任何負責實作本專案的 AI Agent 必須逐條遵守以下 10 條鐵律，違反任一條視為實作失敗：

1. **[RULE-01] 語言與模組規範**：全專案使用純 JavaScript (Node.js CommonJS `require` / `module.exports`)，檔案頂部必須加上 `'use strict';`，關鍵介面使用 JSDoc 標註型別。禁止引入 TypeScript、Babel 或任何未列於 `package.json` 的第三方套件。
2. **[RULE-02] 禁止在 BT 內執行副作用**：`src/bt/**` 目錄下的所有檔案**嚴禁** `require('mineflayer')` 或持有 `bot` 實例，也**嚴禁**使用 `async / await`。BT 節點只能讀取 `snapshot` 並回傳 `{ status, requests }`。
3. **[RULE-03] 資源請求原子性 (All-or-Nothing)**：任何 Action 不得在執行中途動態追加資源鎖（Lock Escalation），也不得在只拿到部分鎖時偷跑。所有需要的資源必須在 `ActionRequest.requiredResources` 一次宣告完畢。
4. **[RULE-04] 強制 Token 與 Generation 雙重檢查**：在 `src/actions/**` 中，任何 `await` 語句的下一行，或是任何 `setTimeout` / Event Listener 回呼的第一行，**必須**執行：
```js
if (!ctx.isActive()) return; // 內部同時檢查 token === currentToken && gen === sessionGeneration

```


未加此檢查的非同步程式碼一律不准提交。
5. **[RULE-05] 禁止死等懸空 Promise 釋放鎖**：`executor.js` 在取消舊動作時，呼叫 `adapter.cancel()` 後只需經過 **1 個 `physicsTick` (50ms)** 的 `stopping` 緩衝期，即強制將資源狀態設為 `free` 並交給新勝者；**嚴禁** `await oldRun.promise` 完成才移交資源鎖。
6. **[RULE-06] 尋路控制唯一入口**：禁止在全專案任何地方出現 `bot.pathfinder.goto` 或 `bot.pathfinder.stop`。更新尋路唯一允許 `bot.pathfinder.setGoal(goal, dynamic)`，停止尋路唯一允許 `bot.pathfinder.setGoal(null)`。
7. **[RULE-07] 避免尋路抖動 (No Goal Spamming)**：當 `Follow`、`Retreat` 或 `Combat` 在連續多輪 Tick 中維持同一個 `runId` 與 `targetId` 時，Adapter **不得**每輪重複呼叫 `bot.pathfinder.setGoal()` 重設相同目標（動態目標交由 `setGoal(goal, true)` 內部追蹤）。
8. **[RULE-08] 傷害來源安全推斷**：處理 `entityHurt` 事件時，Mineflayer 不保證提供攻擊者 ID。自衛邏輯只針對「自身周圍 8 格內已存在的敵對生物（Hostile Mob）」觸發，**禁止**盲目將「距離最近的玩家或中立生物」當作攻擊者進行反擊。
9. **[RULE-09] 死亡與斷線強制清空**：當觸發 `bot.on('death')` 或 `bot.on('end')` 時，必須立即遞增 `sessionGeneration`，同步呼叫所有活動中 Action 的 `cancel()`，清空 `arbiter` 所有鎖與 `blackboard.runtime`，確保重生後不會延續死前的逃跑或攻擊狀態。
10. **[RULE-10] 測試先行交付順序 (Implementation Order)**：
* **Step 1**：實作 `policy.js`、`blackboard.js`、`bt/nodes.js`、`execution/arbiter.js`、`execution/executor.js`，並通過所有不依賴 Minecraft 伺服器的單元測試（Fake Actions 驗證搶佔與懸空 Promise 隔離）。
* **Step 2**：實作 `actions/*` 與 `perception.js`。
* **Step 3**：組裝 `companion-tree.js` 與 `bot.js`，進行 Paper 伺服器實機驗收。



```

---

<FollowUp label="需要我接著幫你寫出 Step 1 最核心的 `arbiter.js` 與 `executor.js` 完整實作與單元測試嗎？" query="請根據這份 sys-design.md 的規範，幫我實作 src/execution/arbiter.js、src/execution/executor.js 以及對應的單元測試，確保 50ms Fence 與 Token 隔離機制完全符合 RULE-03 到 RULE-05。"/>

```