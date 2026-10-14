# System Design Specification: Companion Bot Core (v1.0)

- **狀態**：Approved for Implementation (Phase 1)
- **目標範疇**：實作基於 **Reactive Behavior Tree (BT)**、**Blackboard** 與 **Preemptive Resource Arbiter (可搶佔資源仲裁器)** 的高等 NPC 底層控制架構。完成五項核心行為：**跟隨 (Follow)、自衛反擊 (Combat)、殘血撤退 (Retreat)、進食 (Eat)、鄰近撿拾 (Pickup) 與自動換裝 (Equip)**。
- **非目標範疇 (Out of Scope)**：本版本**不包含** LLM、JEV/KEV、Agent Memory 之介面、目錄或預留 Adapter。所有高階意圖由主人遊戲內指令（Chat/Whisper）驅動。

---

## 1. 系統分層與模組定義 (Module Definitions)

系統採用嚴格的單向資料流與四層職責分離架構：**World → Perception → Blackboard → Behavior Tree → Arbiter & Executor → Actions → World**。

| 模組分類 | 模組名稱 (檔案路徑) | 核心職責 | 狀態持有與邊界限制 |
| :--- | :--- | :--- | :--- |
| **生命週期** | `src/bot.js` | 初始化 Mineflayer 實例、載入 `pathfinder` 插件、維護 `sessionGeneration`（斷線/死亡重置編號）。 | 唯一允許直接綁定 Mineflayer 連線生命週期事件 (`spawn`, `death`, `end`) 的入口。 |
| **感知層** | `src/perception.js` | 監聽 Mineflayer 物理與世界事件，計算威脅距離、主人可視性、背包最佳裝備/食物、附近掉落物。 | **禁止**呼叫任何改變 Bot 狀態的 API（如 `lookAt`、`setGoal`）。只能輸出純資料物件（Plain Object）。 |
| **資料中樞** | `src/blackboard.js` | 維護 `world`、`intent`、`runtime` 三區狀態，每輪 Tick 產出具備 `revision` 的唯讀快照（Snapshot）。 | 跨層只傳遞 Entity ID、座標數值與枚舉字串，**嚴禁**將 Mineflayer 的 `Entity` 或 `Item` 實例放入快照供 BT 直接操作。 |
| **戰略入口** | `src/commands.js` | 解析主人聊天室指令，驗證白名單權限與參數合法性，更新 Blackboard 的 `intent` 分區。 | **禁止**直接觸發 Action 或修改 `runtime` 狀態；只負責寫入長期意圖（如 `FOLLOW_MASTER`）。 |
| **策略常數** | `src/policy.js` | 集中定義所有 Priority 權重、距離遲滯門檻（Hysteresis）、血量/飢餓閾值、冷卻時間（Cooldown）。 | 純常數與純函式（Pure Functions），無內部狀態。 |
| **戰術決策層** | `src/bt/nodes.js`<br>`src/bt/runner.js`<br>`src/bt/companion-tree.js`<br>`src/bt/subtrees/*.js` | 實作五種基礎節點語義；每輪讀取 Blackboard 快照，評估條件並輸出當輪「動作請求集合（Action Requests）」。 | **禁止**在 BT 節點內直接呼叫 Mineflayer API 或 `await` 非同步操作。BT 僅負責「聲明本輪想做什麼」。 |
| **執行與仲裁層** | `src/execution/arbiter.js`<br>`src/execution/executor.js` | `arbiter` 負責資源原子配置、優先級排序與搶佔裁決；`executor` 負責管理 `runId` 生命週期、Token 簽發、Fence 中斷與冷卻紀錄。 | 系統中唯一決定「誰擁有身體部位控制權」的模組。 |
| **動作適配層** | `src/actions/navigation.js`<br>`src/actions/combat.js`<br>`src/actions/inventory.js`<br>`src/actions/chat.js` | 將抽象動作請求轉譯為受控的 Mineflayer 底層 API 呼叫；實作統一的 `start / cancel` 介面與動態資源降級。 | 唯一允許接觸 `bot` 實例的執行層。所有非同步操作必須綁定並驗證 `token` 與 `sessionGeneration`。 |

---

## 2. 模組協作與單輪執行流 (Inter-Module Collaboration)

