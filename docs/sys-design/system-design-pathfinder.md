# System Design Specification: Advanced Navigation Engine (Pathfinder & Bug Algorithm Hybrid)

- **狀態**：Proposal & Design Review
- **目標範疇**：針對 Companion Bot 中長距離導航卡頓、連續高牆/懸崖阻絕、門框與實體微卡頓問題，設計一套結合「外層蟲形演算法（Bug Algorithm Macro Planner）」與「內層白名單破障/搭橋 A* 導航（Whitelisted A* Micro Executor）」的雙層混合導航引擎。
- **核心設計原則**：
  - **KISS & Pragmatic Design**：不拋棄 `mineflayer-pathfinder` 原生能力，以巨觀狀態機控制中繼點（Waypoint），讓 A* 專注於 10~20 格局部最佳解。
  - **安全破障與搭橋 (Safe Dig & Place)**：嚴格限制方塊白名單，嚴禁破壞玩家建築結構、礦物或珍貴建材。
  - **防死鎖與失敗記憶 (Failure Memory & Anti-Repeat)**：繞路 3 次無效時及時放棄並回報主人，記錄失敗座標與繞行方向，避免無限卡死於死胡同。

---

## 一、 現狀問題剖析 (Problem Statement & Root Causes)

1. **局部微卡頓 (Micro-Stuck & Entity Collision)**：
   - 機器人通行門框邊緣、方塊小轉角或遭遇動物（牛、羊、村民等實體推擠）時，底層尋路速度驟降至 0。
   - 由於路徑仍在 A* 規律內，機器人未被判定為脫軌，造成短暫卡住或原地踏步；此時只需進行 0.5 格微小側移、輕微角度調整或跳躍即可順暢脫困。
2. **中長距離宏觀巨障 (Macro Obstruction & Cliffs)**：
   - 遇到連續 3 格以上高牆、大型洞窟天塹或不可逾越的懸崖時，底層 A* 演算法因探索半徑（Search Radius）限制或算力保護，直接回傳 `noPath` 或陷入局部停滯。
   - 目前機制僅每 1.5 秒反覆在原地重設相同目標，導致在牆前無限重算直至 30 秒逾時。
3. **無受控破障能力 (All-or-Nothing Digging Vulnerability)**：
   - 過去為防止機器人挖穿主人房屋或掉落岩漿，全域設定 `canDig = false`。
   - 這導致只要路上有一顆懸空的泥土方塊或阻擋視線的樹葉，機器人便完全無法前進。

---

## 二、 雙層混合導航架構 (Two-Tier Hybrid Architecture)

本設計採用「巨觀蟲形規劃器（外層 Macro）」+「微觀 A* 執行器（內層 Micro）」的職責分離架構：

```
+-----------------------------------------------------------------------------+
|                         Navigation Adapter (Body Plane)                     |
|                                                                             |
|   +---------------------------------------------------------------------+   |
|   |             Macro Layer: Bug Algorithm State Machine                |   |
|   |                                                                     |   |
|   |   [DIRECT_TRANSIT]  --(Obstacle / Stalled)-->  [MICRO_UNSTUCK]     |   |
|   |         ^                                             |             |   |
|   |         | (Clear / m-line reached)            (Still blocked)       |   |
|   |         |                                             v             |   |
|   |   [RESUME_GOAL]     <--(Waypoint reached)--   [WAYPOINT_DETOUR]     |   |
|   |                                                       |             |   |
|   |                                                 (3x Failed)         |   |
|   |                                                       v             |   |
|   |                                               [BLOCKED_REPORT]      |   |
|   +---------------------------------------------------------------------+   |
|                                  | Target: Waypoint / Final Goal            |
|                                  v                                          |
|   +---------------------------------------------------------------------+   |
|   |        Micro Layer: Mineflayer Pathfinder with Whitelist Dig/Place  |   |
|   |                                                                     |   |
|   |   - Movements: canDig (whitelisted), allowPlace (whitelisted)       |   |
|   |   - Collision index, door opening, ladder climbing                  |   |
|   +---------------------------------------------------------------------+   |
+-----------------------------------------------------------------------------+
```

---

## 三、 外層：蟲形演算法狀態機 (Bug Algorithm Macro Planner)

蟲形演算法（Bug 0 / Bug 2 混合型態）以極低算力處理宏觀障礙：

### 1. 核心狀態轉移
* **狀態 1：直行推進 (`DIRECT_TRANSIT`)**
  * 機器人將 A* 目標設為最終目的地（`FinalGoal`）。
  * 同步啟用前方 10 格射線檢測（`checkObstacleAhead`）。
  * 若無障礙且 A* 正常前進，持續維持此狀態。
* **狀態 2：微卡頓微調 (`MICRO_UNSTUCK`)**
  * 觸發條件：`isCollidedHorizontally` 持續超過 400ms 且位移 < 0.15 格，或遭遇非敵對實體阻擋。
  * 動作：暫停 A*，執行 0.5 秒小幅側向偏轉（左右 45 度微步前進或短暫跳躍）。
  * 退出條件：
    - 若位移恢復，立即回歸 `DIRECT_TRANSIT`。
    - 若微調 2 次仍無法通行，確認為大型實體障礙，升級轉入 `WAYPOINT_DETOUR`。
* **狀態 3：沿牆繞行 (`WAYPOINT_DETOUR`)**
  * 觸發條件：前方 10 格檢測到不可翻越巨障、懸崖，或 `MICRO_UNSTUCK` 失敗。
  * 繞行中繼點計算（`calculateDetourWaypoint`）：
    1. 取得障礙物法向量與當前前進方向。
    2. 參考歷史失敗記錄（`FailureMemory`），優先選擇未失敗過的側向（左側或右側）。
    3. 向側向展開 6~10 格，尋找高度落差 <= 2 格之安全地面作為中繼點 `W`。
    4. 將 A* 目標暫時切換為 `GoalNear(W.x, W.y, W.z, 1.5)`。
