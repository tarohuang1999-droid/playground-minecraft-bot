# Companion Bot v1 System Design

狀態：Draft for implementation｜2026-10-14
來源：[system-design-proposal.md](../system-design-proposal.md)、[system-design-qa.md](../system-design-qa.md)、[ADR-003](../ADR/003-companion-bot-layered-control.md)，以及最新 Gemini review（四項修正）。

> 本文件取代 proposal 第 3 節「舊資源維持占用，直到 Promise 全部收尾」的規則，以及 proposal 中所有使用 `mineflayer-pvp`、`pathfinder.goto()` 的設計。其餘分層、BT 節點與資源模型沿用 proposal。
> 第 11 節列出三個插件實驗；實驗未通過前，對應的 action 不可宣稱完成。

---

## 0. 範圍

| 項目 | v1 狀態 |
| --- | --- |
| Reactive BT、Blackboard、資源仲裁 | 實作 |
| 跟隨、自衛、撤退、進食、鄰近撿拾、裝備 | 實作 |
| 主人命令（claim / unclaim / follow / stop） | 實作，沿用既有 `commands.js` 設計 |
| 伐木、箱子整理、玩家 PvP 反擊 | 不做 |
| LLM、JEV／KEV、agent memory | Pending，不建接口、不建空目錄 |

技術限制：JavaScript／CommonJS、Node 24、`node:test`。**不新增 runtime 依賴**。新入口只載入 `mineflayer-pathfinder`；不載入 `mineflayer-pvp`、`mineflayer-collectblock`、`mineflayer-auto-eat`、`mineflayer-armor-manager`（套件保留給舊腳本）。

---

## 1. 與 proposal 的差異（Codex 必讀）

| # | proposal 原設計 | 本文件決定 | 原因（已核對本機原始碼） |
| --- | --- | --- | --- |
| D1 | 換 owner 時舊 run 進入 stopping，**等 Promise、listener、finally 全部收尾**才交接 | 改為 **Control Fence**：只要舊 run 已不可能再操作 bot，即可交接；殘留 Promise 以 token 隔離 | `bot.consume()` 被 `deactivateItem()` 中斷後，其 Promise 要等 `CONSUME_TIMEOUT = 2500ms` 才 reject（`mineflayer/lib/plugins/inventory.js:14,117`）。這段等待不會再操作 bot，卻會讓 Retreat 延遲 2.5 秒 |
| D2 | Combat 經 `mineflayer-pvp` 適配 | **移除 pvp**，`actions/combat.js` 自行以 `setGoal` + `lookAt` + `attack` 實作 | `PVP.js` 的 `attemptAttack` 有私有 TaskQueue、lookAt Promise、盾牌 `setTimeout`，無法回報「已完全停止」；`stop()` 在未移動時會等 `path_stop` 最多 5 秒（`PVP.js:86-93`） |
| D3 | 導航未指定 API | **只用 `bot.pathfinder.setGoal(goal, dynamic)` 與 `setGoal(null)`**；禁止 `goto()` 與 `stop()` | `pathfinder.stop()` 只設 `stopPathing = true`；若當下沒有路徑，旗標會殘留，下一次 `setGoal()` 經 `resetPath()` 呼叫 `stop()`，把新目標清成 null（`mineflayer-pathfinder/index.js:139,162,390`） |
| D4 | `Sequence(確認武器, Combat)` 兩個節點 | 合併為單一 action `EngageCombat`，同一 runId、同一資源 scope | 兩個 action 之間會出現鎖釋放再取得的空窗 |
| D5 | 一般導航全面禁止挖放 | 預設不挖放；**卡住時升級為 `FollowUnstuck`**，改宣告完整四項資源 | pathfinder 挖掘與搭路時會自行呼叫 `bot.equip()`（`index.js:505,548`），等同使用 HAND + INVENTORY |

### 對 Gemini review 的兩處修正