系統掛載於 Mineflayer 的 `physicsTick` (20Hz / 50ms)，透過分頻器以 **10Hz (每 2 個 physicsTick，即 100ms)** 執行一次主決策迴圈（若發生 `entityHurt` 等緊急事件，可標記 `urgentTickRequested` 於下一個 `physicsTick` 立即執行，但**嚴禁同步重入**正在執行中的 Tick）。

### 單輪 Tick 嚴格執行順序 (The 5-Step Tick Pipeline)

1. **Drain Event Queue (消化非同步佇列)**：
   - 收集過去 100ms 內由 `perception`、`commands` 及 `executor`（動作完成/失敗通知）推入佇列的事件，批次更新至 Blackboard 的 `world`、`intent`、`runtime` 內部狀態。
2. **Freeze Snapshot (拍下狀態快照)**：
   - `blackboard` 遞增 `revision`，生成當輪不可變（Immutable / Shallow-Frozen）的狀態快照。本輪所有 BT 節點與 Arbiter 讀取的皆為同一份快照，杜絕遍歷中途狀態變異。
3. **Tick Behavior Tree (遍歷行為樹收集請求)**：
   - 從根節點 `Parallel` 開始向下 `tick(snapshot)`。
   - 主要行為子樹（Survival / Combat / Work）與身體維護子樹（Maintenance）各自評估，最終處於活動狀態的 `Action` 節點不會直接操作 Bot，而是向本輪的 `RequestCollector` 提交 `ActionRequest`：
     `{ nodeId, runId, actionType, targetId, requiredResources, priority, params }`。
   - 若某分支在 `ReactiveSelector` 或 `Guard` 切換時被放棄，對舊子樹呼叫 `halt()`，使其不再提交本輪請求。
4. **Reconcile Resources (資源仲裁與搶佔裁決)**：
   - `arbiter` 接收本輪所有 `ActionRequest`：
     1. **撤銷未續約者**：上一輪持有資源、但本輪未再提交相同 `runId` 請求的動作，標記為需取消（Cancel）。
     2. **穩定排序**：將本輪請求依 `priority` 由高至低排序；同優先級者，「已持有資源的既有 `runId`」優先於新請求，避免同級抖動（Thrashing）。
     3. **整組原子配置（All-or-Nothing）**：依序檢查請求所需的 `requiredResources`（Set）是否與更高優先級的勝者重疊。無重疊者獲選為本輪勝者（Winners）；有重疊者無法啟動（維持 `RUNNING` 等待或失敗），**嚴禁部分取得資源（Partial Lock）**。
5. **Execute & Fence (執行新動作與圍欄清理)**：
   - **Step 5a (取消與圍欄)**：針對被搶佔或撤回的舊 `runId`，`executor` 立即遞增/作廢其 `token`，同步呼叫該 Action Adapter 的 `cancel()` 方法發出底層停止指令（Control-Plane Fence），並將資源狀態轉為 `stopping`（保留 1 個 `physicsTick` 即 50ms 的硬體緩衝期，不死等懸空 Promise）。
   - **Step 5b (啟動與續行)**：針對所有所需資源皆處於 `free` 狀態的勝者，若為新 `runId` 則簽發新 `token` 並呼叫 Adapter 的 `start(ctx)`；若為既有 `runId` 則呼叫 `update(ctx)`（僅在目標改變時更新，不重複初始化）。

---

## 3. JavaScript 技術選型與特定問題解決方案 (JS Technical Solutions)

專案統一使用 **Node.js (CommonJS)**，不引入 TypeScript 編譯鏈或外部行為樹框架，利用原生 JS 語言特性解決以下工程難題：

