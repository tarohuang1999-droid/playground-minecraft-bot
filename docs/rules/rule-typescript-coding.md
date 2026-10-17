# TypeScript 開發規範與 AI Agent 編碼鐵律 (rule-typescript-coding.md)

- **適用對象**：全專案 TypeScript 實作、維護模組，以及 AI Coding Agent 開發流程。
- **參考架構**：系統設計以 [system-design-v1.1.md](../sys-design/system-design-v1.1.md)、[system-design-v1.2-architecture.md](../sys-design/system-design-v1.2-architecture.md) 與 [implement-plan.md](../implement-plan.md) 為準。

---

## 1. 核心設計原則 (Anti-Overengineering & Pragmatic Design)

* **KISS 原則 (Keep It Simple, Stupid)**：
  * 優先選擇滿足需求的最簡解法。
  * 嚴禁引入過度設計（Overengineering）：禁止為了單純的計數或狀態同步而建立複雜的 Event Bus、Actor 模型、通用 Workflow DSL 或深層狀態機。
* **YAGNI 原則 (You Aren't Gonna Need It)**：
  * 嚴格禁止為「未來可能需要」預留空資料夾或編寫未經需求的通用框架。
  * 僅針對當前 Stage 明確列出的交付目標進行實作。
* **務實的 TypeScript 風格**：
  * 優先使用普通函式、閉包物件工廠（Object Factory Closures，如 `createArbiter()`、`createExecutor()`）與精簡的 Interface / Type Alias。
  * 不使用 Class 繼承結構實作行為邏輯；不引入依賴注入容器（DI Container）、Service / Repository 模式或全域 Singleton。
* **職責與檔案大小防線 (Anti-God-Object)**：
  * 單一入口或控制器檔案（如 `src/bot.ts`）僅負責組裝（Composition Root）與頂層生命週期綁定，行數應維持在 **220 行以內**；嚴禁將業務計數器、長篇指令分支或動作回呼直接塞入 `bot.ts`。
* **依賴與生態規範**：
  * 嚴格禁止安裝或引入未列於 `package.json` 的第三方套件。
  * 全程嚴格禁止使用 `mineflayer-pvp`、`mineflayer-statemachine`、`mistreevous` 等外部高階黑盒狀態插件。

---

## 2. AI Coding Agent 強制編碼鐵律 (Strict Coding Rules)

任何負責實作本專案的 AI Agent 必須逐條遵守以下 12 條鐵律，違反任一條視為實作失敗：

1. **[RULE-01] TypeScript 語言與編譯規範**：
   * 全專案使用 TypeScript，編譯設定以 `tsconfig.json` 為唯一標準（`target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`）。
   * 啟用最高嚴格度：`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`。
   * 模組導入之相對路徑**必須顯式包含 `.ts` 副檔名**（配合 `rewriteRelativeImportExtensions: true`）。
   * **禁止新增 `any`**：新增或重構之模組（如 `command-controller.ts`、`task-session-manager.ts`、`actions/index.ts`）嚴禁使用 `any`；對接 Mineflayer 時使用結構化最小介面（Structural Port）或 `unknown` 縮窄。
   * 遵守 `erasableSyntaxOnly: true`：不使用 `enum`、`namespace`，枚舉值一律採用字串聯合型別與 `as const` 陣列。
2. **[RULE-02] 行為樹 (`src/bt/**`) 純函式與零副作用鐵律**：
   * `src/bt/**` 目錄下的所有檔案**嚴禁**引入 `mineflayer` runtime 依賴（僅允許 `import type`），**嚴禁**持有 `bot` 實例。
   * **嚴禁**使用 `async / await` 或啟動定時器。
   * **嚴禁在 BT 內部宣告跨 Tick 的可變業務閉包旗標**（例如 `let farmingFinishedTriggered = false`），也**嚴禁**在 `guard` 或 `action` 評估期間直接觸發改變 `intent` 或發送 `chat` 的副作用回呼。BT 節點只能純同步讀取 `snapshot: BlackboardSnapshot` 並回傳 `{ status: NodeStatus, requests: ActionRequest[] }`。
3. **[RULE-03] 資源請求原子性與靜態能力契約 (All-or-Nothing)**：
   * 任何 Action 不得在執行中途動態追加資源鎖（Lock Escalation），也不得在只拿到部分鎖時偷跑。
   * 所有需要的資源通道必須在 `ActionRequest.requiredResources` 一次完整宣告（例如啟用 `canDig` 或 `allowBridge` 的導航必須一次宣告 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`；未宣告 `HAND` 的普通導航只拿 `['MOVE', 'LOOK']`，不在執行中動態切換 `canDig`）。
4. **[RULE-04] 強制 Token、Generation 與 Catch/Fallback 雙重檢查**：
   * 在 `src/actions/**` 中，任何 `await` 語句的下一行、`catch` 區塊進入 Fallback 操作前、以及任何 `setTimeout` / 事件監聽回呼的第一行，**必須**執行：
     ```ts
     if (!ctx.isActive()) return; // 內部同時檢查 token === currentToken && gen === sessionGeneration
     ```
   * 未加此檢查的非同步程式碼（包含 `try/catch` 失敗後的備援 API 呼叫）一律禁止提交。
5. **[RULE-05] 搶佔圍欄與停止確認 (50ms Fence & `isStopped` Contract)**：
   * `executor.ts` 在取消舊動作時，呼叫 `adapter.cancel()` 後至少經過 **1 個 `physicsTick` (50ms)** 的 `stopping` 緩衝期；若 Adapter 實作了 `isStopped()`，必須等待 `isStopped() === true` 才釋放資源鎖（若逾時 1000ms 未停止則進入 `FAULTED` 狀態保護）。
   * Adapter 的 `isStopped()` 必須反映真實的 `inFlight` 非同步操作是否已收尾，**禁止**只回傳被 `cancel()` 同步改寫的 `!active` 布林值來假裝底層已停止。
6. **[RULE-06] 尋路控制唯一入口**：
   * 禁止在全專案任何地方出現 `bot.pathfinder.goto` 或 `bot.pathfinder.stop`。
   * 更新尋路唯一允許 `bot.pathfinder.setGoal(goal, dynamic)`，停止尋路唯一允許 `bot.pathfinder.setGoal(null)`。
7. **[RULE-07] 避免尋路抖動 (No Goal Spamming)**：
   * 當 `Follow`、`Retreat` 或 `Combat` 在連續多輪 Tick 中維持同一個 `runId` 與目標時，Adapter **不得**每輪重複呼叫 `bot.pathfinder.setGoal()` 重設相同目標（動態追蹤目標交由 `setGoal(goal, true)` 內部更新）。
8. **[RULE-08] 傷害來源安全推斷**：
   * 處理 `entityHurt` 事件時，若事件未提供明確 `source` 實體，且周圍 4.5 格內玩家在過去 `1000ms` 內無 `entitySwingArm` 揮手紀錄，**嚴禁**將旁觀玩家或主人推定為攻擊者（防止摔傷、飢餓或環境傷害導致誤砍玩家）。
9. **[RULE-09] 死亡、斷線與 `dispose()` 完整清理**：
   * 當觸發 `bot.on('death')` 或 `bot.on('end')` 時，必須立即遞增 `sessionGeneration`，同步取消所有活動中 Action，清空 `arbiter` 所有鎖、`blackboard.runtime` 與進行中的工作 Session。
   * 任何對 `bot` 或 `bot.pathfinder` 方法的包裝（Monkey-patch）與事件監聽，**必須**在 `dispose()` 時完整還原與卸載，不得殘留跨實例污染。
10. **[RULE-10] 全專案時間原點統一 (Unified Clock Source)**：
    * 所有用於計算經過時間（Elapsed Time）、工時期限（`maxDurationMs`）、冷卻到期（Cooldown）與快照時間戳（`observedAt`）的邏輯，**必須**使用同一個注入的時間函式 `now()`（預設統一為 `Date.now()` 或由測試注入的 `options.now`），**嚴禁**混用 `performance.now()` 與 `Date.now()`。
11. **[RULE-11] 禁止單一 Action 獨佔攔截共用 Bot API**：
    * 導航防護邊界（`NavigationExecutionBoundary`）僅能限制導航期間由 Pathfinder 觸發的挖掘與搭橋，**嚴禁**無條件阻斷其他已合法取得 `HAND` / `INVENTORY` 資源鎖的 Action（如 `FarmPlant`、`HarvestCrop`）呼叫 `bot.placeBlock` 或 `bot.dig`。
12. **[RULE-12] 測試先行交付順序 (Implementation Order)**：
    * 遵循 Stage 規劃依序進行，不得跨階段偷跑。
    * 每完成一個模組必須先通過純單元測試（`pnpm test`）、型別校驗（`pnpm run typecheck`）與靜態檢查（`pnpm run lint`）。

---

## 3. 架構分層與模組界線 (Architectural Boundaries)

各模組邊界必須嚴格遵守以下職責劃分：

| 模組路徑 | 職責 (該做什麼) | 限制 (嚴禁做什麼) |
| :--- | :--- | :--- |
| `src/bot.ts` | 機器人連線啟動、Mineflayer 插件掛載、組合根（Composition Root）依賴組裝、頂層事件綁定與 `dispose()` | 撰寫具體戰鬥/尋路/農事流程、宣告散落的任務計數閉包變數、塞入長篇指令 `if-else` |
| `src/commands.ts` | 純函式解析聊天室與密語字串、主人名稱比對、回傳型別化 `CommandEvent` | 包含任何 I/O、讀取 `bot` 狀態或修改 `blackboard` |
| `src/command-controller.ts` | 驗證指令前置條件（如背包種子、基地座標）、格式化 `!item` / `!status` 回覆、觸發任務 Session 與 `runner.enqueue` | 直接呼叫 `bot.pathfinder`、`bot.attack` 等底層動作 API |
| `src/sessions/task-session-manager.ts` | 集中管理範圍任務（`FARM`, `HUNT`, `HARVEST`）的工作階段計數、失敗熔斷、工時超時檢查與單次完成摘要回報 | 直接操作 `bot` 控制 API 或在 BT 節點內偷偷執行 |
| `src/blackboard.ts` | 集中管理世界快照、提供 `world / intent / runtime` 分區、發布唯讀凍結物件 (`Object.freeze`) | 撰寫遊戲決策或排程邏輯 |
| `src/policy.ts` & `src/config/**` | 定義資源通道 (`MOVE`, `LOOK`, `HAND`, `INVENTORY`, `VOICE`)、動作優先級常數與遲滯閥值 | 包含任何執行期邏輯或 I/O 操作 |
| `src/bt/**` | 行為樹節點與子樹結構、純同步決策評估、收集當輪 `ActionRequest` | 引入 `mineflayer` 模組、持有 `bot` 實例、使用 `async/await`、保存跨任務閉包旗標或觸發外部副作用 |
| `src/execution/arbiter.ts` | 資源通道權限分配、穩定優先級排序、All-or-Nothing 整組原子鎖定 | 操作 Mineflayer API 或發起非同步呼叫 |
| `src/execution/executor.ts` | 管理 `runId`、`token`、`sessionGeneration`、搶佔 Fencing、失敗冷卻表 (`Cooldown Map`) | 決定誰優先獲得資源（職責歸屬 Arbiter） |
| `src/perception.ts` | 週期性與事件驅動採集周圍環境狀態（血量、食物、實體、主人、農地、箱子），輸出純資料 `WorldState` | 直接修改機器人控制狀態或觸發動作 |
| `src/actions/index.ts` | 統一註冊與組裝所有 Action Adapters，提供標準前置條件檢查與 `dispose()` | 保存跨任務計數器或直接改寫全域狀態 |
| `src/actions/**` | 執行具體 Mineflayer 操作、監聽中斷信號、目標有效性驗證、清理控制狀態 | 自行決定動作優先級、存取未經 Arbiter 配給的資源通道 |

---

## 4. Mineflayer API 避坑指南與實戰防線

### 4.1 Vec3 物件相容性防線
* **問題根因**：Mineflayer 與 `prismarine-world` 內部依賴 `pos.floored()` 方法。若傳遞一般 JS 物件 `{ x, y, z }` 給 `bot.blockAt(pos)`，會引發 `TypeError: pos.floored is not a function`。
* **強制規範**：所有進入 `bot.blockAt()` 或 `bot.findBlock({ point })` 的座標必須為 `Vec3` 實例，或透過封裝的 `safeBlockAt(bot, pos)` 進行安全轉換。

### 4.2 門與方塊互動防抖動 (Anti-Flapping)
* **已開啟防重入**：開門前必須檢查 `isDoorOpen(block)`，若已處於開啟狀態，**絕對不得**重複觸發點擊。
* **上下半門歸一化**：偵測到門的上半部（`half === 'upper'`）時，必須將 Y 座標減 1，統一對下半門發送激活操作。
* **座標冷卻表**：以門方塊的整數座標建立冷卻記錄（如 1500ms），動作被中斷或重啟時**不得**重置此冷卻。

### 4.3 動物死亡與消失事件區分 (`entityDead` vs `entityGone`)
* Mineflayer 中 `entityGone` 代表實體離開視野或區塊卸載（`entity_destroy`），**不等於死亡**；只有收到 `entityDead`（或實體 `health <= 0`）且該實體在當前狩獵 Session 中曾被 Bot 攻擊過，才可計入有效擊殺數。

---

## 5. 測試與型別校驗規範

* **測試編寫詳細規範**：詳見 [docs/rules/rule-testing.md](file:///Users/james/projects/playground-mineflayer/docs/rules/rule-testing.md)。
* **交付前必跑三項檢查**：
  ```bash
  pnpm run typecheck
  pnpm run lint
  pnpm test
  ```
* **可觀測性要求**：
  * 執行期重要狀態變更、指令解析、動作搶佔與未預期異常，必須透過 `src/logger.ts` 記錄於 `logs/bot-{name}-{date}.log`。
