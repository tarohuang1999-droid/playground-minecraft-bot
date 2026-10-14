# Implementation Plan: Companion Bot Core (v1.0)

> 2026-10-15：依使用者最新指示，全專案新實作使用 TypeScript；下列 `.js` 交付路徑對應為 `.ts`。Stage 1、2、3 已完成單元與整合驗收，包含 1 格跟隨距離、樓梯/半磚/爬梯支援、門主動開啟防抖動與座標相容修正，詳見 [審核交接](agent-note/note-2026-10-15.md)。

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：動工前必須完整讀取 `docs/sys-design/system-design-v1.1.md`，嚴格遵守其中之 `[RULE-01]` 至 `[RULE-10]`。
- **核心開發原則**：
  1. **嚴禁跨階段偷跑 (No Jumping Ahead)**：必須依序完成 Phase 1 至 Phase 8。每個 Phase 結束時必須通過該階段定義的「驗收門檻 (Exit Criteria)」方可進入下一階段。
  2. **先單元測試、後接實機 (Test-First Before Mineflayer)**：Phase 1 與 Phase 2 完全不依賴真實 Minecraft 伺服器，必須以純 Node.js (`node --test`) 100% 跑通。
  3. **禁止引入禁用插件**：全過程嚴禁安裝或引入 `mineflayer-pvp`、`mineflayer-statemachine`、`mistreevous`，嚴禁使用 `pathfinder.goto()`。

---

## Phase 1: 基礎框架與核心單元測試 (Core Engine & Unit Tests)

### 1.1 階段目標
建立完全不依賴 Mineflayer 實例的底層引擎：包含策略常數、黑板快照、五種行為樹節點、All-or-Nothing 資源仲裁器，以及具備 50ms Control-Plane Fence 與 Token 隔離機制的執行器。

### 1.2 交付檔案清單
- `src/policy.js`：定義資源通道常數 (`MOVE`, `LOOK`, `HAND`, `INVENTORY`, `VOICE`)、優先級常數與遲滯門檻。
- `src/blackboard.js`：實作 `createBlackboard()`，支援 `world / intent / runtime` 分區更新與 `freezeSnapshot()`（遞增 `revision` 並回傳 `Object.freeze` 快照）。
- `src/bt/nodes.js`：實作 `ReactiveSelector`、`Sequence`、`Parallel`、`Guard`、`Action` 五種節點與 `halt()` 遞迴重置語義。
- `src/execution/arbiter.js`：實作 `createArbiter()`，完成穩定優先級排序、同級保留原 Owner、整組資源原子配置（All-or-Nothing）。
- `src/execution/executor.js`：實作 `createExecutor()`，管理 `runId`、遞增 `token`、`sessionGeneration`、1 tick (50ms) `stopping` 緩衝鎖釋放，以及目標失敗 Cooldown Map。
- `test/unit/bt-nodes.test.js`
- `test/unit/arbiter.test.js`
- `test/unit/executor-fence.test.js`

### 1.3 實作重點與限制
- BT 節點不得包含任何非同步 (`async/await`) 邏輯，僅收集並回傳當輪 `ActionRequest`。
- `executor.js` 處理搶佔時，呼叫 `adapter.cancel()` 後只需經過 1 個 Tick 週期即可將資源交給新勝者，**嚴禁等待舊 Action 的懸空 Promise resolve/reject**。

### 1.4 驗收門檻 (Exit Criteria)
執行 `node --test test/unit/*.test.js` 全數通過，且必須覆蓋以下測試案例：
- [x] 高優先級分支觸發時，`ReactiveSelector` 正確 `halt` 低優先級分支並重置其 `Sequence` 游標。
- [x] 請求 `{MOVE, LOOK, HAND, INVENTORY}` 與 `{MOVE, LOOK}` 衝突時，低優先級者連部分資源都拿不到。
- [x] 無衝突資源（如 `{MOVE, LOOK}` 與 `{HAND, INVENTORY}`）可於同輪同時獲選為 Winners。
- [x] 使用永不 resolve 的 Fake Promise 模擬懸空 `consume()`，驗證搶佔發生後 1 個 Tick 內新動作成功啟動，且舊 Promise 延遲觸發的回呼被 `ctx.isActive()` 攔截無副作用。