| 核心工程問題 | 採用的 JavaScript 技術與設計模式 | 具體實作機制 |
| :--- | :--- | :--- |
| **1. 第三方 API 懸空 Promise 導致鎖死 (Dangling Promises)** | **Monotonic Fencing Token + Session Generation + Control-Plane Fence** | 放棄「等待 Promise `settled` 才釋放鎖」的設計。每次授權產生唯一遞增整數 `token`。當 `cancel()` 被呼叫時，同步執行底層中斷（如 `deactivateItem()`），等 **1 個 `physicsTick` (50ms)** 後即強制將資源釋放給新 Owner。舊 Promise 內部所有 `.then/.catch` 與 `await` 恢復後，第一行必須檢查 `if (!ctx.isTokenValid()) return;`，直接靜默丟棄過期回呼。 |
| **2. 多 Bot 實例狀態污染與封裝** | **Factory Functions + Closures (工廠函式與閉包)** | 禁用 `class` 繼承鏈與全域單例（Singleton）。所有核心模組（`createBlackboard`, `createArbiter`, `createExecutor`, `createTree`）皆以工廠函式建立，將 `Map`、`Set` 等私有狀態封裝於 Closure 內，僅暴露契約方法。 |
| **3. BT 遍歷中途被非同步事件竄改狀態** | **Event Queue Buffering + `Object.freeze()` 快照** | 所有 Mineflayer 事件監聽器（`entityHurt`, `chat`, `itemDrop`）禁止直接修改 BT 讀取的變數，只能將事件 push 進緩衝陣列。每輪 Tick 開頭統一歸併並透過淺層複製與 `Object.freeze()` 產出當輪唯讀快照。 |
| **4. 邊界條件抖動 (站立/移動、戰鬥/逃跑反覆切換)** | **Schmitt Trigger Hysteresis (史密特觸發器雙門檻遲滯) + Cooldown Map** | 在 `policy.js` 與子樹 Guard 中實作雙門檻：例如 Follow 在距離 `> 6` 格時觸發（Enter Threshold），但一旦處於 `RUNNING`，必須靠近至 `< 3` 格才回傳 `SUCCESS`（Exit Threshold）；Retreat 在 `HP < 7` 觸發，需拉開距離且 `HP >= 10`（或脫離威脅 5 秒）才解除。不可達目標寫入 `Map<targetId, retryAfterTimestamp>` 進行冷卻。 |
| **5. 換武器與攻擊之間的資源鎖交接空窗** | **Composite Action Scope (複合動作狀態機)** | 不在 BT 層用兩個獨立 Action 節點處理「換刀」與「揮刀」。在 `actions/combat.js` 內部以單一 `runId` 持有 `{MOVE, LOOK, HAND, INVENTORY}`，內部自行維護微狀態（`EQUIPPING -> ENGAGING`），確保鎖不會在換完刀的瞬間被其他動作搶走。 |
| **6. 邊走邊吃 vs. 尋路挖方塊的資源衝突** | **Dynamic Capability Downgrade (執行期動態能力降級)** | `navigation.js` 平時只請求 `{MOVE, LOOK}`。當 `arbiter` 發現 `HAND` 與 `INVENTORY` 空閒時，通知導航開啟 `movements.canDig = true`；一旦 `Eat` 或 `Equip` 申請並取得 `{HAND, INVENTORY}` 鎖，`executor` 同步將 `movements.canDig = false` 並中止當前挖掘，實現無縫「邊純走路邊吃飯」。 |

---

## 4. 行為樹架構與資源鎖配置表 (BT & Resource Policy)

### 4.1 資源通道定義 (Resource Channels)
系統共定義 5 個互斥資源通道：
- `MOVE`：雙腿位移與尋路控制權。
- `LOOK`：頭部視角控制權。
- `HAND`：主/副手揮動、使用物品（進食/舉盾/挖掘）控制權。
- `INVENTORY`：快捷欄切換與裝備穿脫控制權。
- `VOICE`：聊天室發言控制權（由 `chat.js` 透過獨立速率限制佇列管理，不阻塞身體動作）。

### 4.2 優先級與資源需求矩陣 (`src/policy.js`)

