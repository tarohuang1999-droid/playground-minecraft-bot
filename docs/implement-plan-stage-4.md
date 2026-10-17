# Implementation Plan: Stage 4 - 農業自動化修正、成熟收割、作息睡眠與容器管理

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：
  - 必須先完成 **[Stage 3: 核心架構輕量化重構與 P1 穩定性修復](implement-plan-stage-3.md)**（基於 `TaskSessionManager`、`ActionRegistry`、`CommandController` 與已修復的 `NavigationExecutionBoundary` 開發本階段所有功能）。
  - [rule-typescript-coding.md](rules/rule-typescript-coding.md)（TypeScript 開發規範與 12 條鐵律）
  - [rule-testing.md](rules/rule-testing.md)（測試規範）

---

## 階段目錄 (Stage 4 Breakdown)

- **Stage 4.1: 夜晚自主回 Spawn 睡覺、床鋪設定 (`!setbed` / `SetBed`) 與起床作息 (Nightly Autonomous Sleep & Bed Setup)** *(已完成)*
- **Stage 4.2: 基礎放置隔離診斷與除錯指令 (`!placedirt`)** *(新增 - 測試 `placeBlock` 是否被 PaperMC / Client 阻擋)*
- **Stage 4.3: 多作物農事種植自動化修正與完成驗收 (`!farm`)**
- **Stage 4.4: 多作物熟成收割與自動補種 (`!harvest`)**
- **Stage 4.5: 命名箱子管理、損毀自動移除與物品存取 (`!box`)**
- **Stage 4.6: Stage 4 綜合整合與端到端驗收測試**

---

## Stage 4.1: 夜晚自主回 Spawn 睡覺、床鋪設定 (`!setbed` / `SetBed`) 與起床作息 (Nightly Autonomous Sleep & Bed Setup)

### 4.1.1 階段目標
1. **床鋪設定 (`!setbed` / `SetBed`)**：
   - 尋找周圍半徑 10 格內的可用床鋪（排除 `bedrock` 與被佔用的床）。
   - 若未找到床鋪，即時回覆 `沒看到`。
   - 若找到床鋪，設定為 Bot 出生點（`spawnPoint`），持久化至 `data/state.json`，在聊天室廣播 `Spawn point set to (x, y, z)`，並於距離 $\le 2.5$ 格內觸發右鍵綁定。
2. **夜晚自主回 Spawn 睡覺與起床作息 (`SleepAtBed`)**：
   - **出生點約束**：若未設定出生點（`spawnPoint === null`），嚴禁觸發睡覺！
   - 當 Bot 處於 `IDLE` 狀態且已設定出生點，於遊戲夜晚（`timeOfDay >= 12541 && timeOfDay <= 23458`）或雷雨天自主前往床鋪睡覺。
   - 睡眠中遭受攻擊或附近有威脅時立即呼叫 `bot.wake()`，由 `Combat` (80) 或 `Retreat` (100) 搶佔。
   - 天亮時自然甦醒，發送 `Good morning!`，並維持 `IDLE` 狀態。

### 4.1.2 規格與行為定義
- **觸發條件**：
  - 當前意圖模式為 `IDLE`（無其他進行中任務）。
  - **嚴格出生點檢查**：`world.spawnPoint !== null`。
  - 時間處於夜晚（`timeOfDay >= 12541 && timeOfDay <= 23458`）或雷雨天（`world.isRaining`）。
  - 周圍無敵對實體威脅且未受傷（`threats.length === 0 && !tookDamageRecently`）。
- **就寢與甦醒流程**：
  1. 觸發 `SleepAtBed`（所需資源 `['MOVE', 'LOOK', 'HAND']`，優先級 15）。
  2. 導航至床鋪旁（`GoalNear(bedPos, 1.8)`），到達（$\le 2.0$ 格）呼叫 `bot.sleep(bedBlock)`。
  3. **遇襲醒來**：睡眠中若受到傷害（`tookDamageRecently`）或周圍出現威脅，立即呼叫 `bot.wake()`，交由 `Combat (80)` 或 `Retreat (100)` 搶佔。
  4. **天亮醒來**：天亮時自動醒來並發送 `Good morning!`，維持 `IDLE`。

