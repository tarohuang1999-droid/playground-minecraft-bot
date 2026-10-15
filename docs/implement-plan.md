# Implementation Plan: Companion Bot Core (v1.0)

> 2026-10-15：依使用者最新指示，全專案新實作使用 TypeScript；下列 `.js` 交付路徑對應為 `.ts`。Stage 1、2、3、4、5 已完成單元與整合驗收，包含跟隨、開門防抖動、掉落物撿拾冷卻、自動穿裝、自動進食與雙通道並行（邊走邊吃）。

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：動工前必須完整讀取 `docs/sys-design/system-design-v1.1.md`，嚴格遵守其中之 `[RULE-01]` 至 `[RULE-10]`。
- **核心開發原則**：
  1. **嚴禁跨階段偷跑 (No Jumping Ahead)**：必須依序完成 Stage 1 至 Stage 8。每個 Stage 結束時必須通過該階段定義的「驗收門檻 (Exit Criteria)」方可進入下一階段。
  2. **先單元測試、後接實機 (Test-First Before Mineflayer)**：Stage 1 與 Stage 2 完全不依賴真實 Minecraft 伺服器，必須以純 Node.js (`pnpm test`) 100% 跑通。
  3. **禁止引入禁用插件**：全過程嚴禁安裝或引入 `mineflayer-pvp`、`mineflayer-statemachine`、`mistreevous`，嚴禁使用 `pathfinder.goto()`。

---

## Stage 1: 基礎框架與核心單元測試 (Core Engine & Unit Tests)

### 1.1 階段目標
建立完全不依賴 Mineflayer 實例的底層引擎：包含策略常數、黑板快照、五種行為樹節點、All-or-Nothing 資源仲裁器，以及具備 50ms Control-Plane Fence 與 Token 隔離機制的執行器。

### 1.2 交付檔案清單
- `src/policy.ts`：定義資源通道常數 (`MOVE`, `LOOK`, `HAND`, `INVENTORY`, `VOICE`)、優先級常數與遲滯門檻。
- `src/blackboard.ts`：實作 `createBlackboard()`，支援 `world / intent / runtime` 分區更新與 `freezeSnapshot()`（遞增 `revision` 並回傳 `Object.freeze` 快照）。
- `src/bt/nodes.ts`：實作 `ReactiveSelector`、`Sequence`、`Parallel`、`Guard`、`Action` 五種節點與 `halt()` 遞迴重置語義。
- `src/execution/arbiter.ts`：實作 `createArbiter()`，完成穩定優先級排序、同級保留原 Owner、整組資源原子配置（All-or-Nothing）。
- `src/execution/executor.ts`：實作 `createExecutor()`，管理 `runId`、遞增 `token`、`sessionGeneration`、1 tick (50ms) `stopping` 緩衝鎖釋放，以及目標失敗 Cooldown Map。
- `test/unit/bt-nodes.test.ts`
- `test/unit/arbiter.test.ts`
- `test/unit/executor-fence.test.ts`

### 1.3 實作重點與限制
- BT 節點不得包含任何非同步 (`async/await`) 邏輯，僅收集並回傳當輪 `ActionRequest`。
- `executor.ts` 處理搶佔時，呼叫 `adapter.cancel()` 後只需經過 1 個 Tick 週期即可將資源交給新勝者，**嚴禁等待舊 Action 的懸空 Promise resolve/reject**。

### 1.4 驗收門檻 (Exit Criteria)
執行 `pnpm test` 全數通過，且必須覆蓋以下測試案例：
- [x] 高優先級分支觸發時，`ReactiveSelector` 正確 `halt` 低優先級分支並重置其 `Sequence` 游標。
- [x] 請求 `{MOVE, LOOK, HAND, INVENTORY}` 與 `{MOVE, LOOK}` 衝突時，低優先級者連部分資源都拿不到。
- [x] 無衝突資源（如 `{MOVE, LOOK}` 與 `{HAND, INVENTORY}`）可於同輪同時獲選為 Winners。
- [x] 使用永不 resolve 的 Fake Promise 模擬懸空 `consume()`，驗證搶佔發生後 1 個 Tick 內新動作成功啟動，且舊 Promise 延遲觸發的回呼被 `ctx.isActive()` 攔截無副作用。

---

## Stage 2: 基本決策邏輯與主迴圈骨架 (Decision Pipeline & Runner Skeleton)