* **狀態 4：脫困離開條件 (`Leave Condition`)**
  * 機器人成功抵達中繼點 `W`。
  * 重新朝向最終目的地做 10 格射線檢測；若前方視線已無遮擋，或當前座標已回到「原本直行基準線（m-line）」且與終點距離比撞牆點更近。
  * 退出繞行，將 A* 目標切回 `FinalGoal`。
* **狀態 5：三次無效中斷回報 (`BLOCKED_REPORT`)**
  * 判定邏輯：連續執行 3 次中繼點繞行後，機器人與最終終點的距離縮短量皆小於 2.0 格（$\Delta d < 2.0$）。
  * 行為：
    1. 終止導航適配器，釋放身體控制權（`MOVE`, `LOOK`）。
    2. 記錄該障礙物區域為 120 秒禁行區。
    3. 意圖自動切換為 `STAY`，並向主人發送告警回報：
       `Path obstructed: 3 detour attempts failed. Say !continue to retry.`。

---

## 四、 內層：白名單受控 A* 尋路 (Whitelisted Dig & Place)

底層直接善用 `mineflayer-pathfinder` 的 `Movements` 運算，但透過嚴格白名單與動態資源降級予以約束：

### 1. 挖掘白名單 (`DIG_WHITELIST`)
僅允許挖掘常見、軟質、非結構性的阻擋方塊：
* 泥土類：`dirt`, `grass_block`, `coarse_dirt`, `podzol`, `mud`
* 重力類：`sand`, `red_sand`, `gravel`
* 植被類：`oak_leaves`, `birch_leaves`, `spruce_leaves`, `jungle_leaves`, `acacia_leaves`, `dark_oak_leaves`, `mangrove_leaves`, `cherry_leaves`, `azalea_leaves`, `vine`
* 雜質石類：`cobblestone`（僅在無工具時允許空手慢慢敲或消耗木鎬破障）
* **嚴禁挖掘項目**：所有礦石、木板、原木、熔爐、箱子、工作台、門、床、黑曜石、基岩等玩家結構方塊。

### 2. 搭建白名單 (`PLACE_WHITELIST`)
僅在橫跨斷崖或攀爬小階梯時允許鋪設：
* 允許方塊：`cobblestone`, `dirt`
* 檢查前提：`bot.inventory` 內必須存在該物品，且數量 $\ge 1$。
* 嚴禁消耗：礦物磚、木板、工作台或稀有建築建材。

### 3. 資源通道連動與動態降級
* `canDig` 與 `allowPlace` 需要使用機器人的手部（`HAND` 通道）。
* 若當前 Tick 中，高優先級動作（如 `Combat (80)`、`EmergencyEat (90)`、`RoutineEat (60)`）鎖定了 `HAND` 通道，導航適配器在當輪必須強制將 `movements.canDig = false` 與 `movements.allowPlace = false`，嚴禁與進食或揮劍動作搶奪主手。

---

## 五、 失敗記憶與指令互動機制 (Failure Memory & Master Interaction)

為了防止機器人在相同地形無限重複失敗，建立輕量記憶與主人覆寫指令：

### 1. 障礙失敗記錄器 (`ObstacleMemory`)
* 資料結構：
  ```typescript
  interface FailedDetourRecord {
    obstaclePos: { x: number; y: number; z: number };
    failedSide: 'left' | 'right';
    timestamp: number;
    ttlMs: number; // 預設 60,000ms ~ 120,000ms
  }
  ```
* 查詢邏輯：計算繞行側向時，比對半徑 8 格內是否存在有效失敗記錄；若左側曾失敗，則強制選擇右側，反之亦然。

### 2. 主人介入指令 (`!continue`)
* 當機器人因 3 次繞行失敗進入 `BLOCKED_REPORT` 並停留在 `STAY` 時：
  - 主人發送 `!continue`：
    1. 機器人恢復剛才被中斷的任務（如繼續返回基地 `!return` 或前往主人位置 `!come`）。
    2. 重置 3 次失敗計數器。
    3. 放大繞行展開步長（由原本 6 格擴大至 12 格），嘗試大範圍遠程繞道。
  - 主人下達新指令（如 `!follow` 或 `!come`）：
    1. 立即清除舊導航狀態，以新指令為最高優先級執行。

---

## 六、 驗收門檻與測試規劃 (Exit Criteria & Test Plan)

1. **單元測試 (`test/unit/pathfinder-bug.test.ts`)**：
   - 驗證前方 10 格射線檢測障礙物能準確識別巨牆與斷崖。
   - 驗證白名單挖掘判定：`dirt` 可挖掘，`diamond_ore` 與 `oak_door` 嚴格拒絕。
   - 驗證搭橋白名單：背包有 `cobblestone` 時啟用，無建材時關閉 `allowPlace`。
   - 驗證 3 次無效繞行檢測，達到 3 次時正確觸發回報並終止動作。
   - 驗證 `FailureMemory` 記錄失敗側向，下一次繞行自動選擇相反方向。
2. **整合測試**：
   - 模擬連續 4 格高牆阻擋，機器人自動向側邊取中繼點成功繞過障礙。
   - 模擬微卡頓情境，機器人透過微幅側移在 1 秒內自動脫困。
   - 模擬死胡同地形，機器人嘗試 3 次後主動停下並於聊天室發送 `Path obstructed...`。