---

## Phase 2: 基本決策邏輯與主迴圈骨架 (Decision Pipeline & Runner Skeleton)

### 2.1 階段目標
打通「感知事件佇列 → 10Hz 決策迴圈 (`runner.js`) → 子樹骨架組裝 → 主人指令解析」的完整 Pipeline，並可在無動作（No-op / Fake Adapter）或最小連線下運行。

### 2.2 交付檔案清單
- `src/bt/runner.js`：實作 5-Step Tick Pipeline（消化佇列 → 凍結快照 → Tick BT → Reconcile 資源 → Execute & Fence），掛載於 `physicsTick` 每 2 ticks (100ms) 執行一次，支援 `requestUrgentTick()` 但禁止同步重入。
- `src/perception.js`：實作 `createPerception(bot)` 基礎結構，採集自身 HP、Food、座標、周圍實體清單與主人狀態，推入事件佇列。
- `src/commands.js`：實作主人權限驗證與指令解析（支援 `follow`, `stop`, `status`），更新 `blackboard.intent`。
- `src/bt/companion-tree.js` 及 `src/bt/subtrees/{survival,combat,work,maintenance}.js`（此階段各子樹僅包含 Guard 判斷與 Stub Action 請求）。
- `src/actions/chat.js`：實作 `VOICE` 獨立佇列。
- `src/bot.js`：完成連線啟動與 `death` / `end` 時重置 `sessionGeneration` 並清空所有鎖的邏輯。
- `test/unit/runner-pipeline.test.js`

### 2.3 驗收門檻 (Exit Criteria)
- [x] 單元測試驗證：在 Tick 執行中途塞入外部事件，不會改變當輪 Snapshot 內容，而是延至下一輪 Tick 生效。
- [x] 單元測試驗證：觸發模擬 `death` 事件時，`sessionGeneration` 遞增，所有 `RUNNING` 動作立即 `cancel` 且資源鎖清空。
- [x] Bot 可成功登入本地 Paper 伺服器，透過聊天室輸入 `follow` 與 `stop` 能正確切換 `blackboard.intent` 並在預設分支回落至 `Idle`。

---

## Phase 3: 跟隨功能 (Follow Functionality)

### 3.1 階段目標
實作導航適配器與 `Follow` 行為（包含一般跟隨 `NormalFollow` 與防落隊急追 `CatchUpFollow`），確保尋路平滑、不重複洗 Goal、邊界不抖動。

### 3.2 交付檔案清單
- `src/actions/navigation.js`：實作 `Follow` Action Adapter。
- 更新 `src/bt/subtrees/work.js`：掛載 `CatchUpFollow` (Priority 40) 與 `NormalFollow` (Priority 20) 的 Guard 與 Action 節點。

### 3.3 實作重點與限制
- **嚴禁使用 `pathfinder.goto()`**，統一使用 `bot.pathfinder.setGoal(new GoalFollow(masterEntity, range), true)`。
- **禁止每輪重設 Goal (`[RULE-07]`)**：同一個 `runId` 持續期間，由於 `dynamic = true` 已交由 Pathfinder 內部追蹤主人位置，`update()` 時不得重複呼叫 `setGoal`。
- **雙門檻遲滯 (Hysteresis)**：
  - `NormalFollow`：距離主人 `> 5` 格時進入 (`RUNNING`)，靠近至 `<= 3` 格時完成 (`SUCCESS`) 並呼叫 `setGoal(null)`。
  - `CatchUpFollow`：距離主人 `> 16` 格時以 Priority 40 進入，靠近至 `<= 6` 格時交棒回一般狀態。
- 當主人不可見（超出視距或跨維度）時，立即 `setGoal(null)` 並回傳 `FAILURE` 退回 `Idle` 等待。

### 3.4 驗收門檻 (Exit Criteria)
- [x] 主人下達 `follow` 後移動，Bot 平滑跟隨，不會在距離 5 格邊界處「走一步停一步」抽搐；支援繞路與跳過障礙物。
- [x] 主人下達 `stop` 或 `unfollow` 時，`Follow` 立即觸發 `cancel()` 呼叫 `setGoal(null)` 原地停下。