### 2.1 階段目標
打通「感知事件佇列 → 10Hz 決策迴圈 (`runner.ts`) → 子樹骨架組裝 → 主人指令解析」的完整 Pipeline，並可在無動作（No-op / Fake Adapter）或最小連線下運行。

### 2.2 交付檔案清單
- `src/bt/runner.ts`：實作 5-Step Tick Pipeline（消化佇列 → 凍結快照 → Tick BT → Reconcile 資源 → Execute & Fence），掛載於 `physicsTick` 每 2 ticks (100ms) 執行一次，支援 `requestUrgentTick()` 但禁止同步重入。
- `src/perception.ts`：實作 `createPerception(bot)` 基礎結構，採集自身 HP、Food、座標、周圍實體清單與主人狀態，推入事件佇列。
- `src/commands.ts`：實作主人權限驗證與指令解析（支援 `follow`, `stop`, `status`），更新 `blackboard.intent`。
- `src/bt/companion-tree.ts` 及 `src/bt/subtrees/{survival,combat,work,maintenance}.ts`（此階段各子樹僅包含 Guard 判斷與 Stub Action 請求）。
- `src/actions/chat.ts`：實作 `VOICE` 獨立佇列。
- `src/bot.ts`：完成連線啟動與 `death` / `end` 時重置 `sessionGeneration` 並清空所有鎖的邏輯。
- `test/unit/runner-pipeline.test.ts`

### 2.3 驗收門檻 (Exit Criteria)
- [x] 單元測試驗證：在 Tick 執行中途塞入外部事件，不會改變當輪 Snapshot 內容，而是延至下一輪 Tick 生效。
- [x] 單元測試驗證：觸發模擬 `death` 事件時，`sessionGeneration` 遞增，所有 `RUNNING` 動作立即 `cancel` 且資源鎖清空。
- [x] Bot 可成功登入本地 Paper 伺服器，透過聊天室輸入 `follow` 與 `stop` 能正確切換 `blackboard.intent` 並在預設分支回落至 `Idle`。

---

## Stage 3: 跟隨功能 (Follow Functionality)

### 3.1 階段目標
實作導航適配器與 `Follow` 行為（包含一般跟隨 `NormalFollow` 與防落隊急追 `CatchUpFollow`），確保尋路平滑、不重複洗 Goal、邊界不抖動。

### 3.2 交付檔案清單
- `src/actions/navigation.ts`：實作 `Follow` Action Adapter。
- 更新 `src/bt/subtrees/work.ts`：掛載 `CatchUpFollow` (Priority 40) 與 `NormalFollow` (Priority 20) 的 Guard 與 Action 節點。

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

## Stage 4: 自動鄰近撿拾 (Opportunistic Pickup)

### 4.1 階段目標
實作安全狀態下的順路掉落物撿拾（Priority 30），並導入「不可達目標 Cooldown 機制」防止 Bot 為了撿卡在牆裡或深坑的物品而永久卡死。完成後為後續裝備穿戴與補給提供物品來源。

### 4.2 交付檔案清單
- 更新 `src/perception.ts`：掃描半徑 5 格內的掉落物實體 (`itemDrop`)，過濾掉正在 `executor` Cooldown Map 中的 `entityId`。
- 更新 `src/actions/navigation.ts`：新增 `PickupItem` Action Adapter。
- 更新 `src/bt/subtrees/work.ts`：在 `CatchUpFollow (40)` 與 `NormalFollow (20)` 之間插入 `PickupItem (30)` 分支。
- `test/unit/pickup.test.ts`：單元測試驗證掉落物評估、優先級切換與 Cooldown 機制。

### 4.3 實作重點與限制
- **觸發條件**：無威脅、背包有空位、距離主人 `< 10` 格、且 5 格內有未冷卻之掉落物。
- **逾時與失敗冷卻 (Cooldown)**：設定 `new GoalXZ(item.x, item.z)` 靠近拾取。若超過 **4 秒** 仍未撿起（或 Pathfinder 回報 `noPath`），Action 回傳 `FAILURE`，並由 `executor` 將該掉落物的 `targetId` 寫入 Cooldown Map（冷卻 30 秒內不再嘗試撿拾該物品），隨即恢復 `NormalFollow`。
- **不可達目標防死鎖**：嚴禁在無法到達的掉落物前無限重試，逾時後必須強制放棄並冷卻。

