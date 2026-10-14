# Bot 系統設計提案：反應式行為樹與資源仲裁

狀態：Proposed｜2026-10-14｜[ADR-003](ADR/003-companion-bot-layered-control.md)

> 待修訂：本機插件尚未證明符合本文的停止與交接契約，不能將本文當作已可直接實作的完整設計。最新解釋、跟隨／反擊／逃跑流程與驗證缺口見 [system-design-qa.md](system-design-qa.md)。

第一版即實作 **Reactive Behavior Tree、Blackboard、可搶佔資源鎖**，完成跟隨、自衛、進食、鄰近撿拾與裝備。LLM、JEV／KEV、agent memory 全部 pending，不在本輪制定接口或實作。本文是設計草案，尚未建立程式。

## 1. 分層與層間溝通

| 層 | 職責 | 輸入 → 輸出 |
| --- | --- | --- |
| 感知／Blackboard | 整理自身、主人、敵人、背包、掉落物 | Mineflayer 事件 → 帶 revision 的狀態快照 |
| 戰略層 | 現在接受主人命令；未來 LLM 提出高階意圖 | 命令／模型提議 → 經權限與合法性驗證的 intent |
| 戰術層／行為樹 | 判斷條件、組合步驟、選擇分支及並行行為 | 快照＋intent＋動作結果 → 當輪動作請求集合 |
| 執行層／仲裁器 | 決定資源歸屬、搶佔與清理，執行插件操作 | 動作請求 → 資源 lease、執行結果與原因 |

資料流：**世界 → Blackboard → BT → 資源仲裁 → Actions → 世界**。動作結果回寫 runtime；intent 不會因臨時自衛或吃飯而消失。

同程序以函式傳遞資料；非同步結果先進事件佇列，下一輪套用，避免 BT 遍歷中途狀態改變。Blackboard 分 `world / intent / runtime`，由感知、命令入口、執行器各自更新；節點只讀每輪一致快照。Entity 與 bot 控制物件留在適配層，跨層只傳 ID 與普通資料。

## 2. 行為樹：採用的節點與結構

選用 **JavaScript／CommonJS 的小型自有 BT 核心**：普通物件組成樹，具名函式建立五種節點，不建立 DSL 或繼承框架。這是具有組合、節點狀態與中止語義的行為樹。

| 節點 | 語義 |
| --- | --- |
| ReactiveSelector | 每輪由高到低重評估；選第一個非 FAILURE 分支，切換時 halt 舊分支 |
| Sequence | 依序執行，記住目前子節點；失敗即結束，全部完成才 SUCCESS |
| Parallel | 每輪 tick 所有活動子分支；一般組合全部成功才成功、任一失敗則中止其餘；根節點採持續運行模式，分支結束後下一輪重評估，避免一次撿拾失敗終止整個 bot |
| Guard | 每輪重驗條件；不成立就 halt 子樹並回 FAILURE |
| Action | 同一 run 只啟動一次；執行與等待資源時回 RUNNING，完成／失敗回 SUCCESS／FAILURE |

`halt` 撤回請求並啟動取消，不代表底層已停止；清理中的 run 仍由執行層追蹤。Sequence 外使用 Guard 持續檢查威脅或目標有效性，避免前置條件只檢查一次。切換分支時重設舊子樹游標，重新進入則分配新 runId；持續運行的節點保留原 runId，避免每輪重啟。

```text
Parallel（持續運行）
├─ ReactiveSelector：主要行為
│  ├─ Guard(急迫危險) → Retreat
│  ├─ Guard(需要自衛) → Sequence(確認武器, Combat)
│  ├─ Guard(即將落隊) → Follow
│  ├─ Guard(安全且可短暫繞路) → Pickup
│  ├─ Guard(跟隨意圖有效) → Follow
│  └─ Idle
└─ ReactiveSelector：身體維護
   ├─ Guard(需要且適合進食) → Eat
   ├─ Guard(安全且有更好裝備) → Equip
   └─ Idle
```

兩分支可同時 RUNNING，能否真並行由鎖決定。武器準備與 Combat 共用動作 scope，整段保留資源，避免裝好武器後立即被其他動作換走。