---

## Phase 4: 自動防禦反擊 (Self-Defense & Combat)

### 4.1 階段目標
在不使用 `mineflayer-pvp` 的前提下，自製原生受控的 `Combat` 複合動作（含自動換武器 + 追擊 + 視角瞄準 + 冷卻揮砍），並驗證「跟隨中遇襲反擊 → 殺敵後自動恢復跟隨」的無縫交接。

### 4.2 交付檔案清單
- `src/actions/combat.js`：自製 `Combat` Action Adapter（單一 `runId` 涵蓋備武與攻擊）。
- 更新 `src/perception.js`：新增 8 格內敵對生物 (`Hostile Mob`) 偵測與 `entityHurt` 緊急 Tick 觸發。
- 更新 `src/bt/subtrees/combat.js`：實作自衛條件 Guard 與 `Combat` 請求（Priority 80，請求 `{MOVE, LOOK, HAND, INVENTORY}`）。

### 4.3 實作重點與限制
- **傷害來源安全推斷 (`[RULE-08]`)**：僅針對周圍 8 格內的 `Hostile Mob`（如殭屍、骷髏、蜘蛛）進行鎖定反擊，禁止盲目攻擊附近玩家或中立生物。
- **複合動作 Scope**：取得 4 項資源鎖後，先檢查背包是否有比手頭更高傷害的劍/斧，若有則 `await bot.equip(bestWeapon, 'hand')`（前後驗證 `ctx.isActive()`），接著設定 `setGoal(new GoalFollow(target, 2.5), true)`，並依攻擊冷卻（約 500~600ms）執行 `bot.lookAt` 與 `bot.attack`。
- **防風箏與脫戰門檻**：若敵人死亡、距離超過 16 格、或 Bot 與主人距離被拉開超過 24 格，`Combat` 自動結束（釋放鎖），讓 `CatchUpFollow` 或 `NormalFollow` 重新接手。

### 4.4 驗收門檻 (Exit Criteria)
- [ ] 跟隨主人途中生成一隻殭屍，Bot 立即中斷 `Follow`、自動切換背包中的劍、追擊並擊殺殭屍。
- [ ] 殭屍死亡的下一輪 Tick，Bot 不需主人重新下令，自動恢復 `Follow` 回到主人身邊。

---

## Phase 5: 殘血逃跑功能 (Emergency Retreat)

### 5.1 階段目標
實作最高優先級（Priority 100）的候選點採樣撤退邏輯，驗證「戰鬥中殘血 → 立即中止揮劍與追擊 → 反向逃往安全點 → 脫險後恢復」的強制搶佔機制。

### 5.2 交付檔案清單
- 更新 `src/actions/navigation.js`：新增 `Retreat` Action Adapter 與候選安全點採樣演算法。
- 更新 `src/bt/subtrees/survival.js`：實作急迫危險 Guard（`HP <= 6` 且 12 格內有威脅）與 `Retreat` 請求（Priority 100，請求 `{MOVE, LOOK}`）。

### 5.3 實作重點與限制
- **整組搶佔中止 Combat**：當 `Retreat (100)` 觸發時，雖然它只需要 `{MOVE, LOOK}`，但 `arbiter` 必須將整個 `Combat (80)` 中止（同時釋放 `MOVE, LOOK, HAND, INVENTORY`），**嚴禁發生「腳在逃跑、手還在回頭揮劍」的撕裂現象**。
- **8 方位候選點採樣**：以 Bot 為圓心、半徑 10 格採樣 8 個座標點，排除與威脅方向夾角 `< 90°`、目標點為岩漿/水/懸崖（高低差 `> 3` 格）的位置，選出最遠離威脅群的座標設定 `new GoalXZ(x, z)`。
- **退出遲滯 (Exit Hysteresis)**：進入撤退後，必須滿足「距離威脅 `>= 18` 格且維持 3 秒」或「`HP >= 10`」才退出 `Retreat`，避免剛跑出 12.1 格又立刻回頭送死。