### 4.4 驗收門檻 (Exit Criteria)
- [x] 跟隨途中在 Bot 身旁 4 格丟出物品，Bot 短暫繞路撿起物品後，自動繼續跟隨主人。
- [x] 將物品丟在圍欄內（不可達位置），Bot 嘗試靠近失敗或滿 4 秒後自動放棄該物品並回到主人身邊，不會在圍欄外無限迴圈撞牆。

---

## Stage 5: 身體維護子樹：自動裝備與進食 (Maintenance: Auto-Equip & Eat)

### 5.1 階段目標
啟用頂層 `Parallel` 的第二條分支 `maintenance.ts`，實作只佔用 `{HAND, INVENTORY}` 的 `EquipBest` (Priority 50)、`RoutineEat` (Priority 60) 與 `EmergencyEat` (Priority 90)，完成**「邊跟隨邊吃飯」的雙通道並行（Action Blending）**與**動態挖掘降級（Dynamic `canDig` Downgrade）**。

### 5.2 交付檔案清單
- `src/actions/inventory.ts`：實作 `Eat` 與 `EquipBest` Action Adapters。
- 更新 `src/bt/subtrees/maintenance.ts`：掛載 `EmergencyEat (90)`、`RoutineEat (60)` 與 `EquipBest (50)`。
- 更新 `src/actions/navigation.ts`：連動 `HAND` 鎖狀態，動態切換 `movements.canDig`。
- `test/unit/maintenance.test.ts`：單元測試驗證進食、穿裝與雙通道資源無衝突並行。

### 5.3 實作重點與限制
- **`consume()` 懸空 Promise 強制隔離 (`[RULE-04]`, `[RULE-05]`)**：
  - `Eat` 啟動時先 `await bot.equip(food, 'hand')`，再呼叫 `bot.consume()`。
  - 當 `Eat` 被高等級動作搶佔時，`cancel()` 呼叫 `bot.deactivateItem()`。`executor` 經過 50ms 即將 `{HAND, INVENTORY}` 移交給新動作，舊 `consume()` 的 Promise 透過 `ctx.isActive()` 靜默忽略。
- **動態挖掘權限降級**：
  - 當 `Follow` 單獨運行時（`HAND` 空閒），允許 `movements.canDig = true` 以跨越簡單障礙。
  - 當 `Eat` 或 `EquipBest` 取得 `{HAND, INVENTORY}` 時，`navigation.ts` 同步將 `movements.canDig = false`，確保走路過程不會揮手挖方塊打斷進食封包。
- **防呆互斥**：`EquipBest (50)` 與 `RoutineEat (60)` 皆需要 `{HAND, INVENTORY}`，因此換裝不會打斷正在進行的進食。

### 5.4 驗收門檻 (Exit Criteria)
- [x] **邊走邊吃**：Bot 在跟隨主人移動的同時（`Follow` 持有 `MOVE, LOOK`），降低其飢餓度，Bot 能邊跑步邊拿出麵包吃完（`RoutineEat` 持有 `HAND, INVENTORY`），腳步不中斷。
- [x] **自動穿裝**：安全狀態下丟給 Bot 一套護甲，由 Stage 4 自動完成撿拾後，在隨後的 Tick 觸發 `EquipBest` 自動穿戴到身上。

---

## Stage 6: 自動防禦反擊 (Self-Defense & Combat)

### 6.1 階段目標
在不使用 `mineflayer-pvp` 的前提下，自製原生受控的 `Combat` 複合動作（含自動換武器 + 追擊 + 視角瞄準 + 冷卻揮砍），並驗證「跟隨中遇襲反擊 → 殺敵後自動恢復跟隨」的無縫交接。

### 6.2 交付檔案清單
- `src/actions/combat.ts`：自製 `Combat` Action Adapter（單一 `runId` 涵蓋備武與攻擊）。
- 更新 `src/perception.ts`：新增 8 格內敵對生物 (`Hostile Mob`) 偵測與 `entityHurt` 緊急 Tick 觸發。
- 更新 `src/bt/subtrees/combat.ts`：實作自衛條件 Guard 與 `Combat` 請求（Priority 80，請求 `{MOVE, LOOK, HAND, INVENTORY}`）。
- `test/unit/combat.test.ts`：單元測試驗證傷害來源推斷、目標選擇與冷卻揮砍。