- **consume Promise 不是「永遠不會結束」**，而是最多 2.5 秒後 reject。結論不變（不能等它），但描述以原始碼為準。
- **Control Fence 不等於「等一個 tick」**。能否立刻交接取決於操作類型：`setGoal(null)`、`stopDigging()`、`deactivateItem()` 是同步停止；`bot.equip()` 進行中會繼續點擊背包欄位，**無法同步停止**，必須等它 settle（有界）。見第 5 節。
- **不採用「Eat 取得 HAND 時動態關閉 Follow 的 canDig」**（Gemini 做法 A）。這會讓一個 action 未經仲裁就改變另一個 action 的能力，破壞「整組取得、整組取消」的不變式。採用做法 B（卡住升級）。

---

## 2. 分層與資料流

```text
Mineflayer 事件 ──► perception ──► Blackboard(world)
主人聊天 ─────────► commands  ──► Blackboard(intent)
                                        │
                     ┌──── 每輪一致快照 ┘
                     ▼
              BT tick（產生 action 請求）
                     ▼
              arbiter.reconcile（決定 owner、取消、授予）
                     ▼
              executor（啟動 / update / cancel actions）──► Mineflayer
                     │
                     └── 結果事件 ──► 事件佇列 ──► 下一輪寫入 Blackboard(runtime)
```

規則：

- BT 節點只讀快照，**不呼叫任何 bot API**。
- Action 是唯一可以操作 bot 的地方，且只能在持有 lease 時操作。
- 非同步結果一律先進事件佇列，下一輪開頭才套用，避免 BT 遍歷途中狀態改變。
- 跨層只傳 entity id 與普通資料；`Entity`、`bot` 物件只留在 perception 與 actions。

---

## 3. Blackboard

```js
{
  revision: 0,            // 每輪 +1
  generation: 0,          // 死亡／重生／重連 +1
  observedAt: 0,
  world: {
    self: { health, food, pos: [x, y, z], heldItem, inventoryFull },
    master: { id, pos, distance } | null,     // null = 看不見，不等於離線
    threats: [{ id, name, pos, distance }],   // 依距離排序
    drops: [{ id, pos, distance }],
    bestWeapon: { slot, name } | null,
    bestArmor: [{ slot, name, dest }],
    food: { slot, name } | null
  },
  intent: {
    master: 'dakaz' | null,
    task: 'none' | 'follow',
    revision: 0
  },
  runtime: {
    followStuckUntil: 0,          // 卡住後升級 FollowUnstuck 的期限
    retreatSafeSince: null,       // 撤退退出條件計時
    targetCooldown: Map<id, retryAfter>,
    lastResults: Map<nodeId, { status, reason, at }>
  }
}
```

- `world` 只由 perception 寫；`intent` 只由 commands 寫；`runtime` 只由 runner 套用事件時寫。
- 快照為淺凍結的新物件；節點不得修改。
- **威脅判定（v1）**：半徑 8 格內 `entity.type === 'hostile'` 的生物。不以 `entityHurt` 猜攻擊者，不反擊玩家（QA Q6）。`'hostile'` 字串需在 26.1.2 實驗中確認。

---

## 4. 行為樹

### 4.1 節點語義（`bt/nodes.js`）

每個節點是普通物件：`{ id, tick(ctx), halt(ctx) }`。節點狀態存在 `Map<nodeId, state>`，不存在節點物件上。