參考過 [Mistreevous 官方文件](https://github.com/nikkorn/mistreevous#nodes)：它提供組合節點與 guard，但一般 selector 會延續 RUNNING 分支，不能直接當作本案的 ReactiveSelector。本次選擇明確實作上述小型核心，代價是自行測試節點語義；尋路與戰鬥仍沿用插件。

## 3. 資源鎖：第一版就實作

資源為 `MOVE / LOOK / HAND / INVENTORY / VOICE`。每個資源同時只有一個 owner；VOICE 由獨立訊息佇列短暫取得，不阻塞其他動作。

| 動作 scope | 一次需要的完整資源集合 | 優先級 |
| --- | --- | --- |
| Retreat | MOVE、LOOK | 100 |
| 緊急進食 | HAND、INVENTORY | 90 |
| 戰鬥準備＋Combat | MOVE、LOOK、HAND、INVENTORY | 80 |
| 一般進食／裝備 | HAND、INVENTORY | 60／50 |
| 追上主人／撿拾／一般跟隨 | MOVE、LOOK | 40／30／20 |

進食優先級依情境決定，普通飢餓不搶斷戰鬥；數值集中定義，BT 與仲裁使用同一份政策。Pickup 指移動到掉落物讓遊戲被動拾取，不包含開箱整理。

仲裁採 **穩定優先級排序＋整組資源配置**：

1. BT 先產生請求，尚不操作 bot。按優先級遞減排列；同級保留既有 owner，再依請求順序決定，避免反覆搶佔。
2. 逐一選出資源集合不重疊的勝者。每個 run 要全部取得才啟動；不得先占部分再等其餘，也不得持鎖後追加資源。
3. 換 owner 時，將整個舊 run 標記 stopping，僅允許適配器執行停止與清理，呼叫 AbortController 與插件停止方法。舊資源維持占用，直到 Promise、監聽器與 finally 全部收尾。
4. 等待不阻塞 tick 或其他無衝突資源。收尾後重驗最新請求與條件，再同步授予整組新 lease；不直接啟動過期等待者。
5. 清理逾時將受影響資源標記 faulted，不強行轉交，必要時斷線。release 必須匹配 runId 與 token，舊 run 不能釋放新 owner 的鎖。

例如 Retreat(100) 和緊急 Eat(90) 共同取代 Combat(80)：先停整個 Combat scope，再分別授予 MOVE＋LOOK 與 HAND＋INVENTORY，形成邊撤退邊吃。跟隨＋一般進食可並行，攻擊＋進食互斥。

導航適配器使用**不挖掘、不放方塊、不換手持物**的 movement 設定；PVP 若覆寫設定也要套用限制。需要挖放的導航另宣告 HAND＋INVENTORY。感知不能私自借用 LOOK；未適配的插件不能開啟背景自動控制。

## 4. 資料結構、演算法與 JS 實作

| 資料 | 結構／用途 |
| --- | --- |
| Blackboard | `{ world, intent, runtime, revision, observedAt }`，每輪一致快照 |
| 樹與節點狀態 | 靜態巢狀物件＋`Map<nodeId, { status, childIndex, runId }>` |
| 動作請求 | `{ nodeId, runId, action, targetId, resources, priority, intentRevision }`，resources 使用 Set |
| 資源所有權 | `Map<resource, { runId, token, state }>`；state 為 active、stopping、faulted |
| 執行紀錄 | `Map<runId, { controller, promise, resources, token, result }>` |
| 目標冷卻 | `Map<targetId, retryAfter>`，避免每輪重試不可達物品 |

BT 遍歷節點，仲裁對少量請求排序，約 O(N log N)，資源種類固定，不需要 heap 或分散式鎖。半徑內目標線性選取，搭配追擊上限、跟隨距離遲滯與失敗冷卻。

以 `createBlackboard / createTree / createArbiter / createExecutor` closure 保存每隻 bot 私有狀態，JSDoc 描述契約。節點提供 `tick / halt`，Action 適配器提供 `start / cancel / settled`。AbortSignal 必須連到插件停止與完成確認，不能只用 Promise.race 假裝操作已停止。

physicsTick 分頻，以約 10 Hz 執行「收事件 → 拍快照 → tick BT → reconcile 資源」；緊急事件可要求額外一輪，但禁止決策重入。長操作存於 run，不 await 在主迴圈、不重複 setGoal；每個 await 後及發出操作前重驗 token。死亡、重生、斷線時更新 session generation，使舊回呼失效。

## 5. LLM、JEV／KEV 與 agent memory：Pending

三者皆暫不設計接口、模型結構、推理頻率或儲存技術，也不新增 adapter 或空目錄。JEV／KEV 不再被解讀成記憶儲存。當前只保持觀察、決策、執行的分離，未來具體如何接入另行討論。

## 6. Folder structure 與驗收

```text
src/
  bot.js                    # 啟動與生命週期
  perception.js             # 世界觀察
  blackboard.js             # 分區狀態與快照
  commands.js               # 主人權限與 intent
  policy.js                 # 優先級與門檻
  bt/
    nodes.js                # 五種節點語義
    companion-tree.js       # 子樹、guards、規則選擇接口
    runner.js               # 分頻、事件佇列與 tick
  execution/
    arbiter.js              # 整組配置、lease、搶佔
    executor.js             # run、取消、清理與結果
  actions/
    navigation.js           # Follow、Retreat、Pickup
    combat.js               # 武器準備與 PVP scope
    inventory.js            # Eat、Equip
    chat.js                 # 訊息佇列
test/                       # BT、仲裁與適配測試
docs/
  system-design-proposal.md
  ADR/
  rules/
  cheatsheet/
```

模型與記憶目錄同樣 pending。舊 ADR 保留歷史；新 ADR 記錄選型，review 保留參考，提案接受後同步 rules 與 README。

先完成 BT＋仲裁核心，再接五項功能。必測高優先分支中止、整組取得、無衝突並行、同級不抖動、取消未完成不交接、舊回呼無效。Paper 驗收「邊跟隨邊進食」「戰鬥被撤退＋進食搶佔」「撿拾後恢復跟隨」「換裝不打斷進食」及死亡／斷線清理；這些是第一版完成條件。
