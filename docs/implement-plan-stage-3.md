# Implementation Plan: Stage 3 - 核心架構輕量化重構與 P1 穩定性修復 (KISS & Anti-Overengineering)

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：
  - [rule-typescript-coding.md](rules/rule-typescript-coding.md)（TypeScript 開發規範與 12 條鐵律）
  - [system-review-2026-10-17.md](agent-note/system-review-2026-10-17.md)（系統健檢 P1 缺陷報告）
  - [system-design-v1.2-architecture.md](sys-design/system-design-v1.2-architecture.md)（重構後模組職責與資料流補充設計）
- **核心重構原則（嚴防 Overengineering）**：
  1. **只解決真實痛點（KISS & YAGNI）**：本次重構專注於修復已重現的 P1 Runtime 缺陷（`SR-01`~`SR-05`、`SR-07`、`SR-09`）並將 697 行的 `src/bot.ts` 拆解為職責單一的三個輕量模組。
  2. **禁止過度抽象**：**不引入** Event Bus、Actor 模型、DI Container、複雜狀態機或深層繼承；一律維持專案既有的純函式與閉包工廠（Closure Factory）風格。
  3. **100% 保留穩定核心**：`src/execution/arbiter.ts`、`src/execution/executor.ts`、`src/bt/nodes.ts` 與 `src/blackboard.ts` 核心機制不重寫。

---

## 階段目錄 (Stage 3 Breakdown)

- **Stage 3.1: 單一時間原點 (`Clock`) 與底層控制安全邊界修復 (`SR-01`, `SR-02`, `SR-03`, `SR-05`, `SR-09`)**
- **Stage 3.2: 輕量級任務工作階段管理器 (`src/sessions/task-session-manager.ts`) (`SR-04`, `SR-07`)**
- **Stage 3.3: 動作註冊表 (`src/actions/index.ts`) 與指令控制器 (`src/command-controller.ts`) 抽離**
- **Stage 3.4: `src/bot.ts` 極簡組裝根收斂與跨回合回歸測試**

---

## Stage 3.1: 單一時間原點 (`Clock`) 與底層控制安全邊界修復

### 3.1.1 階段目標
在不改變模組結構的前提下，先修復 4 個會導致功能失效或誤操作的 P1 Runtime 缺陷。

### 3.1.2 具體修改內容
1. **統一時間原點 (`SR-01` / `[RULE-10]`)**：
   - **問題**：`src/bt/runner.ts` 預設使用 `performance.now()`，而 `src/bot.ts`、`src/perception.ts` 與 Actions 使用 `Date.now()`，導致 `work.ts` 計算 ` snapshot.observedAt - workArea.startedAt` 得到負數，20 分鐘工時限制永遠不觸發。
   - **簡潔解法**：將 `src/bt/runner.ts` 的預設時鐘改為 `const now = options.now ?? (() => Date.now());`，並在 `attachCompanion` 中將同一個 `now` 函式傳遞給 `perception`、`runner`、以及建立 `workArea.startedAt` 的指令處。不需建立複雜的 Clock Class。
2. **解開 `NavigationExecutionBoundary` 對非導航動作的誤殺 (`SR-03` & `SR-09` / `[RULE-09]`, `[RULE-11]`)**：
   - **問題**：`src/actions/navigation-guard.ts` 安裝後無條件攔截所有 `bot.dig` 與 `bot.placeBlock`，當 `activeContext === null`（例如正在執行 `FarmPlant` 而非導航動作）時直接拋出 `Place rejected: navigation run is not active`；且 `dispose()` 未呼叫 `boundary.uninstall(bot)`。
   - **簡潔解法**：
     - 當 `this.activeContext !== null`（代表目前是導航 Action 正在控制移動與挖放）時，嚴格執行導航白名單、`canDig / allowBridge` 與配額檢查；當 `this.activeContext === null`（非導航 Action 執行期）時，放行給原始 `originalDig / originalPlaceBlock`（由各 Action 自身的 Arbiter 資源鎖管控）。
     - 在 `createNavigation` 回傳物件中暴露 `dispose()`，內部呼叫 `boundary.uninstall(bot)` 並移除 `path_update` 監聽器，由 `bot.ts` 的 `dispose()` 統一呼叫。