### 6.3 實作重點與限制
- **傷害來源安全推斷 (`[RULE-08]`)**：僅針對周圍 8 格內的 `Hostile Mob`（如殭屍、骷髏、蜘蛛）進行鎖定反擊，禁止盲目攻擊附近玩家或中立生物。
- **複合動作 Scope**：取得 4 項資源鎖後，先檢查背包是否有比手頭更高傷害的劍/斧，若有則 `await bot.equip(bestWeapon, 'hand')`（前後驗證 `ctx.isActive()`），接著設定 `setGoal(new GoalFollow(target, 2.5), true)`，並依攻擊冷卻（約 500~600ms）執行 `bot.lookAt` 與 `bot.attack`。
- **防風箏與脫戰門檻**：若敵人死亡、距離超過 16 格、或 Bot 與主人距離被拉開超過 24 格，`Combat` 自動結束（釋放鎖），讓 `CatchUpFollow` 或 `NormalFollow` 重新接手。

### 6.4 驗收門檻 (Exit Criteria)
- [x] 跟隨主人途中生成一隻殭屍，Bot 立即中斷 `Follow`、自動切換背包中的劍、追擊並擊殺殭屍。
- [x] 殭屍死亡的下一輪 Tick，Bot 不需主人重新下令，自動恢復 `Follow` 回到主人身邊。
- [x] 遭遇怪物反擊時，若正在進食，`Combat (80)` 能立即中斷 `RoutineEat (60)` 並切換至武器。
- [x] 非 Owner 玩家攻擊機器人時，將其標記為敵對目標追擊 30 秒，超時或死亡自動脫戰。
- [x] Owner 攻擊機器人時，立即解除跟隨（切換為 `STAY` 模式），回打 1 下（最長 3 秒）後立即脫離戰鬥。
- [x] 伺服器未提供 `source` 參數時，藉由 4.5 格內玩家揮手事件（`entitySwingArm`）自動推斷攻擊者。

---

## Stage 7: 緊急逃跑功能 (Emergency Retreat)

### 7.1 階段目標
實作最高優先級（Priority 100）的候選點採樣撤退邏輯，支援「殘血（HP <= 6）或遭遇過多敵對生物（>= 3 隻）」雙因子觸發逃跑，並採樣大範圍內敵人最少、最安全的座標進行撤離，驗證「戰鬥中危險 → 立即中止揮劍與追擊 → 逃往敵少安全點 → 邊逃邊吃 → 脫險後恢復」的強制搶佔機制。

### 7.2 交付檔案清單
- 更新 `src/actions/navigation.ts`：新增 `Retreat` Action Adapter 與大範圍最少敵人安全點採樣演算法（`findSafestEscapePosition`）。
- 更新 `src/bt/subtrees/survival.ts`：實作急迫危險 Guard（殘血 `HP <= 6` 或周圍威脅 `>= 3` 隻）與 `Retreat` 請求（Priority 100，請求 `{MOVE, LOOK}`）。
- 更新 `src/policy.ts`：新增 `retreatMobCount: 3` 門檻。
- `test/unit/retreat.test.ts`：單元測試驗證逃跑候選點採樣（選敵最少處）、退避遲滯與鎖搶佔。

### 7.3 實作重點與限制
- **整組搶佔中止 Combat**：當 `Retreat (100)` 觸發時，雖然它只需要 `{MOVE, LOOK}`，但 `arbiter` 必須將整個 `Combat (80)` 中止（同時釋放 `MOVE, LOOK, HAND, INVENTORY`），**嚴禁發生「腳在逃跑、手還在回頭揮劍」的撕裂現象**。
- **大範圍敵少安全點採樣演算法**：以 Bot 為圓心、半徑 12 格採樣 16 個方位候選點，排除岩漿等地形危險，計算每個候選點周圍危險半徑內的敵方數量與最近敵人距離，優先選取「周圍敵人數量最少」且「距離最近敵人最遠」的安全座標設定 `new GoalNearXZ(x, z, 2.0)`。
- **雙因子觸發機制**：
  1. 殘血逃跑：`HP <= 6` 且 12 格內有敵對生物。
  2. 群怪包圍逃跑：12 格內敵對生物數量 `>= 3` 隻。
