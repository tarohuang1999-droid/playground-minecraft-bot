# Implementation Plan: Stage 2 - 生存物資採集、自主狩獵與農業自動化

- **目標讀者**：AI Coding Agent / 實作工程師
- **前置依賴規範**：動工前請先閱讀：
  - `docs/sys-design/system-design-v1.1.md`（核心架構、Blackboard Schema、Arbiter 仲裁規範）
  - `docs/implement-plan-stage-1.md`（Stage 1 基礎設施、執行器 fence、導航與戰鬥基底）
  - `docs/rules/rule-typescript-coding.md`（TypeScript 開發規範）
- **核心開發原則**：
  1. **KISS & YAGNI 原則**：專注於指定指令與功能，避免不必要的複雜抽象或狀態機巢狀化；善用標準庫與 Mineflayer 現有能力。
  2. **有界活動範圍約束**：所有範圍任務（`!hunt`、`!farm`、`!harvest`）以指令觸發時的座標為「暫時集合地（Temporary Rally Point）」，嚴格限制在直徑 50 格（即以集合地為中心半徑 25 格，橫向距離 $\le 25$ 格）之內，禁止無窮追逐離開工作區域。
  3. **資源仲裁一致性**：所有獵殺、播種與收割行為皆需透過 Arbiter 申請資源通道（通常為 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`），並服從 `Combat (80)`、`EmergencyEat (90)`、`Retreat (100)` 的高優先級生存搶佔。
  4. **農地保護**：在耕地（Farmland）上作業與移動時，禁止跳躍（`allowParkour = false`，關閉 jump 動作），防止將耕地踩踏破壞為泥土方塊。

---

## 階段目錄 (Stage 2 Breakdown)

- **Stage 2.1: 狀態清單增強與正則過濾 (`!state [regex]`)**
- **Stage 2.2: 集合地錨定與自主動物狩獵 (`!hunt`)**
- **Stage 2.3: 小麥農事種植自動化 (`!farm`)**
- **Stage 2.4: 小麥熟成收割與自動補種 (`!harvest`)**
- **Stage 2.5: Stage 2 綜合整合與端到端驗收測試**

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

## Stage 2.2: 集合地錨定與自主動物狩獵 (`!hunt`)

### 2.2.1 階段目標
實作自主狩獵行為：當收到 `!hunt` 指令時，Bot 以當前座標為暫時集合地（Rally Point），在直徑 50 格（半徑 25 格）範圍內搜尋目標動物（預設支援：雞 `chicken`、豬 `pig`、牛 `cow`、羊 `sheep`），接近並擊殺動物，自動拾取掉落生肉與資源，範圍內無動物時返回集合地。

### 2.2.2 規格與行為定義
- **指令語法**：
  - `!hunt`：啟動狩獵模式。若主人提供特定目標（如 `!hunt cow`），可限定該動物類別；預設獵殺白名單動物。
- **暫時集合地（Rally Point）**：
  - 當 Bot 接收並確認 `!hunt` 指令當下，記錄 `rallyPoint = bot.entity.position.clone()`。
  - **範圍界限**：水平平面歐幾里得距離 $\sqrt{(x - rally.x)^2 + (z - rally.z)^2} \le 25.0$。
- **目標選擇與過濾優先序**：
  1. 實體屬於目標動物清單：`chicken`, `pig`, `cow`, `sheep`。
  2. 該實體與 `rallyPoint` 之水平距離 $\le 25.0$ 格（超出範圍者不予追逐）。
  3. 優先選擇距離 Bot 最近的獵物。
  4. 排除處於冷卻中（若曾追擊失敗超時）或不可達之實體。
- **行為流程（Behavior Pipeline）**：
  1. **接近獵物**：使用 `GoalNear(target.position, 1.8)` 靠近。追逐期間若目標逃出集合地 25 格範圍，立即中斷追擊，重新評估新目標。
  2. **裝備武器**：接近至 3 格內自動裝備背包內攻擊力最高之武器（`bestWeapon`）。
  3. **攻擊**：在攻擊距離內（$\le 3.0$ 格）對目標調用揮擊與攻擊，直到目標死亡。
  4. **收集物資**：目標死亡後產生物品掉落（如 `beef`, `porkchop`, `mutton`, `chicken`, `leather`, `feather`），利用 Stage 1 原有的 `PickupItem`（優先級 30）自動撿拾。
  5. **歸隊 / 等候**：若直徑 50 格內已無任何目標動物，自動導航返回 `rallyPoint`，並通知主人 `No more animals in hunting area.`，模式回落為 `STAY`。

### 2.2.3 系統分層設計
- **Blackboard Schema 擴充**：
  - `intent.mode`: 新增 `'HUNT'`。
  - `intent.workArea`: `{ rallyPoint: { x: number; y: number; z: number }; maxRadius: number }`。
- **BT 子樹整合 (`src/bt/subtrees/work.ts` 或獨立 `hunting.ts`)**：
  - `HuntAnimalAction`：優先級 35，所需資源 `['MOVE', 'LOOK', 'HAND', 'INVENTORY']`。
  - `ReturnToRallyAction`：優先級 20，無目標且離集合地距離 $> 3$ 格時觸發，所需資源 `['MOVE', 'LOOK']`。
- **安全防護**：
  - 遭受敵對生物攻擊時，`Combat (80)` 立即搶佔打斷狩獵；戰鬥結束後無縫恢復狩獵。
  - 血量低於門檻時，`EmergencyEat (90)` 與 `Retreat (100)` 優先觸發。

### 2.2.4 驗收門檻
- [ ] 執行 `!hunt` 時正確錨定當前座標為集合點，且只鎖定半徑 25 格內的動物。
- [ ] 獵殺過程自動換上最佳武器，擊殺後成功觸發掉落物撿拾。
- [ ] 動物逃逸出 25 格範圍時主動放棄，不追出限定區域。
- [ ] 範圍內無動物時自動走回集合點並停止。

---

## Stage 2.3: 小麥農事種植自動化 (`!farm`)

### 2.3.1 階段目標
實作基礎小麥（Triticum）農業耕作：檢查背包是否持有種子（`wheat_seeds`），在以集合點為中心、直徑 50 格範圍內尋找可播種的耕地（`farmland`），靠近並在農地上種植小麥。

### 2.3.2 規格與行為定義
- **指令語法**：
  - `!farm`：啟動農事種植模式。
- **前置條件檢查**：
  - 檢查背包中是否含有小麥種子（`wheat_seeds`）。若數量為 0，立即回覆 `No wheat seeds in inventory!` 並終止任務。
- **耕地偵測與有效性判定**：
  - 掃描以 `rallyPoint` 為中心半徑 25 格內的所有方塊。
  - 條件判定：
    - 方塊本身為 `farmland`（耕地）。
    - 耕地上方一格（`y + 1`）為 `air`（無作物、雜草或其他方塊阻擋）。
    - 耕地受水源滋潤佳，但旱地亦可判定為合法播種位。
    - 耕地水平距離離 `rallyPoint` $\le 25.0$ 格。
- **移動與農地保護規範**：
  - 關閉跳躍輔助（`movements.allowParkour = false`），移動時嚴禁在耕地上進行跳躍動作，避免踩壞耕地（轉化為 dirt）。
  - 設定 `GoalPlaceBlock(farmlandPos.up(), bot.world, { range: 3 })` 或使用 `GoalNear(farmlandPos, 2)`。
- **播種操作**：
  - 手持 `wheat_seeds`（`bot.equip(seeds, 'hand')`）。
  - 瞄準 `farmland` 方塊頂面（`faceVector: new Vec3(0, 1, 0)`）。
  - 呼叫 `bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0))` 完成種植。
- **結束條件**：
  - 背包內種子消耗殆盡，或範圍內已無未種植的空置耕地。
  - 完成後返回集合點，通知主人 `Farming completed. Planted N crops.`，切換回 `STAY`。

### 2.3.3 交付與修改檔案
- `src/perception.ts`：擴充農地與作物感知，提供 `getAvailableFarmland(rallyPoint, radius)`。
- `src/actions/farming.ts`：實作 `PlantSeedAction` 適配器，封裝手持種子、防跳躍移動與放置小麥。
- `src/bt/subtrees/work.ts`：掛載 `FarmPlant` 決策節點（優先級 30）。
- `test/unit/farming-plant.test.ts`：單元測試驗證種子檢查、農地識別、防踐踏開關與播種流程。

### 2.3.4 驗收門檻
- [ ] 無種子時下達 `!farm` 能即時警示並退出，不產生無謂走動。
- [ ] 成功在空置耕地上播種 `wheat_seeds`，並正確過濾已有作物的耕地。
- [ ] 播種移動過程中不觸發跳躍，不破壞耕地方塊。
- [ ] 種子用盡或無地可種時平穩返回集合點。

---

## Stage 2.4: 小麥熟成收割與自動補種 (`!harvest`)

### 2.4.1 階段目標
實作成熟作物辨識、安全收割、掉落物回收與原地即時補種（Harvest & Replant）的一體化作業，同樣受直徑 50 格集合點範圍限制。

### 2.4.2 規格與行為定義
- **指令語法**：
  - `!harvest`（或 `!reap`）：啟動收割模式。
- **成熟作物判斷標準**：
  - 方塊名稱為 `wheat`（舊版本為 `crops`）。
  - 其 metadata / property `age === 7`（表示小麥已完全熟成，收割會掉落 1 個小麥及 1~4 個小麥種子）。
  - 作物位置相對於 `rallyPoint` 水平距離 $\le 25.0$ 格。
- **作業管線（Pipeline）**：
  1. **導航接近**：移動至成熟小麥旁（距離 $\le 2.5$ 格），同樣保持耕地防踩踏設定。
  2. **採掘破壞**：呼叫 `bot.dig(wheatBlock)`，破壞成熟小麥。
  3. **物品拾取**：破壞後產生的小麥與種子實體由 `PickupItem` 撿入背包。
  4. **原地補種（Replant）**：
     - 若身上有 `wheat_seeds`，破壞後立即在該耕地上重新播種。
     - 達到可持續循環農業，無需手動再次執行 `!farm`。
  5. **批次作業至完成**：遍歷範圍內所有成熟小麥，全數收割補種後，返回 `rallyPoint`，回報收割成果，模式回落為 `STAY`。

### 2.4.3 交付與修改檔案
- `src/actions/farming.ts`：擴充 `HarvestCropAction`，包含成熟度檢測、安全挖掘與連續補種邏輯。
- `src/bt/subtrees/work.ts`：掛載 `HarvestCrop` 決策節點（優先級 32）。
- `test/unit/farming-harvest.test.ts`：單元測試驗證 age 7 判斷、未成熟作物跳過、採收與補種流程。

### 2.4.4 驗收門檻
- [ ] 僅收割 `age === 7` 之成熟小麥，跳過 `age < 7` 之生長中小麥。
- [ ] 收割後自動拾取掉落的小麥與小麥種子。
- [ ] 若背包有種子，收割後能原地自動補種。
- [ ] 區域內無成熟小麥時返回集合點並停止。

---

## Stage 2.5: Stage 2 綜合整合與端到端驗收測試

### 2.5.1 階段目標
驗證狀態查詢、狩獵、種植、收割四項新功能在真實伺服器或模擬 Harness 環境下的交互穩定度、區域邊界約束與搶佔安全性。

### 2.5.2 必測綜合情境矩陣 (Stage 2 Verification Matrix)

| 測試編號 | 測試場景描述 | 預期行為與驗收指標 |
| :--- | :--- | :--- |
| **S2-E2E-01** | **`!state` 裝備與 Regex 查詢** | 測試全套裝備、空裝、以及 `!state iron.*` / `!state seed` 過濾，格式整齊無報錯。 |
| **S2-E2E-02** | **狩獵邊界限制 (50 格直徑)** | 集合點外 30 格放置動物不被選為目標；集合點內 20 格動物被鎖定擊殺，追擊途中不超出邊界。 |
| **S2-E2E-03** | **狩獵中遇襲搶佔恢復** | 狩獵中刷出殭屍，`Combat(80)` 搶佔拔刀擊殺殭屍，結束後自動繼續獵殺剩餘動物。 |
| **S2-E2E-04** | **農田安全播種與防踩踏** | 在 9x9 水耕農田上播種，Bot 移動全程不跳躍，農田未發生任何踐踏退化為泥土事件。 |
| **S2-E2E-05** | **成熟小麥收割與原地補種** | 區域內混合不同生長階段小麥，精準收割 age 7 作物，撿取種子後原地重新播種。 |
| **S2-E2E-06** | **資源耗盡平穩返航** | 種子用盡或動物殺光時，自動返回 `rallyPoint` 停止並向主人報告，無殘留 Goal 或死鎖。 |