3. **補齊 `farming.ts` 取消後的 Fallback 檢查 (`SR-02` / `[RULE-04]`)**：
   - 在 `src/actions/farming.ts` 的 `placeBlock` `try/catch` 結束後、進入 `activateBlock` fallback 之前，以及 `activateBlock` 的 `await` 之後、`swingArm` 之前，加上 `if (!active || !ctx.isActive()) return;`。
   - `isStopped()` 改為 `return !active && !inFlight;`，確保非同步播種真正結束後才回報已停止。
4. **修正無來源傷害盲猜旁觀玩家 (`SR-05` / `[RULE-08]`)**：
   - 在 `src/bot.ts` 的 `entityHurt` 中，當 `source` 為空時，僅在候選玩家於過去 `1000ms` 內有明確 `recentArmSwings` 紀錄（`now - swingTime <= 1000`）時才將其視為攻擊者；若無近期揮手紀錄，忽略玩家反擊，防止摔傷或環境傷害誤砍主人與路人。

### 3.1.3 驗收門檻
- [ ] 在預設 `startBot` / `attachCompanion` 時鐘下推進時間超過 20 分鐘，`FARM` 與 `HUNT` 皆能準時觸發 `TIMEOUT`。
- [ ] 同時掛載 `navigation` 與 `farming` 時，`FarmPlant` 呼叫 `bot.placeBlock` 不再被 `NavigationExecutionBoundary` 拒絕。
- [ ] `FarmPlant` 在 `placeBlock` 進行中被 `cancel()` 後，不會再觸發 fallback `activateBlock` 或 `swingArm`。
- [ ] 旁邊有未揮手的玩家時觸發無來源 `entityHurt`，不會將該玩家加入 `threats`。

---

## Stage 3.2: 輕量級任務工作階段管理器 (`src/sessions/task-session-manager.ts`)

### 3.2.1 階段目標
將散落在 `src/bot.ts` 的任務計數閉包變數（`plantedCropsCount`、`consecutiveFailures`、`huntingSession`）與 `src/bt/subtrees/work.ts` 的完成旗標（`farmingFinishedTriggered`、`huntingFinishedTriggered`）統一收斂至單一輕量模組 `src/sessions/task-session-manager.ts`，解決 `SR-04`（第二次執行任務不觸發完成）與 `SR-07`（動物離開視野誤判為擊殺）。

### 3.2.2 設計規格（保持極簡 KISS）
- **檔案路徑**：`src/sessions/task-session-manager.ts`
- **不引入複雜狀態機**，僅管理純資料結構與明確的操作方法：
  - `startFarming(missionId: string)`：重置 `plantedCount = 0`、`consecutiveFailures = 0`、`finishedMissionId = null`。
  - `recordCropPlanted(): number`：遞增 `plantedCount` 並將 `consecutiveFailures` 歸零。
  - `recordFarmFailure(): { consecutiveFailures: number; shouldAbort: boolean }`：遞增失敗次數，達 5 次時回傳 `shouldAbort: true`。
  - `startHunting(missionId: string)`：清空 `attackedIds`、`killedIds`、`finishedMissionId = null`。
  - `recordAnimalAttacked(entityId: number)`：記錄曾被 Bot 攻擊的動物 ID。
  - `recordAnimalDead(entityId: number): boolean`：僅在 `attackedIds.has(entityId)` 且尚未計入 `killedIds` 時加入 `killedIds`（**移除原本 `entityGone` 誤算擊殺的邏輯**，`entityGone` 只放進冷卻表）。
  - `tryCompleteTask(missionId: string, reason: 'COMPLETED' | 'TIMEOUT'): { completed: boolean; count: number }`：以 `missionId` 判斷是否已回報過（取代 `work.ts` 裡壞掉的 boolean 旗標）。只要是新的 `missionId`，就保證能觸發一次完成回報！
  - `reset()`：死亡或斷線時清空所有暫存。