| 節點 | tick 行為 | halt 行為 |
| --- | --- | --- |
| `reactiveSelector(id, children)` | 每輪從第一個子節點開始評估，選第一個非 FAILURE 者；若與上輪不同，先 halt 上輪子節點 | halt 目前活動子節點 |
| `sequence(id, children)` | 記住游標，從游標處繼續；FAILURE 即結束並重設游標；全部 SUCCESS 才 SUCCESS | halt 目前子節點並重設游標 |
| `parallel(id, children, { persistent })` | tick 所有子節點。`persistent: true`（只用於根）：子分支結束後下輪重新進入，自身永遠 RUNNING | halt 所有子節點 |
| `guard(id, cond, child, { exit })` | 未啟動時用 `cond(snap)` 判斷進入；已啟動時改用 `exit(snap)` 判斷離開（遲滯）。不成立則 halt 子節點並回 FAILURE | halt 子節點 |
| `action(id, spec)` | 本輪向 arbiter 提出請求 `{ nodeId, runId, spec, priority, resources }`；依 executor 回報回 RUNNING / SUCCESS / FAILURE | 撤回請求，並要求 executor 取消該 run |

- Action 首次 tick 分配新 `runId`；持續 RUNNING 期間沿用同一 runId，**不重新啟動**。
- Action 被 halt 後再次進入，分配新 runId。
- `halt` 只發出取消，不代表底層已停止；停止狀態由 executor 追蹤。
- **遲滯（防抖動）**：所有 guard 一律提供進入與離開兩組條件，門檻集中在 `policy.js`。

### 4.2 Companion tree（`bt/companion-tree.js` + `bt/subtrees/*.js`）

```text
parallel(root, persistent)
├─ reactiveSelector(main)
│  ├─ guard(急迫危險)       → action(Retreat)          [survival.js]
│  ├─ guard(需要自衛)       → action(EngageCombat)     [combat.js]
│  ├─ guard(即將落隊)       → action(CatchUp)          [work.js]
│  ├─ guard(安全且有掉落物) → action(Pickup)           [work.js]
│  ├─ guard(跟隨卡住)       → action(FollowUnstuck)    [work.js]
│  ├─ guard(跟隨意圖有效)   → action(Follow)           [work.js]
│  └─ action(Idle)
└─ reactiveSelector(maintenance)
   ├─ guard(急迫進食)       → action(Eat, priority 90) [maintenance.js]
   ├─ guard(一般進食)       → action(Eat, priority 60)
   ├─ guard(安全且有更好裝備) → action(Equip)
   └─ action(IdleHands)     // 不請求資源
```

每個 subtree 檔案匯出一個函式，回傳上述片段；`companion-tree.js` 明確組合，不做動態註冊。

### 4.3 Guard 門檻（`policy.js`，初始值，需 Paper 調整）

| Guard | 進入 | 離開 |
| --- | --- | --- |
| 急迫危險 | `health <= 6` 且最近威脅 `<= 6` | 最近威脅 `> 12` 持續 3 秒，或 `health >= 12` |
| 需要自衛 | 最近威脅 `<= 6`；task=follow 時另要求主人可見且威脅距主人 `<= 16` | 威脅消失、`> 16`，或追擊距起點 `> 16` |
| 即將落隊 | 主人距離 `> 16` | `<= 8` |
| 安全且有掉落物 | 無威脅、主人距離 `<= 8`、掉落物 `<= 6` 且不在冷卻 | 掉落物消失或主人距離 `> 12` |
| 跟隨卡住 | `now < runtime.followStuckUntil` | 期限到，或主人距離 `<= 3` |
| 跟隨意圖有效 | task=follow、主人可見、距離 `> 3` | 距離 `<= 2` 或主人不可見 |
| 急迫進食 | `food <= 6` 且有食物 | `food >= 14` 或無食物 |
| 一般進食 | `food <= 14`、有食物、無威脅 | `food >= 18`、無食物或出現威脅 |
| 更好裝備 | 無威脅且 `bestArmor` 非空 | 出現威脅或已無更好裝備 |

---

## 5. 資源仲裁（`execution/arbiter.js`）

### 5.1 資源與優先級

資源：`MOVE`、`LOOK`、`HAND`、`INVENTORY`。`VOICE` 不經仲裁，由 `actions/chat.js` 的節流佇列處理（每秒最多 1 則）。

