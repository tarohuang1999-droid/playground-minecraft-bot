# Implementation Plan: Stage 2 - 生存物資採集、自主狩獵、農業自動化與容器配置管理

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：動工前請先閱讀：
  - `docs/sys-design/system-design-v1.1.md`（核心架構、Blackboard Schema、Arbiter 仲裁規範）
  - `docs/implement-plan-stage-1.md`（Stage 1 基礎設施、執行器 fence、導航與戰鬥基底）
  - `docs/rules/rule-typescript-coding.md`（TypeScript 開發規範）
- **核心開發原則**：
  1. **KISS & YAGNI 原則**：專注於指定指令與功能，避免不必要的過度抽象或深層狀態機；善用標準庫與 Mineflayer 現有能力。
  2. **有界活動範圍約束**：所有範圍任務（`!hunt`、`!farm`、`!harvest`）以指令觸發時的座標為「暫時集合地（Temporary Rally Point）」，嚴格限制在直徑 50 格（即以集合地為中心半徑 25 格，橫向距離 $\le 25$ 格）之內，禁止無窮追逐離開工作區域。
  3. **工時時限控制（Shift Limit）**：`!farm` 與 `!hunt` 必須具備工作時長上限，單次執行時間**不得超過遊戲中的一天（1 In-game Day = 24,000 ticks = 20 分鐘 = 1,200 秒）**；超時後自動返回集合地並切換回待命狀態。
  4. **資源仲裁一致性**：所有獵殺、播種、收割與容器存取行為皆需透過 Arbiter 申請資源通道（通常為 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`），並服從 `Combat (80)`、`EmergencyEat (90)`、`Retreat (100)` 的高優先級生存搶佔。
  5. **農地保護**：在耕地（Farmland）上作業與移動時，關閉跳躍（`allowParkour = false`，禁止 jump 動作），防止將耕地踩踏破壞為泥土方塊。
  6. **集中式配置管理**：所有魔法數字、距離門檻、超時時間與白名單抽離至 `src/config/` 分類模組管理。

---

## 階段目錄 (Stage 2 Breakdown)

- **Stage 2.0: 配置參數模組化與集中管理 (`src/config/`)**
- **Stage 2.1: 狀態清單增強與正則過濾 (`!state [regex]`)**
- **Stage 2.2: 集合地錨定、工時限制與自主動物狩獵 (`!hunt`)**
- **Stage 2.3: 多作物農事種植自動化與工時限制 (`!farm`)**
- **Stage 2.4: 多作物熟成收割與自動補種 (`!harvest`)**
- **Stage 2.5: 夜晚自主回 Spawn 睡覺與起床作息 (Nightly Autonomous Sleep)**
- **Stage 2.6: 命名箱子管理、損毀自動移除與物品存取 (`!box`)**
- **Stage 2.7: Stage 2 綜合整合與端到端驗收測試**

---

## Stage 2.0: 配置參數模組化與集中管理 (`src/config/`)

### 2.0.1 階段目標
將分散於 `src/policy.ts`、`src/actions/navigation.ts`、`src/logger.ts` 等模組中的常數、閾值與各項重要參數分類抽離至 `src/config/`，以功能領域劃分獨立配置檔案，並於 `src/config/index.ts` 統整導出，`src/policy.ts` 保持向後相容引用。

### 2.0.2 檔案與模組劃分
- `src/config/navigation.config.ts`：
  - 跟隨遲滯門檻：`followEnter: 2.2`, `followExit: 1.2`, `catchUpEnter: 16`, `catchUpExit: 5`。
  - 停滯與超時：`stallThresholdMs: 1500`, `recoveryMaxRetries: 2`。
  - 開關預設值：`defaultCanDig: false`, `defaultAllowBridge: false`, `allowParkour: false`。
  - 挖放白名單：`DIG_WHITELIST`, `PLACE_WHITELIST`。
  - 移動限制：門體斜角禁止、耕地防跳躍。
- `src/config/combat.config.ts`：
  - 交戰距離：`combatEnter: 8`, `combatExit: 16`, `combatMasterLimit: 24`。
  - 撤退閾值：`retreatHealth: 6`, `retreatEnter: 12`, `retreatExit: 18`, `retreatSafeMs: 3000`, `retreatMobCount: 3`。
- `src/config/survival.config.ts`：
  - 進食門檻：`routineFood: 16`, `emergencyFood: 6`, `emergencyHealth: 10`。
  - 作息時間：`sleepMinTime: 12541` (黃昏就寢), `sleepMaxTime: 23458` (天亮起床)。
- `src/config/work.config.ts`：
  - 拾取參數：`pickupRadius: 5`, `pickupMasterLimit: 10`, `failureCooldownMs: 30_000`。
  - 狩獵參數：預設目標清單 (`['chicken', 'pig', 'cow', 'sheep']`)、工作直徑 `50` 格（半徑 `25` 格）、單次工時上限 `1_200_000` ms（1 遊戲日）。
  - 農業參數：作物註冊表（小麥、胡蘿蔔、馬鈴薯、甜菜根）、工作直徑 `50` 格、單次工時上限 `1_200_000` ms。
  - 箱子參數：最大互動距離 `3.5` 格、預設保留工具與食物清單。
- `src/config/system.config.ts`：
  - 決策週期：`tickIntervalMs: 100`。
  - 執行器 fence：`fenceTickMs: 50`。
  - 聊天冷卻：`chatIntervalMs: 1000`, `chatQueueLimit: 5`。
  - 視野半徑：`observationRadius: 32`。
  - 資料持久化：`storagePath: 'data/storage.json'`。
- `src/config/index.ts`：統一匯出所有配置，讓其他模組能以 `import { workConfig, navConfig } from '../config'` 引數。

### 2.0.3 驗收門檻
- [ ] 執行 `pnpm run typecheck` 與 `pnpm test` 100% 通過，全專案無壞掉的舊引用。
- [ ] 所有魔法數字皆可在 `src/config/` 統一維護調整。

---

## Stage 2.1: 狀態清單增強與正則過濾 (`!state [regex]`)

### 2.1.1 階段目標
擴充現有 `!state`（及 `!status`）指令，輸出 Bot 當前身上裝備清單、背包全部物品統計，並支援可選的正規表達式（regex filter）對資源名稱進行篩選查詢。

### 2.1.2 規格與行為定義
- **指令語法**：
  - `!state`：輸出基礎狀態（HP、Food、Mode、Base/Spawn、Switches）＋ 當前裝備欄（主手、副手、頭盔、胸甲、護腿、靴子）＋ 身上所有物品及數量統計。
  - `!state <pattern>`：依正規表達式 `<pattern>`（不分大小寫）過濾物品名稱（name 與 displayName），僅列出符合該 pattern 的物品統計；若無任何符合項目則回覆 `No items matching "<pattern>"`。
- **輸出格式範例**：
  ```text
  [Equipment] Head: iron_helmet | Chest: iron_chestplate | Legs: none | Feet: leather_boots | MainHand: iron_sword | OffHand: shield
  [Inventory] (12 items / 24 slots free)
  - wheat_seeds x32
  - bread x16
  - iron_ingot x8
  - dirt x64
  ```
  當輸入 `!state iron.*` 時：
  ```text
  [Matched: iron.*]
  - Head: iron_helmet (equipped)
  - Chest: iron_chestplate (equipped)
  - MainHand: iron_sword (equipped)
  - iron_ingot x8 (inventory)
  ```

### 2.1.3 交付與修改檔案
- `src/perception.ts`：擴充 `inventory` 感知資料結構，提供各裝備槽位（`equipment`）詳細資訊與完整背包物品聚合陣列（`itemCounts: Map<string, number>`）。
- `src/commands.ts`：更新 `!state` 指令解析邏輯，支援可選參數 `args[0]` 作為 regex，格式化輸出裝備與物品資訊。
- `test/unit/commands-state-filter.test.ts`：單元測試驗證無參數輸出、有效 regex 過濾、無匹配結果處理以及異常 regex 容錯（如無效正則不崩潰）。

### 2.1.4 驗收門檻
- [ ] `!state` 正確顯示主手、副手與四個防具槽位名稱。
- [ ] 支援 regex 過濾，如 `!state seed|wheat` 正確過濾出 `wheat` 與 `wheat_seeds`。
- [ ] 無效 regex（如 `!state [unclosed`）能優雅捕捉並回報語法錯誤，不拋出未捕獲例外。

---

## Stage 2.2: 集合地錨定、工時限制與自主動物狩獵 (`!hunt`)

### 2.2.1 階段目標
實作自主狩獵行為：當收到 `!hunt` 指令時，Bot 以當前座標為暫時集合地（Rally Point），在直徑 50 格（半徑 25 格）範圍內搜尋目標動物（預設支援：雞 `chicken`、豬 `pig`、牛 `cow`、羊 `sheep`），接近並擊殺動物，自動拾取掉落物；單次任務限制**不超過遊戲中一天（20 分鐘）**，範圍內無動物或工時結束時自動返回集合地。

### 2.2.2 規格與行為定義
- **指令語法**：
  - `!hunt`：啟動預設白名單狩獵。
  - `!hunt <target>`：限定特定動物（如 `!hunt cow` 或 `!hunt pig`）。
- **暫時集合地與邊界約束（Rally Point & Area Constraint）**：
  - 記錄指令接收時的座標為 `rallyPoint = bot.entity.position.clone()`。
  - **範圍界限**：水平平面歐幾里得距離 $\sqrt{(x - rally.x)^2 + (z - rally.z)^2} \le 25.0$ 格。
  - 追擊途中若動物逃脫出 25 格半徑外，立即放棄追逐，重新評估範圍內新獵物。
- **工時限制（Shift Duration Limit）**：
  - 記錄任務開始時間戳 `startedAt = Date.now()`。
  - 限制時長：`maxDurationMs = 1_200_000`（20 分鐘 = 遊戲中一天 24,000 ticks）。
  - 若 `Date.now() - startedAt >= maxDurationMs`，觸發工時結束，停止鎖定新獵物，返回集合地並發送 `Hunting shift completed (1 day limit reached).`，模式切換為 `STAY`。
- **目標選擇與優先序**：
  1. 實體屬於目標動物清單：`chicken`, `pig`, `cow`, `sheep`。
  2. 與 `rallyPoint` 水平距離 $\le 25.0$ 格。
  3. 優先選擇距離 Bot 最近的獵物。
  4. 排除處於冷卻或不可達之實體。
- **行為流程（Behavior Pipeline）**：
  1. 接近獵物：使用 `GoalNear(target.position, 1.8)` 靠近。
  2. 裝備武器：進入攻擊範圍前自動換上最佳武器（`bestWeapon`）。
  3. 攻擊：在距離 $\le 3.0$ 格進行揮擊攻擊直到死亡。
  4. 收集物資：目標死亡後產生肉品或掉落物，觸發 `PickupItem`（優先級 30）拾取。
  5. 歸隊 / 等候：若範圍內已無目標動物或工時結束，導航回 `rallyPoint`，切換回 `STAY`。

### 2.2.3 系統分層設計
- **Blackboard Schema 擴充**：
  - `intent.mode`: 新增 `'HUNT'`。
  - `intent.workArea`: `{ rallyPoint: { x: number; y: number; z: number }; maxRadius: number; startedAt: number; maxDurationMs: number }`。
- **BT 子樹整合 (`src/bt/subtrees/work.ts`)**：
  - `HuntAnimalAction`：優先級 35，所需資源 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`。
  - `ReturnToRallyAction`：優先級 20，無目標或工時超時且離集合地距離 $> 3$ 格時觸發，所需資源 `['MOVE', 'LOOK']`。
- **安全防護**：
  - 遭遇怪物攻擊時，`Combat (80)` 立即搶佔；重傷時 `Retreat (100)` 與 `EmergencyEat (90)` 優先觸發。

### 2.2.4 驗收門檻
- [ ] 執行 `!hunt` 時正確錨定當前座標為集合點，只鎖定半徑 25 格內的動物。
- [ ] 獵殺過程自動換上最佳武器，擊殺後成功拾取掉落物。
- [ ] 動物逃逸出 25 格範圍時主動放棄，不追出限定區域。
- [ ] 執行時限達 20 分鐘（遊戲中一天）或動物獵殺完畢時，平穩返回集合點並停止。

---

## Stage 2.3: 多作物農事種植自動化與工時限制 (`!farm`)

### 2.3.1 階段目標
實作支援多種農作物（預設優先實作小麥）的農事耕作架構：檢查背包中可播種的種子或農產品，在以集合點為中心、直徑 50 格範圍內尋找空置耕地（`farmland`），靠近並在農地上種植；工時上限同樣**不超過遊戲中一天（20 分鐘）**。

### 2.3.2 規格與行為定義
- **作物架構註冊表（Crop Registry）**：
  - 支援各種作物的播種項目與方塊對應表（預設第一優先實作小麥）：
    - 小麥：種植物品 `wheat_seeds` $\to$ 作物方塊 `wheat`，熟成條件 `age === 7`。
    - 胡蘿蔔：種植物品 `carrot` $\to$ 作物方塊 `carrots`，熟成條件 `age === 7`。
    - 馬鈴薯：種植物品 `potato` $\to$ 作物方塊 `potatoes`，熟成條件 `age === 7`。
    - 甜菜根：種植物品 `beetroot_seeds` $\to$ 作物方塊 `beetroots`，熟成條件 `age === 3`。
- **指令語法**：
  - `!farm`：自動檢查背包中擁有的可播種種子（預設小麥種子優先），進行播種。
  - `!farm <crop>`：指定特定作物種植（例如 `!farm wheat`、`!farm carrot`）。
- **前置條件檢查**：
  - 檢查背包中是否含有指定或任何合法種子。若無任何種子，回覆 `No plantable seeds in inventory!` 並終止任務。
- **耕地偵測與有效性判定**：
  - 掃描以 `rallyPoint` 為中心半徑 25 格內的方塊。
  - 判定條件：方塊為 `farmland`，上方一格為 `air`，水平距離離 `rallyPoint` $\le 25.0$ 格。
- **移動與農地保護規範**：
  - 關閉跳躍輔助（`movements.allowParkour = false`），移動時嚴禁在耕地上跳躍，避免踩壞耕地。
- **播種操作**：
  - 手持目標種子（`bot.equip(seedItem, 'hand')`）。
  - 對準耕地頂部呼叫 `bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0))` 完成種植。
- **結束與超時條件**：
  - 背包種子用盡、無空置耕地、或達到 1 遊戲日（20 分鐘）時限。
  - 完成後返回集合點，通知主人 `Farming completed. Planted N crops.`，切換回 `STAY`。

### 2.3.3 交付與修改檔案
- `src/config/work.config.ts`：定義作物註冊表與農事設定。
- `src/perception.ts`：擴充農地與作物感知，提供 `getAvailableFarmland(rallyPoint, radius)`。
- `src/actions/farming.ts`：實作 `PlantSeedAction` 適配器，封裝手持種子、防跳躍移動與放置作物。
- `src/bt/subtrees/work.ts`：掛載 `FarmPlant` 決策節點（優先級 30）。
- `test/unit/farming-plant.test.ts`：單元測試驗證多作物註冊、種子檢查、農地識別、防踐踏開關、工時逾時與播種流程。

### 2.3.4 驗收門檻
- [ ] 無種子時下達 `!farm` 能即時警示並退出，不產生無謂走動。
- [ ] 支援多種植物註冊架構，預設優先成功種植小麥 `wheat_seeds`。
- [ ] 播種移動過程中不觸發跳躍，不破壞耕地方塊。
- [ ] 種子用盡、無地可種或達 20 分鐘時限時平穩返回集合點。

---

## Stage 2.4: 多作物熟成收割與自動補種 (`!harvest`)

### 2.4.1 階段目標
實作多種農作物的成熟辨識、安全收割、掉落物回收與原地即時補種（Harvest & Replant），同樣受直徑 50 格集合點範圍與 1 遊戲日工時限制。

### 2.4.2 規格與行為定義
- **指令語法**：
  - `!harvest`（或 `!reap`）：自動收割範圍內所有已成熟的作物（預設小麥）。
  - `!harvest <crop>`：指定特定成熟作物收割（例如 `!harvest wheat`）。
- **成熟作物判斷標準（依 Crop Registry）**：
  - 小麥 `wheat`：`age === 7`。
  - 胡蘿蔔 `carrots`：`age === 7`。
  - 馬鈴薯 `potatoes`：`age === 7`。
  - 甜菜根 `beetroots`：`age === 3`。
  - 作物相對於 `rallyPoint` 水平距離 $\le 25.0$ 格。
- **作業管線（Pipeline）**：
  1. **導航接近**：移動至成熟作物旁（距離 $\le 2.5$ 格），保持耕地防踩踏設定。
  2. **採掘破壞**：呼叫 `bot.dig(cropBlock)`，破壞成熟作物。
  3. **物品拾取**：破壞後產生的收穫物與種子實體由 `PickupItem` 撿入背包。
  4. **原地補種（Replant）**：
     - 若身上有該作物對應的種子，破壞後立即在該耕地上重新播種。
     - 達到循環耕作，無需額外手動下達 `!farm`。
  5. **批次作業至完成**：遍歷範圍內所有成熟作物，全數收割補種或達到 20 分鐘工時後，返回 `rallyPoint`，回報收割成果，模式回落為 `STAY`。

### 2.4.3 交付與修改檔案
- `src/actions/farming.ts`：擴充 `HarvestCropAction`，包含各作物成熟度檢測、安全挖掘與連續補種邏輯。
- `src/bt/subtrees/work.ts`：掛載 `HarvestCrop` 決策節點（優先級 32）。
- `test/unit/farming-harvest.test.ts`：單元測試驗證各作物成熟判定（如 wheat age 7、beetroots age 3）、跳過未熟作物、採收與補種流程。

### 2.4.4 驗收門檻
- [ ] 僅收割成熟作物（小麥/胡蘿蔔/馬鈴薯 age 7，甜菜根 age 3），跳過未成熟作物。
- [ ] 收割後自動拾取掉落的農產品與種子。
- [ ] 若背包有種子，收割後能原地自動補種。
- [ ] 區域內無成熟作物或工時結束時返回集合點並停止。

---

## Stage 2.5: 夜晚自主回 Spawn 睡覺與起床作息 (Nightly Autonomous Sleep)

### 2.5.1 階段目標
當 Bot 處於 `IDLE` 狀態時，於遊戲夜晚（或雷雨天）自動前往已綁定的 Spawn 點床鋪進行睡覺，天亮時自然醒來起床並恢復 `IDLE` 狀態。

### 2.5.2 規格與行為定義
- **觸發條件**：
  - 當前意圖模式為 `IDLE`（或 `STAY` 且無其他進行中任務）。
  - 已設定有效的 Spawn 點或床鋪座標（`world.self.spawn` 或感知床鋪 `bedPosition`）。
  - 時間處於夜晚或雷雨：
    - `bot.time.isDay === false` 或 `bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458`。
    - （或 `bot.isRaining && bot.thunderState > 0` 雷雨天）。
- **就寢流程**：
  1. 偵測到夜晚且處於 IDLE，觸發 `SleepAtBedAction`（優先級 15，所需資源 `['MOVE', 'LOOK', 'HAND']`）。
  2. 導航至床鋪旁（`GoalNear(bedPos, 1.5)`）。
  3. 找到床鋪方塊，調用 `bot.sleep(bedBlock)`。
  4. 成功入睡後保持安靜，監聽 `wake` 事件。
- **安全防護與甦醒機制**：
  - **遇襲醒來**：若在睡眠中受到傷害（`tookDamageRecently`），立即呼叫 `bot.wake()`，交由 `Combat (80)` 或 `Retreat (100)` 搶佔自衛。
  - **天亮醒來**：天亮時（收到 `wake` 事件或 `bot.time.isDay === true`），自動離開床鋪，在聊天室通知 `Good morning!`，狀態自然回歸 `IDLE`。

### 2.5.3 交付與修改檔案
- `src/config/survival.config.ts`：定義入睡與甦醒時間門檻。
- `src/actions/sleep.ts`：實作 `SleepAtBedAction` 適配器。
- `src/bt/subtrees/maintenance.ts`：掛載 `SleepAtBed` 決策分支。
- `test/unit/sleep-cycle.test.ts`：單元測試驗證夜間判斷、床鋪接近、就寢、遇襲甦醒與晨起重置流程。

### 2.5.4 驗收門檻
- [ ] 白天時不觸發睡覺；夜間降臨且 IDLE 時自動走回床鋪睡覺。
- [ ] 睡覺中遭遇攻擊能立即醒來切換戰鬥。
- [ ] 天亮時自然甦醒，不卡死在睡眠狀態。

---

## Stage 2.6: 命名箱子管理、損毀自動移除與物品存取 (`!box`)

### 2.6.1 階段目標
實作專屬箱子管理系統：透過指令註冊並賦予箱子自訂 ID（如 `box_01`, `food_box`）；感知層監聽箱子方塊，若箱子被破壞則自動從註冊表中註銷並通知主人；支援存入（deposit）與取出（withdraw）指令。

### 2.6.2 規格與行為定義
- **指令語法**：
  - `!box register <boxId> [x y z]`：
    - 若無指定座標，預設選取 Bot 視線所指之方塊（`blockAtCursor`）或半徑 4 格內最近之容器（`chest`, `trapped_chest`, `barrel`）。
    - 驗證方塊為合法容器，儲存其三維整數座標並持久化寫入 `data/storage.json`。
    - 回覆 `Box "<boxId>" registered at (x, y, z).`。
  - `!box list`：列出所有已註冊箱子清單、座標與有效狀態。
  - `!box remove <boxId>`：手動註銷指定箱子。
  - `!box deposit <boxId> [filter|all]`：
    - 將身上物品存入 `<boxId>` 箱子。
    - 支援 `all`（保留身上武器、工具與部分食物，其餘存入）或正規表達式過濾（如 `!box deposit box_01 wheat|seed`）。
  - `!box withdraw <boxId> <itemName> [count]`：
    - 從 `<boxId>` 箱子中取出指定物品及數量（例如 `!box withdraw box_01 wheat_seeds 64`）。
- **損毀自動移除機制（Auto-removal on Destruction）**：
  - Perception 模組監聽 `blockUpdate` 事件：
    - 當已註冊箱子的座標方塊類型變為非容器方塊（如 `air`、泥土等表示已被破壞）。
    - Perception 自動將該 `boxId` 從註冊表中移除，更新 `data/storage.json`。
    - 透過聊天室發送警告通知：`Warning: Box "<boxId>" at (x, y, z) was destroyed and removed from registry.`。
- **存取操作管線（Deposit/Withdraw Pipeline）**：
  1. 導航至箱子旁（距離 $\le 2.5$ 格），申請資源 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`（優先級 28）。
  2. 開啟容器（`bot.openContainer(boxBlock)`）。
  3. 根據要求遍歷容器並調用 `container.deposit()` 或 `container.withdraw()`。
  4. 操作完畢呼叫 `container.close()`，向主人回報存取明細。

### 2.6.3 交付與修改檔案
- `src/state-storage.ts`：擴充持久化資料結構，支援 `boxes: Record<string, { x: number; y: number; z: number; type: string }>`。
- `src/perception.ts`：增加箱子狀態感知與方塊破壞監聽。
- `src/actions/container.ts`：實作 `DepositAction` 與 `WithdrawAction` 適配器。
- `src/commands.ts`：實作 `!box` 系列指令解析與回報。
- `test/unit/box-management.test.ts`：單元測試驗證箱子註冊、方塊破壞自動註銷、存入、取出與持久化儲存。

### 2.6.4 驗收門檻
- [ ] 支援 `!box register` 註冊自訂 ID，且資料正確寫入 `data/storage.json`。
- [ ] 當箱子方塊被破壞時，自動偵測並從註冊表移除，發出警示。
- [ ] `!box deposit` 正確將指定或非保留物品存入箱中；`!box withdraw` 正確取出指定數量物品。
- [ ] 存取期間受戰鬥搶佔保護，不會因意外中斷造成容器死鎖。

---

## Stage 2.7: Stage 2 綜合整合與端到端驗收測試

### 2.7.1 階段目標
驗證狀態查詢、自主狩獵、農事種植、成熟收割、夜間睡眠作息、箱子管理與存取在真實伺服器或模擬 Harness 環境下的交互穩定度、邊界約束與搶佔安全性。

### 2.7.2 必測綜合情境矩陣 (Stage 2 Verification Matrix)

| 測試編號 | 測試場景描述 | 預期行為與驗收指標 |
| :--- | :--- | :--- |
| **S2-E2E-01** | **`!state` 裝備與 Regex 查詢** | 測試全套裝備、空裝、以及 `!state iron.*` / `!state seed` 過濾，格式整齊無報錯。 |
| **S2-E2E-02** | **狩獵邊界與工時限制** | 集合點外 30 格動物不被追逐；半徑 25 格內動物擊殺拾取；工時達 20 分鐘或無動物時自動回集合點。 |
| **S2-E2E-03** | **狩獵中遇襲搶佔恢復** | 狩獵中刷出殭屍，`Combat(80)` 搶佔拔刀擊殺殭屍，結束後自動繼續獵殺剩餘動物。 |
| **S2-E2E-04** | **農田安全播種與防踩踏** | 在 9x9 水耕農田上播種，Bot 移動全程不跳躍，農田未發生任何踐踏退化為泥土事件。 |
| **S2-E2E-05** | **成熟小麥收割與原地補種** | 區域內混合不同生長階段作物，精準收割 age 7 小麥，撿取種子後原地重新播種。 |
| **S2-E2E-06** | **夜間自動回 Spawn 就寢與晨起** | IDLE 下夜晚降臨自動走回床鋪入睡；遭受攻擊立刻醒來反擊；天亮自然醒來恢復待命。 |
| **S2-E2E-07** | **箱子註冊、破壞自動註銷與存取** | 註冊 `box_01` 並存入小麥；模擬箱子被挖除，感知層自動移除 `box_01` 並發出提醒。 |
| **S2-E2E-08** | **配置集中管理一致性** | 所有動作與策略參數皆自 `src/config/` 讀取，修改配置即時反映行為，無硬編碼。 |