### 4.1.3 交付與修改檔案
- `src/actions/bed.ts`：實作 `SetBed` Action Adapter。
- `src/actions/sleep.ts`：實作 `SleepAtBed` Action Adapter。
- `src/perception.ts`：新增 `findNearbyBed(bot, maxDistance, center)`、支援 `timeOfDay`、`isRaining` 與 `isSleeping` 取樣。
- `src/blackboard.ts`：`WorldState` 擴充 `timeOfDay`、`isRaining`、`isSleeping` 欄位。
- `src/policy.ts`：註冊 `SetBed` 與 `SleepAtBed` 動作資源與優先級政策。
- `src/commands.ts` & `src/command-controller.ts`：解析並調度 `!setbed` 指令。
- `src/bt/subtrees/work.ts`：在 `work` 子樹掛載 `sleepAtBed` 守衛與行為節點。
- `test/unit/stage-4-1-sleep-bed.test.ts`：新增 10 項單元與整合測試驗證。

### 4.1.4 驗收門檻
- [x] `!setbed` 在半徑 10 格內無床時回覆 `沒看到`，有床時正確設定出生點並持久化。
- [x] 未設定出生點（`spawnPoint === null`）時絕對不觸發睡覺。
- [x] 白天不觸發睡覺；夜晚且 `IDLE` 且有出生點時自動走回床鋪入睡。
- [x] 睡覺中遭遇攻擊能立即呼叫 `bot.wake()` 並切換戰鬥/撤退。
- [x] 天亮時自然甦醒，發送 `Good morning!`，不卡死在睡眠狀態。

---

## Stage 4.2: 基礎放置隔離診斷與除錯指令 (`!placedirt`)

### 4.2.1 階段目標
完全隔離農事工作區、多種子檢查、長途巡邏與複雜視線計算，直接以最純粹的獨立指令 `!placedirt`，要求 Bot 手持泥土並在正前方地面放置一塊泥土，診斷 PaperMC 伺服器或 Mineflayer Client 端是否阻擋/鎖死 `placeBlock`。

### 4.2.2 規格與行為定義
- **指令語法**：`!placedirt`（或 `!place`）
- **執行流程**：
  1. 檢查背包中是否有 `dirt`（或 `grass_block`、`coarse_dirt` 等泥土類方塊），若無則 chat 回覆 `No dirt in inventory`。
  2. 手持泥土（`await bot.equip(dirtItem.type, 'hand')`）。
  3. 計算正前方地面方塊：依 Bot 當前 yaw 計算正前方 1 格的地面實體方塊（`refBlock`），且其上方 1 格為空氣。
  4. 呼叫 `await bot.placeBlock(refBlock, new Vec3(0, 1, 0))`。
  5. 捕捉結果：
     - 若成功：chat 回報 `Placed dirt successfully at (x, y, z)`。
     - 若失敗：chat 與 logger 完整輸出 `placeBlock failed: ${err.message}`（直接揭露 PaperMC 或 Client 端拋出的真實錯誤訊息）。

### 4.2.3 驗收門檻
- [ ] 下達 `!placedirt`，無泥土時 chat 提示 `No dirt in inventory`。
- [ ] 有泥土時，Bot 手持泥土並嘗試在正前方放置泥土方塊。
- [ ] 放置成功或失敗皆能輸出詳細日誌或錯誤原因，明確判定 PaperMC / Client 是否阻擋 `placeBlock`。

---

## Stage 4.3: 多作物農事種植自動化修正與完成驗收 (`!farm`)

### 4.3.1 階段目標
基於 Stage 3 重構後的 `TaskSessionManager` 與已解除 `placeBlock` 誤攔截的 `NavigationExecutionBoundary`，完善並修正多作物農事耕作（`!farm`）：檢查背包中可播種的種子，在集合點半徑 25 格內尋找空置耕地（`farmland`）種植，並修正播種成功驗證語義（`SR-10`）。

### 4.2.2 規格與修正重點
- **作物註冊表（Crop Registry）**：
  - 小麥：`wheat_seeds` $\to$ `wheat` (`age === 7`)。
  - 胡蘿蔔：`carrot` $\to$ `carrots` (`age === 7`)。
  - 馬鈴薯：`potato` $\to$ `potatoes` (`age === 7`)。
  - 甜菜根：`beetroot_seeds` $\to$ `beetroots` (`age === 3`)。
- **播種互動核心改進 (`activateBlock` on Farmland)**：
  - **根本問題**：Minecraft 玩家播種行為本質是**手拿種子對耕地按右鍵**。原先優先使用 `placeBlock(farmlandBlock, new Vec3(0, 1, 0))`，容易受 Mineflayer 的方塊放置碰撞視線與放置限制檢查阻礙，造成卡住或失敗。
  - **改善策略**：手持種子（`bot.equip(itemToEquip, 'hand')`）後，直接對耕地方塊頂面呼叫 `bot.activateBlock(farmlandBlock, new Vec3(0, 1, 0))` 進行右鍵點擊，模擬真實玩家右鍵點擊耕地播種，並配合 `bot.swingArm('right')`。