| Action | 資源 | 優先級 |
| --- | --- | --- |
| Retreat | MOVE, LOOK | 100 |
| Eat（急迫） | HAND, INVENTORY | 90 |
| EngageCombat | MOVE, LOOK, HAND, INVENTORY | 80 |
| Eat（一般） | HAND, INVENTORY | 60 |
| Equip | HAND, INVENTORY | 50 |
| CatchUp | MOVE, LOOK | 40 |
| Pickup | MOVE, LOOK | 30 |
| FollowUnstuck | MOVE, LOOK, HAND, INVENTORY | 25 |
| Follow | MOVE, LOOK | 20 |
| Idle | LOOK | 1 |

優先級與資源集合只定義在 `policy.js`；BT 與 arbiter 讀同一份。

### 5.2 Run 狀態

```text
requested ──grant──► active ──cancel──► fencing ──fence ok──► fenced（資源釋放）
                        │                  │
                        └─ 完成 ─► done    └─ fence 逾時 ─► faulted（資源鎖死，觸發斷線）
```

- `owners: Map<resource, { runId, token }>`
- `runs: Map<runId, { nodeId, spec, resources, token, state, adapter, residual }>`
- `token` 每次授予遞增；release、結果回報都必須匹配 runId + token。

### 5.3 每輪 reconcile 演算法

1. 收集本輪請求，依 `priority` 遞減排序；同級時既有 owner 優先，其次依樹的宣告順序（穩定排序）。
2. 依序挑選勝者：請求的資源集合與已選勝者不重疊者入選。
3. 對每個現有 active run：若不在勝者中（被搶佔或請求已撤回），呼叫 `executor.cancel(run)`，狀態轉 `fencing`。
4. 對每個勝者：若所需資源**全部**為空閒（無 owner，或 owner 已 `fenced`），以新 token 授予並啟動；否則本輪等待，回 RUNNING。**不得先持有部分資源。**
5. 下一輪重新評估；等待者不保證得到資源，以最新請求為準。

### 5.4 Control Fence（取代 proposal 第 3 節第 3、5 點）

Fence 的定義：**舊 run 已不可能再對 bot 發出任何操作**。達成 fence 即可釋放資源，不需等待舊 Promise 結束。

Adapter 的 `cancel()` 必須回傳以下其一：

| 回傳 | 意義 | 適用操作 |
| --- | --- | --- |
| `{ fenced: true }` | 已同步停止所有副作用來源，資源可在本輪立即釋放 | `setGoal(null)`、`stopDigging()`、`deactivateItem()`、停止自己的 update 邏輯 |
| `{ fenced: false, until: Promise }` | 有無法同步中止的進行中操作，須等它 settle | 進行中的 `bot.equip()` / `bot.unequip()` |

- `until` 必須在 `policy.fenceTimeoutMs`（初始 1500ms）內 settle，否則該 run 轉 `faulted`：其資源不轉交、停止 runner、記錄錯誤並斷線。**不以固定延遲當作停止證明**（QA Q11）。
- 舊 run 殘留的 Promise（例如 consume 最多 2.5 秒）放入 `residual`，結束時只記錄，**結果因 token 過期而丟棄**，不寫入 runtime、不影響新 owner。
- 所有 adapter 在每個 `await` 之後、發出 bot 操作之前，必須呼叫 `lease.alive()`；回傳 false 就直接 return，不拋錯。

### 5.5 不變式（必測）

1. 任一資源同一時間至多一個 `active` owner。
2. 一個 run 要嘛持有全部宣告資源，要嘛一個都不持有。
3. 被搶佔的 run 必定整組取消，不會只失去部分資源。
4. 舊 token 無法 release 新 owner 的資源，也無法寫入結果。
5. `fencing` 中的資源不會授予他人；`faulted` 資源永不轉交。

---

## 6. Executor 與 Action 契約（`execution/executor.js`）

Action spec 是普通物件：