### 5.4 驗收門檻 (Exit Criteria)
- [ ] 戰鬥中將 Bot 血量扣至 6 以下，`Combat` 在 100ms 內被強制 `cancel()`（停止攻擊與追擊），Bot 轉頭逃向遠離怪物的安全座標。
- [ ] 逃跑期間沒有任何殘留的 `bot.attack` 或看向怪物的 `bot.lookAt` 被觸發。

---

## Phase 6: 自動鄰近撿拾 (Opportunistic Pickup)

### 6.1 階段目標
實作安全狀態下的順路掉落物撿拾（Priority 30），並導入「不可達目標 Cooldown 機制」防止 Bot 為了撿卡在牆裡或深坑的物品而永久卡死。

### 6.2 交付檔案清單
- 更新 `src/perception.js`：掃描半徑 5 格內的掉落物實體 (`itemDrop`)，過濾掉正在 `executor` Cooldown Map 中的 `entityId`。
- 更新 `src/actions/navigation.js`：新增 `PickupItem` Action Adapter。
- 更新 `src/bt/subtrees/work.js`：在 `CatchUpFollow (40)` 與 `NormalFollow (20)` 之間插入 `PickupItem (30)` 分支。

### 6.3 實作重點與限制
- **觸發條件**：無威脅、背包有空位、距離主人 `< 10` 格、且 5 格內有未冷卻之掉落物。
- **逾時與失敗冷卻 (Cooldown)**：設定 `new GoalXZ(item.x, item.z)` 靠近拾取。若超過 **4 秒** 仍未撿起（或 Pathfinder 回報 `noPath`），Action 回傳 `FAILURE`，並由 `executor` 將該掉落物的 `targetId` 寫入 Cooldown Map（冷卻 30 秒內不再嘗試撿拾該物品），隨即恢復 `NormalFollow`。

### 6.4 驗收門檻 (Exit Criteria)
- [ ] 跟隨途中在 Bot 身旁 4 格丟出物品，Bot 短暫繞路撿起物品後，自動繼續跟隨主人。
- [ ] 將物品丟在圍欄內（不可達位置），Bot 嘗試靠近失敗或滿 4 秒後自動放棄該物品並回到主人身邊，不會在圍欄外無限迴圈撞牆。

---

## Phase 7: 身體維護子樹：自動裝備與進食 (Maintenance: Auto-Equip & Eat)

### 7.1 階段目標
啟用頂層 `Parallel` 的第二條分支 `maintenance.js`，實作只佔用 `{HAND, INVENTORY}` 的 `EquipBest` (Priority 50)、`RoutineEat` (Priority 60) 與 `EmergencyEat` (Priority 90)，完成**「邊跟隨邊吃飯」、「邊逃跑邊吃飯」的雙通道並行（Action Blending）**與**動態挖掘降級（Dynamic `canDig` Downgrade）**。

### 7.2 交付檔案清單
- `src/actions/inventory.js`：實作 `Eat` 與 `EquipBest` Action Adapters。
- 更新 `src/bt/subtrees/maintenance.js`：掛載 `EmergencyEat (90)`、`RoutineEat (60)` 與 `EquipBest (50)`。
- 更新 `src/actions/navigation.js`：連動 `HAND` 鎖狀態，動態切換 `movements.canDig`。

### 7.3 實作重點與限制
- **`consume()` 懸空 Promise 強制隔離 (`[RULE-04]`, `[RULE-05]`)**：
  - `Eat` 啟動時先 `await bot.equip(food, 'hand')`，再呼叫 `bot.consume()`。
  - 當 `Eat (60)` 被 `Combat (80)` 搶佔時，`cancel()` 呼叫 `bot.deactivateItem()`。此時 `executor` 經過 50ms 即將 `{HAND, INVENTORY}` 移交給 `Combat` 拔劍反擊，舊 `consume()` 的 Promise 透過 `ctx.isActive()` 靜默忽略。
- **動態挖掘權限降級**：
  - 當 `Follow` 單獨運行時（`HAND` 空閒），允許 `movements.canDig = true` 以跨越簡單障礙。
  - 當 `Eat` 或 `EquipBest` 取得 `{HAND, INVENTORY}` 時，`navigation.js` 同步將 `movements.canDig = false`，確保走路過程不會揮手挖方塊打斷進食封包。