| 動作名稱 (Action Scope) | 所屬子樹 | 請求資源集合 (`requiredResources`) | Priority | 進入門檻 (Enter) | 退出條件 (Exit) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Retreat** (緊急撤退) | `survival.js` | `MOVE`, `LOOK` | **100** | `HP <= 6` 且 12 格內有威脅 | 距離威脅 `>= 18` 格且持續安全 3 秒，或無威脅 |
| **EmergencyEat** (緊急進食) | `maintenance.js` | `HAND`, `INVENTORY` | **90** | `HP <= 10` 或 `Food <= 6`，且背包有食物 | 進食完成，或背包無食物 |
| **Combat** (自衛含備武) | `combat.js` | `MOVE`, `LOOK`, `HAND`, `INVENTORY` | **80** | 8 格內有敵對生物，或剛受近戰攻擊 | 目標死亡/消失、追擊距離 `> 16` 格、或與主人距離 `> 24` 格 |
| **RoutineEat** (一般進食) | `maintenance.js` | `HAND`, `INVENTORY` | **60** | `Food <= 16` 且背包有食物 | `Food >= 20` 或進食完成 |
| **EquipBest** (自動換裝) | `maintenance.js` | `HAND`, `INVENTORY` | **50** | 無急迫危險，且背包有護甲值更高之裝備 | 穿戴完成 |
| **CatchUpFollow** (防落隊急追) | `work.js` | `MOVE`, `LOOK` | **40** | 主人距離 `> 16` 格 | 主人距離 `<= 6` 格 |
| **PickupItem** (鄰近撿拾) | `work.js` | `MOVE`, `LOOK` | **30** | 安全、主人距離 `< 10` 格、5 格內有掉落物且未在冷卻中 | 抵達掉落物座標（被動拾取）或逾時 4 秒（寫入冷卻） |
| **NormalFollow** (一般跟隨) | `work.js` | `MOVE`, `LOOK` | **20** | Intent 為 `FOLLOW` 且主人距離 `> 5` 格 | 主人距離 `<= 3` 格 |
| **Idle** (待機) | 預設葉節點 | *(無資源需求)* | **0** | 以上皆不成立 | 隨時可被取代 |

*註：當 `Retreat (100)` 與 `EmergencyEat (90)` 同時觸發時，兩者會共同搶佔 `Combat (80)`，分別取得 `{MOVE, LOOK}` 與 `{HAND, INVENTORY}`，自然形成「邊逃跑邊吃東西」的並行行為。*

---

## 5. Mineflayer API 與插件取捨規範 (API Retention, Modification & Deprecation)

為了徹底消除第三方插件內部的非同步黑盒與計時器洩漏，所有 Coding Agent 必須嚴格遵守以下 API 使用清單：

### 5.1 完全棄用與禁止引入 (Strictly Prohibited / Deprecated)
1. **禁止使用 `mineflayer-pvp` 插件**：
   - **原因**：其內部 `attemptAttack` 延遲佇列與視角計時器無法在 `stop()` 時同步清除，會破壞資源鎖隔離。
   - **替代方案**：於 `src/actions/combat.js` 完全自製（詳見 5.3）。
2. **禁止使用 `mineflayer-statemachine` 或 `mistreevous`**：
   - **原因**：使用 `src/bt/nodes.js` 自建的 5 個輕量節點以確保 100% 掌控 `ReactiveSelector` 與 `halt()` 語義。
3. **禁止呼叫 `bot.pathfinder.goto(goal)` (Promise API)**：
   - **原因**：`goto.js` 內部綁定大量一次性事件監聽器，在頻繁搶佔與重設目標時極易發生 Promise 競態與 Listener 洩漏。
4. **禁止呼叫 `bot.pathfinder.stop()`**：
   - **原因**：`stop()` 僅設定內部旗標等待下次物理更新，非同步停止。

### 5.2 保留但受嚴格封裝限制 (Retained with Adapter Restrictions)
1. **`mineflayer-pathfinder` 的聲明式 API**：
   - **僅允許**在 `src/actions/navigation.js` 與 `combat.js` 中使用 `bot.pathfinder.setGoal(goal, dynamic)` 與 `bot.pathfinder.setMovements(movements)`。
   - **強制取消方式**：當失去 `MOVE` 鎖時，**唯一合法的停止呼叫為 `bot.pathfinder.setGoal(null)`**，它會同步清空目標並立刻釋放控制態 (`clearControlStates()`)。
2. **`bot.consume()` 與 `bot.deactivateItem()`**：
   - **僅允許**在 `src/actions/inventory.js` 中使用。
   - **強制取消方式**：當 `Eat` 被搶佔時，呼叫 `bot.deactivateItem()`。由於 Mineflayer 底層不會立即 reject 懸空的 `consume()` Promise，Adapter **不得 `await` 舊 `consume()` 結束才回報取消完成**；必須透過 `token` 屏蔽舊 Promise 後續的結果，並在 1 個 `physicsTick` 後釋放 `HAND` 鎖。