```js
module.exports = {
  name: 'Follow',
  start(ctx, lease) {},      // 同步啟動；可發起 async 操作但不得 await 在 runner
  update(ctx, lease) {},     // 每個決策輪呼叫一次（active 期間），回傳 undefined 或 { status, reason }
  cancel(ctx, lease) {}      // 回傳 { fenced: true } 或 { fenced: false, until }
};
```

- `ctx = { bot, snap, on(event, fn), policy, now }`。
- **Action 不得自行建立 `setInterval` / `setTimeout`**；週期性邏輯放 `update`。需要的 bot 事件用 `ctx.on()` 註冊，executor 在 fence 時自動移除。
- `update` 與事件處理器若判定完成，回報 `{ status: 'success' | 'failure', reason }`；executor 轉為事件，下一輪寫入 runtime 並讓 action 節點回傳結果。
- 未預期例外：executor 記錄錯誤、將 run 視為 failure 並執行 cancel；若 cancel 本身拋錯，該 run 轉 `faulted`。
- 每 bot 一組 `createExecutor()` closure；跨 run 需保留的狀態（攻擊冷卻）存在 executor 的 `persistent` 物件，不放 module 層級變數。

---

## 7. Actions 規格

### 7.1 Navigation（`actions/navigation.js`）

**Movements profile**（spawn 時建立兩份，只在 profile 改變時呼叫 `setMovements`）：

| Profile | 設定 |
| --- | --- |
| `walk` | `canDig = false`、`allow1by1towers = false`、`scafoldingBlocks = []`、`canOpenDoors = false`、`maxDropDown = 3` |
| `unstuck` | `canDig = true`、`allow1by1towers = true`、`scafoldingBlocks` 為 dirt / cobblestone、`canOpenDoors = false`、`maxDropDown = 3` |

**API 規則**：只用 `bot.pathfinder.setGoal(goal, dynamic)` 啟動、`setGoal(null)` 停止；監聽 `goal_reached`、`path_update`。**禁止 `pathfinder.goto()` 與 `pathfinder.stop()`**（見 D3）。

| Action | start | update / 事件 | cancel |
| --- | --- | --- | --- |
| Follow / CatchUp | profile=walk；`setGoal(new GoalFollow(masterEntity, 2), true)` 一次 | 主人 entity 物件改變（重生）才重設 goal；3 秒內位移 < 0.5 格 → failure `stuck`（runner 設 `followStuckUntil = now + 10s`） | `setGoal(null)` → fenced |
| FollowUnstuck | profile=unstuck；同上 | 同上；離開時由 cancel 切回 walk | `setGoal(null)`；若 `bot.pathfinder.isMining()` 再 `stopDigging()`；profile=walk → fenced |
| Retreat | 選撤退點（見下）；`setGoal(new GoalNear(x, y, z, 1))` | `goal_reached` → success；`path_update.status === 'noPath'` → failure；每 500ms 若最近威脅距離縮短則重選一次 | `setGoal(null)` → fenced |
| Pickup | `setGoal(new GoalNear(dropPos, 1))` | 掉落物 entity 消失 → success；noPath 或 5 秒未到 → failure 並設 30 秒目標冷卻 | `setGoal(null)` → fenced |
| Idle | 不移動 | 每秒最多一次 `lookAt` 最近玩家（`force = true`） | fenced |

**撤退點選取**：以自身為圓心取 8 個方向 × 半徑 {6, 8}，共 16 個候選；保留「腳下為實心方塊、腳與頭位置為空氣、非岩漿／水」的點；分數 = 與所有威脅的最小距離；選最高分。無候選 → failure（Retreat 為最高優先級，guard 仍成立時保持在此分支，不退回較低行為）。

### 7.2 EngageCombat（`actions/combat.js`，取代 mineflayer-pvp）

