# TypeScript 開發規範與 AI Agent 編碼鐵律 (rule-typescript-coding.md)

- **適用對象**：全專案 TypeScript 實作、維護模組，以及 AI Coding Agent 開發流程。
- **參考架構**：系統設計以 `docs/sys-design/system-design-v1.1.md` 與 `docs/implement-plan.md` 為準。

---

## 1. 核心設計原則 (Anti-Overengineering & Pragmatic Design)

* **KISS 原則 (Keep It Simple, Stupid)**：
  * 優先選擇滿足需求的最簡解法。
  * 避免不必要的抽象層、設計模式、泛型體系（Type Gymnastics）或過度包裝。
* **YAGNI 原則 (You Aren't Gonna Need It)**：
  * 嚴格禁止為「未來可能需要」預留介面、建立空資料夾或編寫未經需求的通用框架。
  * 僅針對當前 Stage 明確列出的交付目標進行實作。
* **務實的 TypeScript 風格**：
  * 優先使用普通函式、閉包物件工廠（Object Factory Closures，如 `createArbiter()`、`createExecutor()`）與精簡的 Interface / Type Alias。
  * 不使用 Class 繼承結構實作行為邏輯；不引入依賴注入容器（DI Container）、Service / Repository 模式或全域 Singleton。
  * 模組組織優先在同檔案內以具名輔助函式整理，只有在職責明確獨立且被多處實質共用時才拆分新檔。
* **依賴與生態規範**：
  * 嚴格禁止安裝或引入未列於 `package.json` 的第三方套件。
  * 全程嚴格禁止使用 `mineflayer-pvp`、`mineflayer-statemachine`、`mistreevous` 等外部高階黑盒狀態插件。

---

## 2. AI Coding Agent 強制編碼鐵律 (Strict Coding Rules)

任何負責實作本專案的 AI Agent 必須逐條遵守以下 10 條鐵律，違反任一條視為實作失敗：

1. **[RULE-01] TypeScript 語言與編譯規範**：
   * 全專案使用 TypeScript，編譯設定以 `tsconfig.json` 為唯一標準（`target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`）。
   * 啟用最高嚴格度：`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`。
   * 模組導入之相對路徑**必須顯式包含 `.ts` 副檔名**（配合 `rewriteRelativeImportExtensions: true`），例如：
     ```ts
     import { createArbiter } from './execution/arbiter.ts';
     import type { ActionRequest } from './execution/types.ts';
     ```
   * **嚴格禁止使用 `any`**：型別不明時使用 `unknown` 並進行型別縮窄（Type Narrowing）；使用 `as const` 與 `satisfies` 保持常數與策略表之型別精確推導。
   * 遵守 `erasableSyntaxOnly: true`：不使用 TypeScript 特有 runtime 語法（例如 `enum`、`namespace`），枚舉值一律採用字串聯合型別與 `as const` 陣列。
2. **[RULE-02] 禁止在 BT 內執行副作用**：
   * `src/bt/**` 目錄下的所有檔案**嚴禁**引入 `mineflayer` runtime 依賴（僅允許純型別 `import type`），**嚴禁**持有 `bot` 實例。
   * **嚴禁**使用 `async / await` 或啟動定時器。BT 節點只能讀取快照 `snapshot: BlackboardSnapshot`，並純同步回傳 `{ status: NodeStatus, requests: ActionRequest[] }`。
3. **[RULE-03] 資源請求原子性 (All-or-Nothing)**：
   * 任何 Action 不得在執行中途動態追加資源鎖（Lock Escalation），也不得在只拿到部分鎖時偷跑。
   * 所有需要的資源通道必須在 `ActionRequest.requiredResources` 一次完整宣告。
4. **[RULE-04] 強制 Token 與 Generation 雙重檢查**：
   * 在 `src/actions/**` 中，任何 `await` 語句的下一行，或是任何 `setTimeout` / 事件監聽回呼的第一行，**必須**執行：
     ```ts
     if (!ctx.isActive()) return; // 內部同時檢查 token === currentToken && gen === sessionGeneration
     ```
   * 未加此檢查的非同步程式碼一律禁止提交。
5. **[RULE-05] 禁止死等懸空 Promise 釋放鎖**：
   * `executor.ts` 在取消舊動作時，呼叫 `adapter.cancel()` 後只需經過 **1 個 `physicsTick` (50ms)** 的 `stopping` 緩衝期，即強制將資源狀態設為 `free` 並交給新勝者；**嚴禁** `await oldRun.promise` 完成才移交資源鎖。
6. **[RULE-06] 尋路控制唯一入口**：
   * 禁止在全專案任何地方出現 `bot.pathfinder.goto` 或 `bot.pathfinder.stop`。
   * 更新尋路唯一允許 `bot.pathfinder.setGoal(goal, dynamic)`，停止尋路唯一允許 `bot.pathfinder.setGoal(null)`。
7. **[RULE-07] 避免尋路抖動 (No Goal Spamming)**：
   * 當 `Follow`、`Retreat` 或 `Combat` 在連續多輪 Tick 中維持同一個 `runId` 與目標時，Adapter **不得**每輪重複呼叫 `bot.pathfinder.setGoal()` 重設相同目標（動態追蹤目標交由 `setGoal(goal, true)` 內部更新）。
8. **[RULE-08] 傷害來源安全推斷**：
   * 處理 `entityHurt` 事件時，Mineflayer 不保證提供攻擊者 ID。自衛邏輯只針對「自身周圍 8 格內已存在的敵對生物（Hostile Mob）」觸發，**禁止**盲目將「距離最近的玩家或中立生物」當作攻擊者進行反擊。
9. **[RULE-09] 死亡與斷線強制清空**：
   * 當觸發 `bot.on('death')` 或 `bot.on('end')` 時，必須立即遞增 `sessionGeneration`，同步呼叫所有活動中 Action 的 `cancel()`，清空 `arbiter` 所有鎖與 `blackboard.runtime`，確保重生後處於乾淨無狀態。
10. **[RULE-10] 測試先行交付順序 (Implementation Order)**：
    * 遵循 Stage 規劃依序進行，不得跨階段偷跑。
    * 每完成一個模組必須先通過純單元測試（`pnpm test`）與型別校驗（`pnpm run typecheck`），方可接上實機進行 PaperMC 整合測試。

---

## 3. 架構分層與模組界線 (Architectural Boundaries)

各模組邊界必須嚴格遵守以下職責劃分：

| 模組路徑 | 職責 (該做什麼) | 限制 (嚴禁做什麼) |
| :--- | :--- | :--- |
| `src/bot.ts` | 機器人連線啟動、Mineflayer 插件掛載、全域事件監聽（`death`, `end`）、主迴圈定時器調度 | 撰寫具體戰鬥、尋路、吃東西或物品操作流程 |
| `src/commands.ts` | 解析聊天室與密語指令、白名單權限驗證、更新 `blackboard.intent` | 直接操作機器人移動、跳躍、視角或攻擊 |
| `src/blackboard.ts` | 集中管理世界快照、提供 `world / intent / runtime` 分區、發布唯讀凍結物件 (`Object.freeze`) | 撰寫遊戲決策或排程邏輯 |
| `src/policy.ts` | 定義資源通道 (`MOVE`, `LOOK`, `HAND`, `INVENTORY`, `VOICE`)、動作優先級常數與遲滯閥值 | 包含任何執行期邏輯或 I/O 操作 |
| `src/bt/**` | 行為樹節點與子樹結構、純同步決策評估、收集當輪 `ActionRequest` | 引入 `mineflayer` 模組、持有 `bot` 實例、使用 `async/await` 或啟動背景定時器 |
| `src/execution/arbiter.ts` | 資源通道權限分配、穩定優先級排序、All-or-Nothing 整組原子鎖定 | 操作 Mineflayer API 或發起非同步呼叫 |
| `src/execution/executor.ts` | 管理 `runId`、`token`、`sessionGeneration`、50ms 搶佔 Fencing、失敗冷卻表 (`Cooldown Map`) | 決定誰優先獲得資源（職責歸屬 Arbiter） |
| `src/perception.ts` | 週期性與事件驅動採集周圍環境狀態（血量、食物、實體、主人），推入感知佇列 | 直接修改機器人控制狀態或觸發動作 |
| `src/actions/**` | 執行具體 Mineflayer 操作、監聽中斷信號、目標有效性驗證、清理控制狀態 | 自行決定動作優先級、存取未經 Arbiter 配給的資源通道 |

---

## 4. Mineflayer API 避坑指南與實戰防線

以下規則源自實戰經驗總結，所有 Action 與感知實作必須嚴格遵守：

### 4.1 Vec3 物件相容性防線
* **問題根因**：Mineflayer 與 `prismarine-world` 內部依賴 `pos.floored()` 方法。若傳遞一般 JS 物件 `{ x, y, z }` 給 `bot.blockAt(pos)`，會引發 `TypeError: pos.floored is not a function`，在執行期造成每 200ms 不斷崩潰、取消、重啟的無窮死循環。
* **強制規範**：所有進入 `bot.blockAt()` 的座標必須為 `Vec3` 實例，或透過封裝的 `safeBlockAt(bot, pos)` 進行安全轉換：
  ```ts
  import { Vec3 } from 'vec3';

  export function safeBlockAt(bot: Bot, pos: { x: number; y: number; z: number }) {
    const v = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
    return bot.blockAt(v);
  }
  ```

### 4.2 門與方塊互動防抖動 (Anti-Flapping)
* **已開啟防重入**：開門前必須檢查 `isDoorOpen(block)`，若已處於開啟狀態，**絕對不得**重複觸發點擊，防止連續開關抽搐。
* **上下半門歸一化**：偵測到門的上半部（`half === 'upper'`）時，必須將 Y 座標減 1，統一對下半門發送激活操作。
* **座標冷卻表**：以門方塊的整數座標建立冷卻記錄（如 1500ms），動作被中斷或重啟時**不得**重置此冷卻，杜絕因尋路重新規劃導致的反覆開關。

### 4.3 雙通道並行與挖掘降級 (Dynamic `canDig` Downgrade)
* 當導航動作（如 `Follow`）獨立運行且 `HAND` 通道未被鎖定時，允許 `movements.canDig = true` 以越過障礙方塊。
* 當身體維護動作（如 `Eat` 或 `EquipBest`）取得 `{HAND, INVENTORY}` 鎖時，導航動作必須同步將 `movements.canDig = false`，嚴禁邊走邊揮手破壞方塊，避免打斷進食封包。

---

## 5. 測試與型別校驗規範

* **型別校驗先行**：任何程式碼提交前，必須先執行型別檢查且無任何錯誤：
  ```bash
  pnpm run typecheck
  ```
* **單元測試先行**：執行 Node.js 原生測試套件，確保 100% 通過：
  ```bash
  pnpm test
  ```
* **非同步與競態測試**：
  * 驗證搶佔發生後 1 個 Tick (50ms) 內新動作能否成功接管資源。
  * 使用未 resolve 的 Fake Promise 模擬掛起的 `consume()`，驗證舊 Promise 在未來觸發時被 `ctx.isActive()` 安全攔截，無任何副作用或殘留狀態。
* **可觀測性要求**：
  * 執行期重要狀態變更、指令解析、動作搶佔與未預期異常，必須透過 `src/logger.ts` 記錄於 `logs/bot-{name}-{date}.log`，日誌格式統一為：
    `[YYYY-MM-DDTHH:mm:ss.sssZ] [LEVEL] message`。