- **退出遲滯 (Exit Hysteresis)**：進入撤退後，必須滿足「所有威脅距離 `>= 18` 格」或「`HP >= 10` 且周圍無群怪」才退出 `Retreat`，避免剛跑出 12.1 格又立刻回頭送死。
- **邊逃邊吃連動**：`Retreat (100)` 搶佔 `MOVE, LOOK` 時，`EmergencyEat (90)` 可同時獲得 `{HAND, INVENTORY}`，達成雙通道邊逃跑邊吃補品回血。

### 7.4 驗收門檻 (Exit Criteria)
- [x] 戰鬥中將 Bot 血量扣至 6 以下或刷出群怪（>= 3 隻），`Combat` 在 100ms 內被強制 `cancel()`（停止攻擊與追擊），Bot 轉頭逃向周圍敵人最少的安全座標。
- [x] 逃跑期間沒有任何殘留的 `bot.attack` 或看向怪物的 `bot.lookAt` 被觸發。
- [x] 殘血逃跑時若持有食物，`EmergencyEat (90)` 正常觸發，邊跑邊吃回血。

---

## Stage 8: 指令系統重構與未知指令提示 (`!` 前綴規範化與 Command Unknown 回應)

### 8.1 階段目標
重構聊天指令解析模組（`src/commands.ts`），全面規範所有指令皆須以 `!` 作為前綴（例如 `!follow`、`!unfollow`、`!stop`、`!status`、`!state`），忽略未帶 `!` 的一般對話，並在主人發送未知的 `!` 開頭指令時，於聊天室明確回應 `command unknown`。

### 8.2 交付檔案清單
- 更新 `src/commands.ts`：更新 `parseCommand`，強制 `!` 前綴檢查，並回傳未知指令事件（`unknown_command`）。
- 更新 `src/bot.ts`：監聽指令解析結果，當收到未知 `!` 指令時，透過 `chat.enqueue('command unknown')` 回覆主人。
- 更新 `test/unit/commands.test.ts`（或 `test/unit/bt.test.ts`）：驗證一般訊息忽略、合法 `!command` 解析、未知 `!xxx` 回傳 `command unknown`。

### 8.3 實作重點與限制
- **嚴格前綴匹配**：僅處理以 `!` 開頭的字串（如 `!follow`）；普通聊天（如 `hello bot` 或 `follow me`）直接忽略不視為指令。
- **未知指令明確回覆**：主人發送如 `!jump`、`!dance` 等未支援的指令時，即刻於聊天室發送 `command unknown`，避免使用者誤以為指令已生效或機器人當機。
- **權限不變**：仍維持僅允許 Owner 發出的指令生效。

### 8.4 驗收門檻 (Exit Criteria)
- [ ] 發送 `!follow` 或 `!unfollow` 能正常切換機器人狀態。
- [ ] 發送未帶 `!` 的文字（如 `follow`），機器人不動作亦不回覆。
- [ ] 發送未知的 `!foo`，機器人在聊天室回覆 `command unknown`。

---

## Stage 9: 基地座標設定 (`!base` 指令與 Base 狀態管理)

### 9.1 階段目標
實作基地標記功能，當主人發送 `!base` 時，將主人當前座標（若主人可視）或機器人自身座標記錄為基地點（`world.base`），並在基地更新時標記重生點需重新尋找。

### 9.2 交付檔案清單
- 更新 `src/blackboard.ts`：`WorldState` 擴充 `base: Position | null`。
- 更新 `src/commands.ts`：新增 `!base` 指令解析。
- 更新 `src/bot.ts`：處理 `base` 指令事件，更新黑板 `world.base` 並於聊天室回應 `Base set to (X, Y, Z)`。
- 單元測試：驗證 `!base` 設定基地座標、聊天回覆與黑板資料結構。

### 9.3 實作重點與限制
- **座標解析容錯**：優先讀取可視之主人座標 `world.master.position`；若主人不在周圍或為無主人模式，退回使用機器人當前自身座標。
- **重新尋床聯動旗標**：若基地座標變更，設定 `bedNeedsRefresh = true`，使後續重生點模組能自動感知並更新床鋪。

### 9.4 驗收門檻 (Exit Criteria)
- [ ] 主人發送 `!base`，黑板 `world.base` 成功更新為主人當前座標。
- [ ] 機器人於聊天室回覆 `Base set to (X, Y, Z)`。