```text
start:
  若手上不是最佳武器且有武器 → 發起 bot.equip(weapon, 'hand')，記錄 equipPending
  同時 profile=walk；setGoal(new GoalFollow(targetEntity, 2), true)   // 邊追邊換刀
update（每輪）:
  目標 entity 不存在 / 不在 threats / 超出追擊範圍 → success
  若 equipPending 未完成 → 本輪不攻擊
  距離 <= 3 且 now - persistent.lastAttackAt >= cooldown(heldItem):
    lookAt(target 眼睛高度, force = true)
    bot.attack(targetEntity)
    persistent.lastAttackAt = now
cancel:
  setGoal(null)
  若 equipPending 進行中 → { fenced: false, until: equipPending }
  否則 → { fenced: true }
```

- 武器順序：netherite、diamond、iron、stone、golden、wooden 的 sword，其次 axe；無則用現持物。
- `cooldown`：劍 625ms、斧 1000ms、其餘 250ms；初始值，Paper 驗證後調整。
- `lastAttackAt` 存在 executor `persistent`，切換行為不重置。

### 7.3 Inventory（`actions/inventory.js`）

| Action | start | update / 事件 | cancel |
| --- | --- | --- | --- |
| Eat | 若手上不是食物 → `await bot.equip(food, 'hand')`（`lease.alive()` 檢查後）再 `bot.consume()`；consume Promise 存為 residual 候選 | consume resolve → success；reject（含 Food is full）→ failure | 若處於 equip 階段 → `{ fenced: false, until: equipPromise }`；若處於 consume 階段 → `bot.deactivateItem()`，`{ fenced: true }`，consume Promise 轉 residual |
| Equip | 對 `bestArmor` 逐件 `await bot.equip(item, dest)`，每件之間 `lease.alive()` | 全部完成 → success | 進行中那一件 → `{ fenced: false, until }`；件與件之間 → `{ fenced: true }` |

### 7.4 Chat（`actions/chat.js`）

不經仲裁的 FIFO 佇列，每秒最多送出 1 則，佇列上限 5 則（超過丟棄最舊）。

---

## 8. Runner（`bt/runner.js`）

```text
bot.on('physicsTick'):
  tickCount++
  if (tickCount % 2 === 0 || earlyTickRequested) runRound()

runRound():
  if (running) { earlyTickRequested = true; return }   // 禁止重入
  running = true; earlyTickRequested = false
  1. 套用事件佇列 → runtime
  2. perception.observe() → world；revision++
  3. snap = blackboard.snapshot()
  4. requests = tree.tick(snap)
  5. arbiter.reconcile(requests)
  6. executor.updateActive(snap)
  7. 記錄本輪耗時；> 20ms 輸出警告
  running = false
```

- 觸發提早一輪：`entityHurt`（自己）、`health` 事件。
- 主迴圈內不 `await` 任何長操作。
- perception 掃描範圍：威脅 16 格、掉落物 8 格；不做全區塊掃描。

---

## 9. 生命週期

| 事件 | 處理 |
| --- | --- |
| 首次 `spawn` | 建立 movements profile、啟動 runner |
| `death` | 暫停 runner；`generation++`；cancel 所有 run；fence 完成後清空 owners |
| 之後的 `spawn` | 確認無 `fencing` run 後恢復 runner；舊 generation 的事件與結果一律丟棄 |
| `end` / `kicked` / SIGINT / SIGTERM | 停止 runner、cancel 所有 run、移除監聽、保存 intent、斷線；不自動重連 |
| 任一 run `faulted` | 停止 runner、記錄錯誤、斷線 |

---

## 10. 目錄結構

