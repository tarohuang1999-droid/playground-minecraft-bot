這是一份完整更新並升級為 **TypeScript** 規格的系統設計文件 `system-design-v1.md`。內容已將前述所有工程架構、**完整 Blackboard Snapshot 介面定義**、**100ms 同步決策時間軸與 DFS 遍歷細節**、**Arbiter 仲裁與 All-or-Nothing 機制**，以及針對你們 QA 討論中的關鍵問題（懸空 Promise 隔離、外掛插件取捨、動態挖掘降級）完整納入。

你可以直接將以下內容存為 `docs/system-design-v1.md`：

---

```markdown
# System Design Specification: Companion Bot Core (v1.0 - TypeScript Edition)

- **狀態**：Approved for Implementation (Phase 1 Ready)
- **目標範疇**：實作基於 **Reactive Behavior Tree (BT)**、**Blackboard (TypeScript Schema)** 與 **Preemptive Resource Arbiter (可搶佔資源仲裁器)** 的高等 NPC 底層控制架構。支援五項核心行為：**跟隨 (Follow)、自衛反擊 (Combat)、殘血撤退 (Retreat)、進食 (Eat)、鄰近撿拾 (Pickup) 與自動換裝 (Equip)**[cite: 1, 2]。
- **非目標範疇 (Out of Scope)**：本版本**不包含** LLM、JEV/KEV、Agent Memory 之介面、目錄或預留 Adapter[cite: 1, 2]。所有高階意圖由主人遊戲內指令（Chat/Whisper）驅動。

---

## 1. 系統分層與模組定義 (Module Definitions)

系統採用嚴格的單向資料流與四層職責分離架構：**World → Perception → Blackboard → Behavior Tree → Arbiter & Executor → Actions → World**[cite: 1, 2]。

| 模組分類 | 模組名稱 (檔案路徑) | 核心職責 | 狀態持有與邊界限制 |
| :--- | :--- | :--- | :--- |
| **生命週期** | `src/bot.ts` | 初始化 Mineflayer 實例、載入 `pathfinder` 插件、維護 `sessionGeneration`（斷線/死亡重置編號）[cite: 1, 2]。 | 唯一允許直接綁定 Mineflayer 連線生命週期事件 (`spawn`, `death`, `end`) 的入口。 |
| **感知層** | `src/perception.ts` | 監聽 Mineflayer 物理與世界事件，計算威脅距離、主人可視性、背包最佳裝備/食物、附近掉落物[cite: 1, 2]。 | **禁止**呼叫任何改變 Bot 狀態的 API（如 `lookAt`、`setGoal`）。只能輸出純資料物件。 |
| **資料中樞** | `src/blackboard.ts` | 維護 `world`、`intent`、`runtime` 三區狀態，每輪 Tick 產出具備 `revision` 的唯讀唯凍結快照（`BlackboardSnapshot`）[cite: 1, 2]。 | 跨層只傳遞 Entity ID、座標數值與枚舉字串，**嚴禁**將 Mineflayer 的 `Entity` 或 `Item` 實例放入快照。 |
| **戰略入口** | `src/commands.ts` | 解析主人聊天室指令，驗證白名單權限與參數合法性，更新 Blackboard 的 `intent` 分區[cite: 1, 2]。 | **禁止**直接觸發 Action 或修改 `runtime` 狀態；只負責寫入長期意圖（如 `FOLLOW`）。 |
| **策略常數** | `src/policy.ts` | 集中定義所有 Priority 權重、距離遲滯門檻（Hysteresis）、血量/飢餓閾值、冷卻時間（Cooldown）[cite: 1, 2]。 | 純常數與純函式（Pure Functions），無內部狀態。 |
| **戰術決策層** | `src/bt/nodes.ts`<br>`src/bt/runner.ts`<br>`src/bt/companion-tree.ts`<br>`src/bt/subtrees/*.ts` | 實作五種基礎節點語義；每輪讀取 Blackboard 快照，評估條件並輸出當輪「動作請求集合（Action Requests）」[cite: 1, 2]。 | **禁止**在 BT 節點內直接呼叫 Mineflayer API 或 `await` 非同步操作。BT 僅負責「聲明本輪想做什麼」。 |
| **執行與仲裁層** | `src/execution/arbiter.ts`<br>`src/execution/executor.ts` | `arbiter` 負責資源原子配置、優先級排序與搶佔裁決；`executor` 負責管理 `runId` 生命週期、Token 簽發、Fence 中斷與冷卻紀錄[cite: 1, 2]。 | 系統中唯一決定「誰擁有身體部位控制權」的模組。 |
| **動作適配層** | `src/actions/navigation.ts`<br>`src/actions/combat.ts`<br>`src/actions/inventory.ts`<br>`src/actions/chat.ts` | 將抽象動作請求轉譯為受控的 Mineflayer 底層 API 呼叫；實作統一的 `start / cancel` 介面與動態資源降級[cite: 1, 2]。 | 唯一允許接觸 `bot` 實例的執行層。所有非同步操作必須綁定並驗證 `token` 與 `sessionGeneration`。 |

---

## 2. Blackboard 完整型別 Schema 定義 (`src/blackboard.ts`)

為了徹底杜絕跨模組欄位拼寫錯誤與資料結構不一致，全專案強制使用以下 TypeScript介面[cite: 1, 2]：

```typescript
export type ResourceChannel = 'MOVE' | 'LOOK' | 'HAND' | 'INVENTORY' | 'VOICE';

export interface BlackboardSnapshot {
  readonly revision: number;
  readonly observedAt: number;

  readonly world: {
    readonly self: {
      readonly position: { readonly x: number; readonly y: number; readonly z: number };
      readonly health: number;          // 0 ~ 20
      readonly food: number;            // 0 ~ 20
      readonly isAlive: boolean;
      readonly tookDamageRecently: boolean;
    };
    readonly master: {
      readonly username: string;
      readonly entityId: number | null;
      readonly position: { readonly x: number; readonly y: number; readonly z: number } | null;
      readonly distance: number;        // 不可見時為 Infinity
    };
    readonly threats: ReadonlyArray<{
      readonly entityId: number;
      readonly name: string;
      readonly position: { readonly x: number; readonly y: number; readonly z: number };
      readonly distance: number;
    }>;
    readonly nearbyDrops: ReadonlyArray<{
      readonly entityId: number;
      readonly itemName: string;
      readonly position: { readonly x: number; readonly y: number; readonly z: number };
      readonly distance: number;
    }>;
    readonly inventory: {
      readonly freeSlots: number;
      readonly bestFood: { readonly itemId: number; readonly name: string; readonly foodPoints: number } | null;
      readonly bestWeapon: { readonly itemId: number; readonly name: string; readonly attackDamage: number } | null;
      readonly equippedWeaponDamage: number;
      readonly pendingArmorUpgrade: {
        readonly itemId: number;
        readonly slot: 'head' | 'torso' | 'legs' | 'feet';
      } | null;
    };
  };

  readonly intent: {
    readonly mode: 'FOLLOW' | 'STAY' | 'IDLE';
    readonly updatedAt: number;
    readonly intentRevision: number;
  };

  readonly runtime: {
    readonly activeRuns: Readonly<Record<string, 'RUNNING' 'STOPPING'; actionType: null; number number; readonly runId: startedAt: status: string; targetId: { | }>>;
    readonly cooldowns: Readonly<Record<number, number>>; // entityId -> retryAfterTimestamp
    readonly lockedResources: Readonly<Record<ResourceChannel, null string |>>;
  };
}

```

---

## 3. 執行時間軸與 100ms 同步迴圈細節 (Execution Timeline & Tick Mechanics)

系統掛載於 Mineflayer 的 `physicsTick` (20Hz / 50ms)，透過分頻器以 **10Hz (每 2 個 physicsTick，即 100ms)** 執行一次主決策迴圈。

### 3.1 一輪 Tick (100ms) 的 5 步純同步執行流程

在單執行緒的 Node.js 環境中，這 5 個步驟是**在同一個 Call Stack 內以純同步方式（耗時 < 1.5ms）一口氣跑完的**，絕對不會在樹的走訪中途被網路 I/O 打斷：

1. **Drain Event Queue (消化離散事件佇列)**：
* 批次取出過去 100ms 內發生的離散事件（如 `entityHurt`、聊天指令），並透過最新狀態覆寫（Pull）與事件合並（Coalescing）更新內部狀態。




2. **Freeze Snapshot (拍下凍結快照)**：
* 遞增 `revision`，透過淺層複製與 `Object.freeze()` 產出當輪不可變的 `BlackboardSnapshot`。若任何 BT 節點企圖在運行中修改快照，V8 會當場拋出 `TypeError` 報錯。




3. **Tick Behavior Tree (DFS 深度優先走訪)**：
* 從根節點 `Parallel` 開始向下進行同步 DFS 走訪。走訪過程**不觸發任何 Bot 動作**，僅回傳候選動作請求清單 (`ActionRequest[]`)。




4. **Reconcile Resources (Arbiter 仲裁與搶佔裁決)**：
* `arbiter` 接收所有請求：依優先級排序、處理同級保留（防止抖動）、執行**整組原子配置（All-or-Nothing）**，找出本輪的勝者（Winners）與淘汰者。




5. **Execute & Fence (執行與圍欄交接)**：
* 對於淘汰者呼叫 `adapter.cancel()` 發出底層停止命令；對於勝者呼叫 `start()` 或維持 `update()`。





---

## 4. 行為樹架構與資源鎖配置表 (BT & Resource Policy)

### 4.1 優先級與資源需求矩陣 (`src/policy.ts`)

| 動作名稱 (Action Scope) | 所屬子樹 | 請求資源集合 (`requiredResources`) | Priority | 進入門檻 (Enter) | 退出條件 (Exit) |
| --- | --- | --- | --- | --- | --- |
| **Retreat** (緊急撤退) | `survival.ts` | `MOVE`, `LOOK` | **100** | `HP <= 6` 且 12 格內有威脅

 | 距離威脅 `>= 18` 格且持續安全 3 秒

 |
| **EmergencyEat** (緊急進食) | `maintenance.ts` | `HAND`, `INVENTORY` | **90** | `HP <= 10` 或 `Food <= 6`<br> | 進食完成，或背包無食物

 |
| **Combat** (自衛含備武) | `combat.ts` | `MOVE`, `LOOK`, `HAND`, `INVENTORY` | **80** | 8 格內有敵對生物

 | 目標死亡、距離 `> 16` 格、與主人距離 `> 24` 格

 |
| **RoutineEat** (一般進食) | `maintenance.ts` | `HAND`, `INVENTORY` | **60** | `Food <= 16` 且背包有食物

 | `Food >= 20` 或進食完成

 |
| **EquipBest** (自動換裝) | `maintenance.ts` | `HAND`, `INVENTORY` | **50** | 無急迫危險，且背包有更好裝備

 | 穿戴完成

 |
| **CatchUpFollow** (防落隊急追) | `work.ts` | `MOVE`, `LOOK` | **40** | 主人距離 `> 16` 格

 | 主人距離 `<= 6` 格

 |
| **PickupItem** (鄰近撿拾) | `work.ts` | `MOVE`, `LOOK` | **30** | 安全、主人 `< 10` 格、5 格內有掉落物

 | 抵達目標或逾時 4 秒（寫入冷卻）

 |
| **NormalFollow** (一般跟隨) | `work.ts` | `MOVE`, `LOOK` | **20** | Intent 為 `FOLLOW` 且距離 `> 5` 格

 | 主人距離 `<= 3` 格

 |
| **Idle** (待機) | 預設葉節點 | *(無資源需求)* | **0** | 以上皆不成立

 | 隨時可被取代

 |

---

## 5. QA 核心爭點與對應工程防護 (QA Engineering Resolutions)

針對先前 QA 與設計討論中的關鍵缺口，強制執行下列設計：

1. **第三方程式庫與外掛取捨**：
* **完全禁用 `mineflayer-pvp**`：因其內部計時器無法清理，改由 `src/actions/combat.ts` 自製受 Token 管控的原生物件控制。


* **完全禁用 `pathfinder.goto()**`：統一使用聲明式 `bot.pathfinder.setGoal(goal, dynamic)`，取消時唯一合法呼叫為 `bot.pathfinder.setGoal(null)`。




2. **懸空 Promise 導致死鎖的解法**：
* 採 **Control-Plane Fence + Token 隔離**。呼叫 `bot.deactivateItem()` 或 `setGoal(null)` 後，經過 **1 個 physicsTick (50ms)** 緩衝期即強制釋放資源鎖。舊 Promise 透過 `ctx.isActive()` 檢查，逾時後的回呼一律靜默丟棄（No-op）。




3. **動態挖掘權限降級（Dynamic Capability Downgrade）**：
* `navigation.ts` 平時僅拿 `MOVE, LOOK`。當 `HAND` 閒置時允許 `movements.canDig = true` 跨越簡單障礙；當 `Eat` 或 `Equip` 取得 `HAND, INVENTORY` 時，自動將 `canDig = false` 暫停挖掘，實現無縫「邊走邊吃」。





---

## 6. 目錄結構與編碼鐵律 (Code Structure & Rules)

```text
project-root/
├── package.json                  # 依賴 mineflayer, mineflayer-pathfinder, vecStr 等
├── tsconfig.json                 # 嚴格 TypeScript 編譯設定
├── src/
│   ├── bot.ts                    # Bot 啟動、外掛掛載、sessionGeneration 管理
│   ├── policy.ts                 # Priority 常數、遲滯門檻、Cooldown 設定
│   ├── blackboard.ts             # BlackboardSnapshot 型別與建立工廠
│   ├── perception.ts             # 感知收集與離散事件 Coalescing 佇列
│   ├── commands.ts               # 主人意圖解析
│   ├── bt/
│   │   ├── nodes.ts              # ReactiveSelector, Sequence, Parallel, Guard, Action
│   │   ├── runner.ts             # 10Hz 5-Step Tick Pipeline 協調器
│   │   ├── companion-tree.ts     # 頂層 Parallel 與子樹組裝
│   │   └── subtrees/             # survival, combat, work, maintenance
│   ├── execution/
│   │   ├── arbiter.ts            # All-or-Nothing 資源 Arbiter
│   │   └── executor.ts           # Token 管理、50ms Fence 與過期回呼隔離
│   └── actions/
│       ├── navigation.ts         # Follow, Retreat, Pickup (含動態 canDig)
│       ├── combat.ts             # 自製備武與冷卻揮砍 (零 pvp 插件依賴)
│       ├── inventory.ts          # Eat (含懸空 Promise 隔離), Equip
│       └── chat.ts               # VOICE 佇列
└── test/                         # 單元與實機整合測試

```

### 給 AI Coding Agent 的強制鐵律 (`[RULE-01]` ~ `[RULE-10]`)

1. 全專案強制使用 **TypeScript** (`.ts`)，嚴格啟用 `strict: true`。
2. `src/bt/**` 內**嚴禁**出現任何 `async/await` 或 Mineflayer API 呼叫。


3. 任何 Action 請求必須一次宣告所需資源，**嚴禁中途追加（No Lock Escalation）**。


4. 所有非同步操作回呼第一行必須執行 `if (!ctx.isActive()) return;` 檢查 Token 與 Generation。


5. 絕不死等懸空 Promise 釋放鎖，取消後 50ms 強制移交。