---

## Stage 10: 綜合狀態回報 (`!state` / `!status` 指令擴充)

### 10.1 階段目標
擴充狀態查詢指令，主人發送 `!state` 或 `!status` 時，在聊天室以結構化格式回報血量、飢餓度、基地座標、重生點座標、當前意圖模式、正在執行的動作、手持裝備與背包剩餘格數等關鍵數值。

### 10.2 交付檔案清單
- 更新 `src/commands.ts`：支援 `!state` 與 `!status`。
- 更新 `src/bot.ts`：在 `onStatus` 回調中整合豐富的狀態資訊。
- 單元測試：驗證狀態字串格式與數值完整性。

### 10.3 實作重點與限制
- **資訊豐富性與緊湊度**：避免多行刷頻（Minecraft 聊天室行數有限），以精簡格式輸出（例：`HP=20/20 Food=20 Mode=FOLLOW Base=(X,Y,Z) Spawn=(X,Y,Z) Weapon=iron_sword FreeSlots=24`）。

### 10.4 驗收門檻 (Exit Criteria)
- [ ] 發送 `!state` 或 `!status`，機器人能在聊天室完整回報上述關鍵數值。

---

## Stage 11: 單次導航前進 (`!come` 指令)

### 11.1 階段目標
實作單次前往主人當前位置的指令，抵達後立即停下轉為原地待命（`STAY`），不進入持續跟隨。

### 11.2 交付檔案清單
- 更新 `src/commands.ts`：新增 `!come` 指令解析。
- 更新 `src/actions/navigation.ts`：實作 `ComeOnce` 單次導航動作適配器（目標為靜態座標點，抵達門檻 2.0 格）。
- 更新 `src/bot.ts` 與行為樹：註冊 `ComeOnce`，抵達時將意圖模式切換為 `STAY` 並於聊天室回報 `Arrived at your location.`。
- 單元測試：驗證單次抵達後自動轉入 `STAY`，且不會持續跟隨主人移動。

### 11.3 實作重點與限制
- **靜態座標導航**：在接收指令當下固化主人座標，不使用動態追隨的 `GoalFollow`，避免主人走動時無限追趕。
- **可被覆蓋**：若在前進途中收到 `!follow`、`!stop` 或 `!return`，立即被新指令覆蓋。

### 11.4 驗收門檻 (Exit Criteria)
- [ ] 主人發送 `!come`，機器人前往主人發送指令時的座標。
- [ ] 抵達後機器人立即停下，模式變更為 `STAY`，不再跟隨主人。

---

## Stage 12: 長期持久任務：返航基地 (`!return` 模式與中斷恢復機制)

### 12.1 階段目標
實作長期持久的返航任務模式（`mode: 'RETURN'`）。當主人發送 `!return` 時，機器人導航返回基地或登記的重生點。若途中遭遇突發事件（如戰鬥 `Combat` 或殘血逃跑 `Retreat`），在中斷結束後能自動恢復繼續返回基地，直至真正抵達後才切換為 `STAY`。

### 12.2 交付檔案清單
- 更新 `src/commands.ts`：新增 `!return` 指令解析（`mode: 'RETURN'`）。
- 更新 `src/actions/navigation.ts`：實作 `ReturnToBase` 導航適配器（導向 `world.base` 或 `world.spawnPoint`）。
- 更新 `src/bt/subtrees/work.ts`：在行為樹中加入 `ReturnToBase` 子樹，設定於 `mode === 'RETURN'` 時啟動。
- 單元測試：驗證返航途中的戰鬥搶佔、戰後自動恢復返航，以及抵達後轉入 `STAY`。

### 12.3 實作重點與限制
- **長程任務持久性**：意圖保持為 `RETURN`，因此途中觸發 `Combat (80)` 或 `Retreat (100)` 僅是暫時搶佔資源；當威脅解除、戰鬥或逃跑結束後，行為樹重新 Tick 時因意圖仍為 `RETURN`，會無縫重新建立目標前往基地。
- **目的地優先順序**：`world.base` -> `world.spawnPoint`；若兩者皆無，聊天室提示 `No base or spawn point set!` 並恢復原模式。
- **終止條件**：
  1. 成功抵達基地（距離 <= 2.0 格），自動切換為 `STAY`，聊天室發送 `Arrived at base.`。
  2. 被主人新的明確指令覆蓋（如 `!follow`、`!come`、`!unfollow`、`!stop`）。