3. **`bot.equip(item, destination)`**：
   - 允許在 `inventory.js` 與 `combat.js` 中使用。每次 `await bot.equip(...)` 前後都必須驗證 `ctx.isTokenValid()`。

### 5.3 必須自製重寫的邏輯 (Must Rewrite from Scratch)
1. **原生受控戰鬥 (`src/actions/combat.js`)**：
   - 取得 `{MOVE, LOOK, HAND, INVENTORY}` 後：
     1. 檢查背包最佳近戰武器（劍/斧），若未手持則呼叫 `bot.equip(weapon, 'hand')`。
     2. 設定 `bot.pathfinder.setGoal(new GoalFollow(targetEntity, 2.5), true)`。
     3. 在每次 Tick 檢查中，若距離目標 `<= 3.2` 格且武器冷卻完畢（依攻擊速度約 500ms~600ms），依序執行 `bot.lookAt(targetEntity.position.offset(0, targetEntity.height * 0.85, 0), true)` 與 `bot.attack(targetEntity)`。
     4. 被搶佔呼叫 `cancel()` 時：同步執行 `bot.pathfinder.setGoal(null)` 並清除內部攻擊計時器，零殘留回呼。
2. **候選點採樣撤退 (`src/actions/navigation.js` - `Retreat`)**：
   - 不可單純使用無腦直線倒退（易卡牆角或掉懸崖）。
   - 以自身為中心、半徑 8~12 格圓周採樣 8 個候選方位點，過濾掉「與威脅夾角過小（`< 90度`）」、「腳下為岩漿/深淵/水」的危險點，挑選遠離所有附近敵對生物分數最高之安全座標，傳入 `new GoalXZ(safeX, safeZ)`。

---

## 6. 目錄結構與檔案職責 (Code Structure)

```text
project-root/
├── package.json                  # 僅依賴 mineflayer, mineflayer-pathfinder, vec3
├── src/
│   ├── bot.js                    # Bot 啟動、插件掛載、sessionGeneration 管理
│   ├── policy.js                 # Priority 常數、遲滯門檻、Cooldown 時間設定
│   ├── blackboard.js             # createBlackboard()：world/intent/runtime 分區與快照凍結
│   ├── perception.js             # createPerception()：世界感測與事件轉譯 (純資料輸出)
│   ├── commands.js               # createCommandHandler()：主人指令解析與 Intent 更新
│   ├── bt/
│   │   ├── nodes.js              # 五種核心節點：ReactiveSelector, Sequence, Parallel, Guard, Action
│   │   ├── runner.js             # 10Hz 分頻器、事件佇列排空、5-Step Tick Pipeline 協調器
│   │   ├── companion-tree.js     # 組裝頂層 Parallel 與各子樹
│   │   └── subtrees/
│   │       ├── survival.js       # 急迫危險判斷與 Retreat 請求
│   │       ├── combat.js         # 自衛條件判斷與 Combat 請求
│   │       ├── work.js           # 防落隊、鄰近撿拾、一般跟隨與待機
│   │       └── maintenance.js    # 緊急/一般進食、自動換裝與待機
│   ├── execution/
│   │   ├── arbiter.js            # createArbiter()：穩定排序、All-or-Nothing 資源配置、搶佔計算
│   │   └── executor.js           # createExecutor()：runId/token 管理、50ms Fence 交接、Cooldown 紀錄
│   └── actions/
│       ├── navigation.js         # Follow, Retreat, Pickup 實作與動態 canDig 切換
│       ├── combat.js             # 自製備武 + 追擊 + 冷卻揮砍 (零 mineflayer-pvp 依賴)
│       ├── inventory.js          # Eat (含懸空 Promise 隔離), Equip 實作
│       └── chat.js               # VOICE 資源佇列與節流發言
└── test/
    ├── unit/
    │   ├── bt-nodes.test.js      # 測試五種節點語義、halt 重置、runId 延續性
    │   ├── arbiter.test.js       # 測試整組取鎖、部分衝突拒絕、同級不抖動、搶佔觸發
    │   └── executor-fence.test.js# 使用 Fake Action 測試懸空 Promise 被 Token 隔離與 50ms 交接
    └── integration/
        └── handoff-harness.js    # 針對 Paper 伺服器的三項實機交接測試腳本