- **防呆互斥**：`EquipBest (50)` 與 `RoutineEat (60)` 皆需要 `{HAND, INVENTORY}`，因此換裝不會打斷正在進行的進食。

### 7.4 驗收門檻 (Exit Criteria)
- [ ] **邊走邊吃**：Bot 在跟隨主人移動的同時（`Follow` 持有 `MOVE, LOOK`），降低其飢餓度，Bot 能邊跑步邊拿出麵包吃完（`RoutineEat` 持有 `HAND, INVENTORY`），腳步不中斷。
- [ ] **邊逃邊吃**：將 Bot 血量降至 5 且給予食物與怪物威脅，`Retreat (100)` 與 `EmergencyEat (90)` 同時搶佔 `Combat (80)`，Bot 一邊撤退拉開距離、一邊吃東西回血。
- [ ] **進食中被偷襲**：一般進食到一半生成殭屍貼臉，`Combat (80)` 立即中斷 `RoutineEat (60)`，Bot 在 100ms 內收起食物換成鐵劍揮砍，無死鎖或 `faulted` 錯誤。
- [ ] **自動穿裝**：安全狀態下丟給 Bot 一套護甲，自動完成撿拾（Phase 6）並在隨後的 Tick 觸發 `EquipBest` 穿到身上。

---

## Phase 8: 綜合壓力與交接驗收測試 (Integration & Handoff Harness)

### 8.1 階段目標
建立自動化與實機整合測試腳本 (`test/integration/handoff-harness.js`)，針對所有跨狀態搶佔、極端邊界與長時間運行穩定度進行最終驗收。

### 8.2 必測綜合情境清單 (End-to-End Verification Matrix)

| 測試編號 | 測試場景描述 | 預期行為與資源鎖轉移軌跡 |
| :--- | :--- | :--- |
| **E2E-01** | **Follow + Eat 並行與遇襲搶佔** | `Follow(20) + RoutineEat(60)` 並行 → 刷出殭屍 → 兩者同時被 `Combat(80)` 搶佔 → 停止進食、拔劍殺敵 → 殭屍死後恢復 `Follow(20) + RoutineEat(60)` 把飯吃完。 |
| **E2E-02** | **Combat → Retreat + EmergencyEat 雙重搶佔** | `Combat(80)` 交戰中 → 瞬間扣血至 4 → `Retreat(100)` 取得 `{MOVE, LOOK}`、`EmergencyEat(90)` 取得 `{HAND, INVENTORY}` → 邊跑邊吃回血至安全距離。 |
| **E2E-03** | **Pickup 繞路 → 防落隊急追搶佔** | Bot 正在執行 `PickupItem(30)` 走向掉落物 → 主人突然瞬移至 20 格遠 → `CatchUpFollow(40)` 立即中止撿拾，優先追回主人身邊。 |
| **E2E-04** | **死亡與斷線重置 (Session Generation Fencing)** | Bot 在 `Combat` 或 `Eat` 進行到一半時執行 `/kill` → `sessionGeneration` 遞增、所有鎖清空 → 重生後處於乾淨狀態，無殘留報錯或鬼畜移動。 |
| **E2E-05** | **10Hz 迴圈效能與記憶體監控** | 連續運行 10 分鐘，經歷 20 次以上狀態切換：EventEmitter 監聽器數量無洩漏（無 `MaxListenersExceededWarning`），單輪 Tick 決策耗時 `< 5ms`。 |

---

## 附錄：Agent 開發自檢表 (Pre-Commit Checklist for Coding Agent)

每次完成一個 Phase 準備提交程式碼前，Agent 必須逐項核對：
1. [ ] 程式碼中是否完全沒有出現 `bot.pathfinder.goto` 或 `bot.pathfinder.stop`？
2. [ ] `src/bt/` 目錄下是否完全沒有 `async/await` 與 Mineflayer API 呼叫？
3. [ ] `src/actions/` 下每一個 `await` 的下一行，是否都有 `if (!ctx.isActive()) return;`？
4. [ ] 資源鎖釋放是否遵守「50ms Fence 後立即移交」，而非 `await` 舊 Promise 完成？
5. [ ] 連續維持 `RUNNING` 的導航動作，是否確保沒有每輪重複呼叫 `setGoal`？