- **修正播種成功判定 (`SR-10`)**：
  - **移除過度樂觀判定**：在 `src/actions/farming.ts` 中，嚴禁將 `!aboveBlock`（區塊未載入或回傳 null）視為播種成功。
  - **正確判定標準**：播種後檢查耕地上方一格方塊名稱是否為對應的作物方塊（如 `wheat`, `carrots`, `potatoes`, `beetroots`），或確認背包對應種子數量確實減少。
- **防踐踏與邊界約束**：
  - 移動時 `allowParkour = false` 且禁止跳躍，避免踩壞耕地。
  - 範圍限制在 `rallyPoint` 水平距離 $\le 25.0$ 格內，單次工時上限 20 分鐘（`1,200,000` ms）。
- **結束與熔斷條件**：
  - 背包種子用盡、無空置耕地、或達到 20 分鐘時限時，透過 `TaskSessionManager` 通知 `Farming completed. Planted N crops.` 並切換為 `IDLE`。
  - 連續 5 次播種失敗時自動熔斷，通知主人並切換為 `IDLE`。

### 4.2.3 驗收門檻
- [ ] 播種前透過 `lookAt` 對準耕地頂面，並經由 `bot.blockAtCursor` 射線確認準心精確鎖定耕地方塊。
- [ ] 播種依據官方 `farmer.js` 採用手持種子 `placeBlock(farmlandBlock, new Vec3(0, 1, 0))` 進行放置。
- [ ] 無種子時下達 `!farm` 能即時警示並退出。
- [ ] `aboveBlock === null` 時不會誤判為播種成功，只有確認種上作物或種子消耗才計入 `plantedCount`。
- [ ] 播種移動過程中不觸發跳躍，不破壞耕地方塊。
- [ ] 種子用盡、無地可種或達 20 分鐘時限時發送完成訊息並切換為 `IDLE`（且可重複執行第二次 `!farm`）。

### 4.2.4 清除無效假 Mock 測試與測試真實性重構 (`SR-FakeTest`)
- **背景與痛點**：
  - 目前部分 Action 單元測試（如 `test/unit/farming-plant.test.ts`）將 `placeBlock`、`lookAt` 等底層 Minecraft 物理 I/O 實作為無條件成功的空函式（如 `async placeBlock() {}`），且 `blockAt` 無條件回傳假資料。
  - 這種測試無法反映真實 Minecraft 伺服器的物理碰撞、射線相交（Raycast）與放置拒絕，造成「測試 100% 通過但真機永遠失敗」的假象。
- **清除與重構規劃**：
  - [ ] 盤點並清理 Action 測試中所有只為了斷言「mock 函式被呼叫過」的無效假測試。
  - [ ] 單元測試聚焦於純邏輯覆蓋：Blackboard 演化、指令解析、Arbiter 優先級決策、TaskSessionManager 計數與防重入。
  - [ ] 物理交互（視線對準、方塊放置、睡覺）改由真機測試或高保真 Paper E2E 整合測試作為最終驗收門檻。


---

## Stage 4.3: 多作物熟成收割與自動補種 (`!harvest`)

### 4.3.1 階段目標
實作多種農作物的成熟辨識、安全收割、掉落物回收與原地即時補種（Harvest & Replant），受直徑 50 格（半徑 25 格）集合點範圍與 1 遊戲日（20 分鐘）工時限制。

### 4.3.2 規格與行為定義
- **指令語法**：
  - `!harvest`（或 `!reap`）：自動收割範圍內所有已成熟的作物（預設全部註冊作物，或優先小麥）。
  - `!harvest <crop>`：指定特定成熟作物收割（例如 `!harvest wheat`）。
- **成熟作物判斷標準（依 Crop Registry）**：
  - 小麥 `wheat`：`age === 7`；胡蘿蔔 `carrots`：`age === 7`；馬鈴薯 `potatoes`：`age === 7`；甜菜根 `beetroots`：`age === 3`。
  - 檢查方塊 metadata 或 properties 中的 `age` 屬性，未達成熟值的作物嚴禁挖掘。
