# Reference Review: Voyager & Mindcraft Action Implementations

- 日期：2026-10-15
- 標題：Voyager 與 Mindcraft Action 實作完整技術 Review 與借鑑評估
- 評審對象：
  - `docs/references/voyager/` ([MineDojo/Voyager](file:///Users/james/projects/playground-mineflayer/docs/references/voyager))
  - `docs/references/minecraft-bots/` ([mindcraft-bots/mindcraft](file:///Users/james/projects/playground-mineflayer/docs/references/minecraft-bots))
- 目標系統：Playground-Mineflayer Companion Bot Core ([ADR-003](file:///Users/james/projects/playground-mineflayer/docs/ADR/003-companion-bot-layered-control.md) / [system-design-v1.1.md](file:///Users/james/projects/playground-mineflayer/docs/sys-design/system-design-v1.1.md))

---

## 1. 執行摘要 (Executive Summary)

* **核心結論**：
  * **Voyager 的 Action 實作（Skill Library）不可直接引入**：其核心設計屬於「LLM 動態生成的順序型腳本（Procedural Scripting）」，重度依賴阻塞式 Promise 串接（`await goto()`, `await exploreUntil()`），缺乏資源鎖、無法中斷搶佔、無法支援身體部位並行（如邊走邊吃），與本專案的反應式架構完全衝突。
  * **Mindcraft 的 Action 實作（`skills.js` & `world.js`）具極高借鑑價值，但必須重構為 Adapter**：Mindcraft 累積了大量 Mineflayer 原生邊界處理（工作台自動鋪設與收回、開門防卡死機制、破壞與放置安全檢測、工具適配與方塊別名對映）。然而其調用方式採全域單例與合作式中斷（`bot.interrupt_code`），必須移植為符合本專案的 `ActionAdapter`（宣告資源通道、綁定 `token` / `sessionGeneration` 與圍欄機制）。

---

## 2. Voyager Action 實作深度分析 (`docs/references/voyager`)

### 2.1 實作模式與架構特性
* **動態程式碼生成與字串執行**：Voyager 核心是讓 LLM 生成獨立的 JavaScript 異步函式（共 57+ 個 skills，如 `mineWoodLog.js`、`craftWoodenPickaxe.js`、`smeltRawIron.js`、`exploreCave.js`），並儲存於 JSON 庫中動態呼叫。
* **串行阻塞式執行鏈**：所有動作皆為端到端的命令式指令，例如「判斷材料 -> 挖木頭 -> 放工作台 -> 合成鎬子 -> 挖石頭」，全程使用 `await` 阻塞直到單項任務完成或逾時。
* **聊天室斷言驗證**：透過 `bot.chat("...")` 回報狀態，並以此作為 LLM Self-Verification 的回饋輸入。

### 2.2 重大架構缺陷（針對本專案架構）
* **懸空 Promise 與無法受控中止**：
  * 大量使用 `await bot.pathfinder.goto(new GoalBlock(...))` 與自製 `exploreUntil()`。
  * 當遭遇突發威脅（如苦力怕接近、扣血需緊急撤退）時，此類函式無法被及時中斷，會導致底層事件堆疊衝突與懸空 Promise 競態。
* **單一全域控制，完全排斥並行**：
  * 假定同一時間 Bot 只能做單一事情，無法滿足本專案 `MOVE + LOOK`（移動撤退）與 `HAND + INVENTORY`（換裝/進食）的合法並行需求。
* **環境脆弱假設（Brittle Environmental Assumptions）**：
  * 放置方塊時常見固定偏移硬編碼，例如 `bot.entity.position.offset(1, 0, 0)`，未檢查該座標是否被實體遮擋、落入懸崖或處於不可放置狀態。
* **例外處理粗糙**：
  * 遇到路徑中斷或實體消失，常以 `throw error` 或無上限 `while (!target) retry` 處理，易引發 Unhandled Rejection 或無限迴圈卡死。

### 2.3 評審結論：Voyager 借鑑建議
* **不可借鑑**：執行架構、路徑控制方式、任務調度模式。
* **可微幅參考**：合成樹的相依順序規劃（如基本工具鏈升級路線），但這在 Mineflayer 內已有標準 `recipesFor` API 可精確求解，實用性有限。

---

## 3. Mindcraft Action 實作深度分析 (`docs/references/minecraft-bots`)

Mindcraft 的核心動作封裝在 `skills.js`（約 2,093 行）與 `world.js`（約 430 行），代表了社群長期維護的 Mineflayer 實戰規則庫。

### 3.1 具高度參考價值的核心邏輯 (High-Value Domain Logic)

* **智慧工作台管理週期 (`craftRecipe` in `skills.js`)**：
  * **兩階段配方檢查**：先檢查無需工作台的配方（2x2 格），若不足再檢查需要工作台（3x3 格）的配方。
  * **就近搜尋與自動部署**：若 16 格內無可用工作台，自動檢查背包是否有 `crafting_table`，使用 `world.getNearestFreeSpace` 尋找合法空位後放置，並標記 `placedTable = true`。
  * **安全收回與例外清理**：合成完成後（或中途資源不足失敗時），若曾主動放置工作台，必定呼叫 `collectBlock(bot, 'crafting_table', 1)` 拾回，避免遺失工具與污染環境。
  * **資源瓶頸試算**：提供 `calculateLimitingResource`，能預先計算現有材料最多可合成的成品上限，防止無效呼叫。
* **動態防卡死與門戶解鎖機制 (`startDoorInterval` / `goToGoal` in `skills.js`)**：
  * **卡死偵測**：定時比對 Bot 座標（每 200ms），若移動距離 `< 0.1` 且累積滯留逾 1200ms，觸發脫困程序。
  * **隨機空間互動**：隨機洗牌周圍 9 個鄰近座標（含腳底、頭頂與各方向偏移），主動對木門、柵欄門（`fence_gate`）、活板門（`trapdoor`）發送 `activateBlock`。
  * **雙層導航成本切換**：優先嘗試無破壞路徑（設定玻璃為不可破壞），若無法成路，再降級至允許破壞的備用路徑。
* **方塊採集安全與工具適配 (`collectBlock` / `pickupNearbyItems` in `skills.js`)**：
  * **名稱與變形別名對齊**：自動將原礦展開為深層變形（如 `iron` -> `iron_ore` / `deepslate_iron_ore`；`dirt` -> `grass_block`）。
  * **採集安全性檢驗**：結合 `movements.safeToBreak(block)` 與 `block.canHarvest(itemId)`，防止在下落方塊（沙子、礫石）或岩漿邊緣盲目挖掘。
  * **液體源採集判斷**：採集水與岩漿時，檢查 `metadata === 0` 確保只取源頭方塊（Source block）。
  * **物品拾取後清理**：挖掘後自動追蹤半徑 8 格內的 `item` 實體並透過 `GoalFollow` 靠近吸收。
* **動態跟隨模式與遲滯控制 (`followPlayer` in `skills.js`)**：
  * **距離分級調控**：距離大於 30 格時主動暫停次要行為（暫停採集、狩獵、插火把），全力衝刺跟隨；距離縮減至 4 格以內時恢復待機或周邊支援。
* **環境自動維護 (`autoLight` / `shouldPlaceTorch` in `world.js`)**：
  * 在長時間採礦或室內行動時，檢查當前站立點方塊光照等級（`light < 8`），在合法表面自動插火把防生怪。

### 3.2 結構性衝突與反模式 (Architectural Mismatches)

* **阻塞式 `bot.pathfinder.goto()` 的濫用**：
  * Mindcraft 的導航函式普遍使用 `await bot.pathfinder.goto(...)`，這在需要即刻響應扣血撤退的反應式系統中會拋出未捕獲錯誤或導致狀態卡死。
  * 本專案架構規範：導航必須統一使用宣告式 `bot.pathfinder.setGoal(goal, dynamic)`，中止時一律調用 `setGoal(null)`。
* **依賴具不可控計時器的第三方插件 (`mineflayer-pvp`)**：
  * 其戰鬥模組直接委派給 `bot.pvp.attack(entity)`，內部自帶輪詢與不可清理的 timer，無法配合本專案 100ms Tick 的 Arbiter 硬性搶佔。
* **合作式中斷旗標脆弱性 (`bot.interrupt_code`)**：
  * 僅在迴圈頂部檢查 `if (bot.interrupt_code) break;`。若函式卡在底層 Mineflayer API 的 Promise 內部，該中斷旗標完全無效，無控制平面圍欄（Fence）保護。
* **全域單例模式與狀態污染**：
  * 函式直接修改全域 `bot.modes`、`bot.restrict_to_inventory`，多個非同步操作交錯執行時極易產生難以除錯的狀態覆蓋。

---

## 4. 三方架構橫向比對矩陣 (Comparative Matrix)

| 評估維度 | Voyager (MineDojo) | Mindcraft (mindcraft-bots) | 本專案架構 (Playground-Mineflayer) | 結論與採納建議 |
| :--- | :--- | :--- | :--- | :--- |
| **決策機制** | LLM 自主生成程式碼 | LLM 對話轉工具呼叫 | 100ms 同步 Reactive BT + 黑板 | 維持本專案 BT，不引入腳本動態生成 |
| **並行控制** | 無（單執行緒序列鎖死） | 粗粒度 Modes（如暫停模式） | 5 通道可搶佔資源鎖 (MOVE/LOOK/HAND/INV/VOICE) | 維持本專案通道鎖，Mindcraft 僅參考邏輯 |
| **中斷機制** | 無（拋例外或卡死） | 合作式 `bot.interrupt_code` | 搶佔式 Token + 50ms 圍欄 + 世代隔離 | 維持本專案圍欄，杜絕合作式輪詢 |
| **路徑導航** | 阻塞式 `goto()` | 阻塞式 `goto()` + 卡門偵測 | 宣告式 `setGoal()` + 狀態輪巡 | 移植 Mindcraft 開門與防卡死邏輯至 `setGoal` 機制 |
| **戰鬥系統** | 簡單 `attack()` 迴圈 | 委派 `mineflayer-pvp` | 自製冷卻計時器 + 距離遲滯維護 | 維持自製原生攻擊，借鑑其武器自動換裝 |
| **工作台管理** | 盲目 offset 放置 | 偵測現存 -> 放置 -> 使用 -> 回收 | 尚未完整實作 | **強烈建議移植 Mindcraft 的完整生命週期** |
| **方塊採集** | 簡易 find + dig | 安全檢查 + 工具匹配 + 別名映射 | 尚未完整實作 | **強烈建議移植 Mindcraft 的採集安全與別名** |

---

## 5. 針對本專案的具體移植與改進藍圖 (Action Migration Plan)

建議將 Mindcraft 的優秀領域邏輯提煉為無狀態純函式或封裝進符合本專案規範的 `ActionAdapter`。

### 5.1 導航與脫困適配 (`src/actions/navigation.ts`)
* **移植開門與脫困檢查**：
  * 保留本專案的 `bot.pathfinder.setGoal(goal)` 宣告式控制。
  * 將 Mindcraft 的 `startDoorInterval` 邏輯納入 Action 的內部更新流程：當 `MOVE` 資源持有者發現卡住逾 1.2 秒時，對周圍木門/柵欄門發送 `bot.activateBlock`，不另起全域計時器。
* **動態挖掘與路徑成本降級**：
  * 當 ActionContext 擁有 `HAND` 時，啟用允許挖掘的 Movements；當 `HAND` 被進食或換裝搶佔時，無縫將 movements 降級為 `canDig = false`。

### 5.2 合成動作適配器 (`src/actions/crafting.ts` - 規劃中)
* **移植 Mindcraft 的工作台生命週期**：
  * 宣告需求資源：`[ 'HAND', 'INVENTORY', 'MOVE' ]`。
  * `start()` 階段：
    1. 透過 `bot.recipesFor` 判斷是否需要 3x3 工作台。
    2. 若需工作台且 4 格內無可用實體，從背包拿出 `crafting_table`，使用空間搜尋放置於合法位置。
    3. 執行合成。
  * `cancel()` 與退出清理：
    * 若放置過臨時工作台，在結束或中斷時自動執行回收，保證環境與背包狀態一致。

### 5.3 採集與拾取適配 (`src/actions/harvesting.ts` - 規劃中)
* **移植安全破壞與方塊別名映射**：
  * 引入 Mindcraft 的 `blocktypes` 別名對應表（如金屬礦石轉深層礦石）。
  * 在挖掘前嚴格呼叫 `block.canHarvest()`，並透過背包比對最適工具（適配至 `INVENTORY` 資源）。

---

## 6. 結論與執行準則 (Actionable Guidelines)

1. **嚴守 KISS 與 YAGNI 原則**：
   * 不引入 Voyager 的複雜技能生成與提示詞自我修復架構。
   * 不引入 Mindcraft 的 `mineflayer-pvp` 等重型第三方不可控外掛。
2. **領域邏輯取精用宏**：
   * 汲取 Mindcraft 在 Minecraft 遊戲機制（工作台、門、工具採集級別、掉落物追蹤）的工程細節。
   * 所有移植程式碼一律重構為具備 TypeScript 型別定義、符合 `ActionContext` 生命週期、能被 50ms 圍欄安全撤銷的無副作用結構。