### 12.4 驗收門檻 (Exit Criteria)
- [ ] 主人發送 `!return`，機器人開始導航前往基地（或重生點）。
- [ ] 返航途中生成殭屍，機器人中斷返航進行交戰；擊殺殭屍後自動恢復前往基地。
- [ ] 返航途中可被 `!come` 或 `!follow` 隨時覆蓋。
- [ ] 抵達基地後自動切換為 `STAY` 待命。

---

## Stage 13: 自動重生點綁定 (自動尋床設定與逾時保護)

### 13.1 階段目標
實作自主低優先級（Priority 15）的重生點設定子樹。當無主人時搜尋最近床鋪；有主人且有 base 時，自動在基地周圍搜尋空床設定重生點。具備 30 秒逾時放棄與冷卻機制，並在主人更新 base 時自動觸發重新尋床。

### 13.2 交付檔案清單
- 更新 `src/blackboard.ts`：`WorldState` 擴充 `spawnPoint: Position | null`。
- 更新 `src/actions/navigation.ts`：實作 `SetSpawn` 動作適配器（走至床邊並右鍵/啟用床鋪以設置重生點）。
- 更新 `src/bt/subtrees/work.ts`：加入 `SetSpawn` 守衛與行為節點（Priority 15）。
- 單元測試：驗證尋床範圍判定、30 秒逾時放棄、base 座標變更時重新尋找。

### 13.3 實作重點與限制
- **低優先級空閒執行 (Priority 15)**：低於 `Follow (20)`、`Pickup (30)`、`Maintenance (60)`、`Combat (80)`、`Retreat (100)`，僅在無其他緊迫任務時執行。
- **搜尋範圍邏輯**：
  - 有主人且已設 `base`：以 `world.base` 為中心半徑 24 格內搜尋未佔用床鋪。
  - 無主人或無 base：以機器人當前位置為中心搜尋最近床鋪。
- **防卡死逾時與冷卻 (Fail-safe Timeout & Cooldown)**：
  - 動作最長執行 30 秒；若超過 30 秒無法抵達或點擊失敗，標記為 FAILURE 並進入 60 秒冷卻，避免反覆卡死在無法通達的床鋪。
  - 若主人發送 `!base` 更新了基地，立即重置冷卻，允許重新在基地周遭尋找新床鋪。

### 13.4 驗收門檻 (Exit Criteria)
- [ ] 設定 `!base` 後，機器人在空閒時自動走向基地周圍 24 格內的床鋪並設置重生點。
- [ ] 設置成功後，`world.spawnPoint` 記錄床鋪座標。
- [ ] 床鋪被牆壁封死無法抵達時，30 秒內自動放棄並進入冷卻，不阻礙其他任務。

---

## Stage 14: 綜合整合與端到端驗收測試 (Integration & Handoff Harness)

### 14.1 階段目標
建立自動化與實機整合測試腳本 (`test/integration/handoff-harness.ts`)，針對所有跨狀態搶佔、極端邊界與長時間運行穩定度進行最終驗收。

### 14.2 必測綜合情境清單 (End-to-End Verification Matrix)

| 測試編號 | 測試場景描述 | 預期行為與資源鎖轉移軌跡 |
| :--- | :--- | :--- |
| **E2E-01** | **Follow + Eat 並行與遇襲搶佔** | `Follow(20) + RoutineEat(60)` 並行 → 刷出殭屍 → 兩者同時被 `Combat(80)` 搶佔 → 停止進食、拔劍殺敵 → 殭屍死後恢復 `Follow(20) + RoutineEat(60)` 把飯吃完。 |
| **E2E-02** | **Combat → Retreat + EmergencyEat 雙重搶佔** | `Combat(80)` 交戰中 → 瞬間扣血至 4 → `Retreat(100)` 取得 `{MOVE, LOOK}`、`EmergencyEat(90)` 取得 `{HAND, INVENTORY}` → 邊跑邊吃回血至安全距離。 |
| **E2E-03** | **Return 長程任務中遇襲與戰後恢復** | 執行 `!return` 途中遭遇怪物 → `Combat(80)` 搶佔擊殺怪物 → 戰鬥結束後自動無縫恢復返回基地，抵達後切換為 `STAY`。 |
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