- **作業管線（Pipeline）**：
  1. **導航接近**：移動至成熟作物旁（距離 $\le 2.5$ 格），保持耕地防踩踏設定。
  2. **採掘破壞**：呼叫 `bot.dig(cropBlock)` 破壞成熟作物。
  3. **原地補種（Replant）**：若背包有對應種子，破壞後立即在該耕地上重新播種。
  4. **物品拾取**：收割產生的掉落物由 `PickupItem` 自動撿入背包。
  5. **完成回報**：範圍內無成熟作物或達 20 分鐘工時後，透過 `TaskSessionManager` 回報收割數量並切換回 `IDLE`。

### 4.3.3 交付與修改檔案
- `src/perception.ts`：新增 `getMatureCrop(rallyPoint, maxRadius, cropType)`。
- `src/actions/farming.ts`：擴充 `harvestCrop` Action Adapter。
- `src/actions/index.ts`、`src/command-controller.ts`、`src/sessions/task-session-manager.ts`、`src/bt/subtrees/work.ts`：註冊 `HarvestCrop` 與 `!harvest` 指令。
- `test/unit/farming-harvest.test.ts`：單元測試驗證成熟度判斷、跳過未熟作物、採收與原地補種。

### 4.3.4 驗收門檻
- [ ] 僅收割成熟作物（age 7 / age 3），跳過未成熟作物。
- [ ] 若背包有種子，收割後能原地自動補種。
- [ ] 區域內無成熟作物或工時結束時回報成果並切換為 `IDLE`。

---

## Stage 4.4: 命名箱子管理、損毀自動移除與物品存取 (`!box`)

### 4.4.1 階段目標
實作專屬箱子管理系統：支援指令註冊自訂箱子 ID、監聽方塊破壞自動註銷、以及存入（deposit）與取出（withdraw）物品。

### 4.4.2 規格與行為定義
- **指令語法**：
  - `!box register <boxId> [x y z]`：若無座標則取 4 格內最近容器（`chest`, `trapped_chest`, `barrel`），寫入 `data/storage.json`，回覆 `Box "<boxId>" registered at (x, y, z).`。
  - `!box list`：列出所有已註冊箱子與座標。
  - `!box remove <boxId>`：手動註銷指定箱子。
  - `!box deposit <boxId> [filter|all]`：導航至箱子旁開啟容器，存入符合過濾條件之物品（`all` 時保留最佳武器、工具與基礎食物）。
  - `!box withdraw <boxId> <itemName> [count]`：從指定箱子取出指定物品與數量。
- **損毀自動移除機制**：
  - 監聽 `blockUpdate` 或在感知掃描時檢查已註冊箱子座標：若方塊變為 `air`（被破壞），自動從 `state-storage.ts` 移除該 `boxId` 並於聊天室發送警告。

### 4.4.3 交付與修改檔案
- `src/state-storage.ts`：擴充持久化結構支援 `boxes`。
- `src/actions/container.ts`：實作 `BoxDeposit` 與 `BoxWithdraw` Adapters（取消時確保呼叫 `container.close()`）。
- `src/commands.ts` & `src/command-controller.ts`：擴充 `!box` 子指令解析與調度。
- `test/unit/box-management.test.ts`：單元測試驗證箱子註冊、破壞自動移除、存入與取出。

### 4.4.4 驗收門檻
- [ ] `!box register / list / remove` 正確讀寫 `data/storage.json`。
- [ ] 箱子方塊被破壞時自動從註冊表移除並發出通知。
- [ ] `!box deposit` 與 `!box withdraw` 能正確導航至箱子、完成存取並關閉容器；被戰鬥搶佔時安全關閉容器不死鎖。

---

## Stage 4.5: Stage 4 綜合整合與端到端驗收測試

| 測試編號 | 測試場景描述 | 預期行為與驗收指標 |
| :--- | :--- | :--- |
| **S4-E2E-01** | **床鋪設定與夜晚就寢作息 (`!setbed` / `SleepAtBed`)** | 支援 `!setbed` 搜尋半徑 10 格床鋪並綁定；未設出生點不觸發睡眠；夜晚自動就寢、受襲即時醒來反擊、天亮甦醒問候。 |
| **S4-E2E-02** | **農田安全播種與防踩踏 (`!farm`)** | 在農田上播種，移動全程不跳躍，確認上方方塊變為作物或種子減少才計數，可連續多輪執行。 |
| **S4-E2E-03** | **成熟作物收割與原地補種 (`!harvest`)** | 混合不同生長階段作物，僅收割成熟作物（age 7 / age 3），並在原地重新播種。 |
| **S4-E2E-04** | **箱子註冊、破壞自動註銷與存取 (`!box`)** | 註冊 `box_01` 並存取物品；模擬箱子被挖除時自動移除 `box_01` 並發出提醒。 |