- **重構 `src/bt/subtrees/work.ts`**：
  - 移除 `let farmingFinishedTriggered = false` 與 `let huntingFinishedTriggered = false`，改由外部傳入 `onFarmingFinished(missionId, reason)` 與 `onHuntingFinished(missionId, reason)`，在 `TaskSessionManager` 內以 `missionId` 進行單次觸發保護，徹底遵守 `[RULE-02]`。

### 3.2.3 驗收門檻
- [ ] 連續執行 3 次 `!hunt` 或 `!farm`（Start $\to$ Complete $\to$ Start $\to$ Complete），每一次都能正常觸發完成通知並切換回 `IDLE`。
- [ ] 動物被攻擊後若僅觸發 `entityGone`（逃出視野/區塊卸載）而不觸發 `entityDead`，不計入擊殺數。
- [ ] `src/bt/subtrees/work.ts` 內部無任何跨任務 `let` 可變閉包旗標。

---

## Stage 3.3: 動作註冊表 (`src/actions/index.ts`) 與指令控制器 (`src/command-controller.ts`) 抽離

### 3.3.1 階段目標
將 `src/bot.ts` 內的「動作組裝與回呼綁定」抽離至 `src/actions/index.ts`，並將「聊天指令處理與狀態查詢格式化」抽離至 `src/command-controller.ts`，同時預留清晰的動作前置檢查結構，方便未來 Stage 4 擴充與後續接入 Jev/LLM。

### 3.3.2 模組劃分與規格
1. **`src/actions/index.ts` (`createActionAdapters`)**：
   - 統一實例化 `navigation`、`combat`、`inventory`、`farming`、`hunting`、`chat` 等 Adapters。
   - 封裝各動作與 `perception`、`taskSessionManager`、`runner`、`chat` 的標準連動回呼。
   - 回傳 `{ adapters: AdapterRegistry, dispose(): void }`。
2. **`src/command-controller.ts` (`createCommandController`)**：
   - 封裝原本在 `bot.ts` 長達 210 行的 `command(username, message)` 函式。
   - 呼叫 `parseCommand(owner, username, message)`，執行各指令的前置條件檢查（`!come` 檢查主人可見、`!return` 檢查 Base/Spawn、`!farm` 檢查種子、`!item` 格式化輸出裝備與背包），並呼叫 `taskSessionManager.startFarming/startHunting` 與 `runner.enqueue`。

### 3.3.3 驗收門檻
- [ ] 新增模組零 `any`（遵守 `[RULE-01]`）。
- [ ] `CommandController` 與 `TaskSessionManager` 可透過輕量級單元測試獨立驗證，不需啟動完整 Mineflayer 實例。

---

## Stage 3.4: `src/bot.ts` 極簡組裝根收斂與跨回合回歸測試

### 3.4.1 階段目標
完成 `src/bot.ts` 瘦身，使其成為純粹的 **Composition Root（組裝根）與頂層生命週期管理入口**，並通過所有單元測試與新增的跨回合/邊界回歸測試。

### 3.4.2 驗收門檻
- [ ] `src/bot.ts` 行數精簡至 **220 行以內**，內部無業務計數變數、無長篇指令 `if-else`。
- [ ] `companion.dispose()` 正確釋放所有事件監聽器與 `navigation` 的 API 包裝（重複 attach/dispose 不洩漏、不疊加 wrapper）。
- [ ] `pnpm run typecheck`、`pnpm run lint`、`pnpm run format:check` 與 `pnpm test` 100% 通過。