```text
src/
  bot.js                 # 連線、設定驗證、生命週期、組裝
  perception.js          # 世界觀察 → world
  blackboard.js          # 分區狀態、快照、事件佇列
  commands.js            # 主人權限 → intent
  policy.js              # 優先級、資源集合、門檻、逾時
  bt/
    nodes.js             # 五種節點
    runner.js            # 分頻、重入保護、輪次
    companion-tree.js    # 組合子樹
    subtrees/
      survival.js
      combat.js
      work.js
      maintenance.js
  execution/
    arbiter.js           # 整組配置、搶佔、fence、token
    executor.js          # run 生命週期、ctx.on、persistent
  actions/
    navigation.js        # Follow、CatchUp、FollowUnstuck、Retreat、Pickup、Idle
    combat.js            # EngageCombat
    inventory.js         # Eat、Equip
    chat.js              # 訊息佇列
experiments/             # 第 11 節三個實驗腳本（不進 npm test）
test/
  bt-nodes.test.js
  arbiter.test.js
  executor.test.js
  actions.test.js
  commands.test.js
```

---

## 11. 插件實驗（實作 actions 前先做）

在本地 Paper 26.1.2 執行，每個腳本記錄「時間戳、API 呼叫、所屬 runId」。

| # | 場景 | 通過條件 |
| --- | --- | --- |
| E1 | `setGoal(GoalFollow)` 行走中 → `setGoal(null)` → 同 tick `setGoal(GoalNear 另一點)` | 新目標生效；舊 goal 不再觸發 `goal_reached`；控制狀態未殘留。另驗證：呼叫一次 `pathfinder.stop()` 後再 `setGoal()`，重現 D3 問題並記錄 |
| E2 | EngageCombat 對殭屍攻擊中，於 equip 進行中與攻擊冷卻中各取消一次，隨即對同一殭屍重新開戰 | 取消後 0 次 `attack` / `lookAt` 來自舊 runId；equip 取消時 fence 等待時間 < 1500ms；`entity.type === 'hostile'` 判定正確 |
| E3 | Eat 進行中 `deactivateItem()` → 立即 Equip 劍 → 再開始一輪 Eat | 舊 consume Promise 於約 2.5 秒內 reject 且結果被丟棄；新 Equip 與新 Eat 不受影響；`bot.usingHeldItem` 狀態正確 |

任一實驗未通過：記錄觀察結果並回報，**不得以加長等待時間繞過**。

---

## 12. 測試與驗收

### 單元測試（fake bot / fake action，可手動控制 Promise 完成順序）

- 節點：ReactiveSelector 切換時 halt 舊分支；Sequence 游標與重設；persistent Parallel 永不結束；Guard 遲滯；Action 持續 RUNNING 不重啟、重新進入分配新 runId。
- 仲裁：第 5.5 節五項不變式；同級不搶佔；`{ fenced: false }` 期間資源不授予；fence 逾時轉 faulted；Retreat(100) + Eat(90) 同輪取代 Combat(80) 後兩者同時 active。
- Executor：`ctx.on` 監聽在 fence 時移除；舊 token 結果丟棄；未預期例外轉 failure。
- Actions：Follow 只在 entity 改變時重設 goal；Combat 冷卻跨 run 保留、跨 bot 隔離；Eat 在 consume 階段取消回傳 fenced 並 deactivate。

### Paper 驗收（第一版完成條件）

1. 邊跟隨邊進食。
2. 戰鬥中低血 → 撤退 + 進食同時發生，撤退期間無攻擊動作。
3. 撿拾後恢復跟隨。
4. 換裝不打斷進食（Equip 優先級低於一般 Eat，應等待）。
5. 主人跳進 2 格深坑 → Follow 卡住 → FollowUnstuck 挖出／搭出 → 恢復 Follow。
6. 死亡、重生、斷線後無殘留監聽、無舊 run 操作。
7. 連續 10 分鐘交替戰鬥與跟隨：無 unhandledRejection、listener 數量不增長。

---

## 13. 未決事項

| 項目 | 狀態 |
| --- | --- |
| 撤退點品質（角落、多敵人） | v1 用 16 點取樣，Paper 觀察後再改 |
| Guard 門檻與攻擊冷卻數值 | 初始值，Paper 調整 |
| 玩家攻擊的反擊、傷害來源識別 | 不在 v1 |
| LLM、JEV／KEV、agent memory | Pending |
