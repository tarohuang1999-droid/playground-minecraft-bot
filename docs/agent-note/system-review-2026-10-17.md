# System Review：src 健檢（2026-10-17）

- **觀點**：Senior JavaScript / TypeScript Engineer；檢視 correctness、品質、維護性、runtime 穩定性、效能、可觀察性，以及測試、資料完整性、控制權邊界。
- **基準**：HEAD `662bd20e86fbe359a6bc75f1544fb688e64fecea`，另以當下工作目錄中的 Stage 2 計畫為準。既有未提交的計畫與 LLM proposal 未變更。
- **範圍**：`src/` 全部 30 個 TypeScript 檔，共 6,293 行；連同單元測試、Paper E2E、設定、規範及已安裝的 Mineflayer 關鍵實作交叉檢查。未把舊 `base_bot*.js` 列入重構範圍。
- **交付性質**：健檢與建議，沒有修改 production code；下文行號對應本次檢查版本。
- **後續設計**：[Stage 2.4 重構提案](../sys-design/system-design-proposal-session-architecture.md)。

## 1. 結論與優先順序

**現有分層值得保留，但目前不足以只靠拆小 `bot.ts` 就宣稱 runtime 穩定。** Blackboard 的不可變快照、Arbiter 的整組資源配置、Executor 的 generation/token、Runner 的防重入，以及既有測試都是有效基礎。主要問題在於跨模組的時間、任務身分、非同步副作用與資源所有權契約不一致。

建議採取「先補可重現的契約缺口，再抽離組合根、指令控制器、任務 session」的方式。不要重寫 BT／Arbiter，也不要把所有狀態與 callback 搬進另一個大型 manager。

| 面向 | 判斷 | 主要依據 |
| --- | --- | --- |
| Code quality | 中等；型別嚴格設定優於實際型別邊界 | strict 已開，但 `any` 大量穿透 ports；runtime 參數仍靠轉型 |
| 可維護性 | 需改善 | `bot.ts` 696 行、`navigation.ts` 1,755 行、`perception.ts` 711 行；回呼與共享狀態交錯 |
| Runtime 穩定性 | 優先修正 | 時鐘錯配、取消後繼續操作、完成旗標跨任務殘留、全域 API 攔截污染其他 action |
| 效能 | 有具體熱路徑風險，尚無實機量測 | 20Hz 全量感知、多次複製與凍結、BT 內重複查世界、同步檔案日誌 |
| 可觀察性 | 有文字日誌，缺少可關聯的生命週期資訊 | 缺 task/run/token 欄位、fault 狀態、耗時、丟棄與持久化失敗訊號 |
| 測試與可驗證性 | 基礎良好，跨模組缺口明顯 | 134 tests 全綠，但本次額外 probes 仍重現六類缺陷 |
| 控制安全／資料完整性 | 需改善 | 傷害來源猜測、HAND 越權、消失誤報擊殺、存檔錯誤被吞掉 |

嚴重度定義：**P1**＝應優先修正、阻擋 Stage 2.4 穩定性驗收；**P2**＝應排入近期改善；**P3**＝後續整理。這是工程風險排序，不代表每個情境都已在 Paper 實機重現。

## 2. 驗證結果與限制

環境：Node `v26.0.0`、pnpm `10.27.0`、已安裝 Mineflayer `4.39.0`、mineflayer-pathfinder `2.4.5`。

| 檢查 | 結果 |
| --- | --- |
| `pnpm run typecheck` | 通過 |
| `pnpm test` | build 通過；134 passed、0 failed、0 skipped |
| `pnpm run lint` | 通過 |
| `pnpm run format:check` | 通過 |
| 額外 review probes | R1–R6 全部重現；R2 分別檢查 HUNT 與 FARM |
| Paper E2E／長時間 soak test | 未執行；沒有啟動或登入遊戲伺服器 |
| CPU profile／heap profile／event-loop latency | 未量測；效能項目標示為待量測風險 |
| dependency vulnerability audit | 未執行，不宣稱相依套件沒有漏洞 |

Probes 使用編譯後 `dist/src`、假的 Bot/EventEmitter、可控 Promise 與記憶體狀態，未修改正式測試。它們證實應用程式的分支與狀態行為，不等同伺服器網路層驗收。

| Probe | 操作 | 實際觀察 |
| --- | --- | --- |
| R1 | workArea 使用 `Date.now()`，snapshot 使用程序相對時間 `1_200_001`，持續提供合法獵物 | 仍產生 `HuntAnimal`，不觸發 20 分鐘期限 |
| R2 | 同一棵樹先完成空任務、`halt()`、進入 IDLE、再開始同類空任務 | FARM、HUNT 各只有第一次呼叫 finished callback |
| R3 | `attachCompanion()` 後呼叫 Bot 的 `placeBlock`，再 `dispose()` | 被 navigation-only guard 拒絕；dispose 後方法仍非原始方法 |
| R4 | FarmPlant 等待 `placeBlock`；取消並讓 ctx 失效；舊 Promise reject | 仍呼叫一次 `activateBlock` 與一次 `swingArm` |
| R5 | 真正透過 hunting adapter 攻擊 cow，只發 `entityGone` | 記錄 `entityGone confirmed kill`，即使沒有 `entityDead` |
| R6 | 附近有未揮手的玩家；只發自身 `entityHurt`，不提供 source | 該玩家被放入 threats |

## 3. P1：需要優先處理的缺陷

### SR-01：工作期限使用不同時間原點，正常啟動時 20 分鐘限制失效

- **證據**：`src/bt/runner.ts:34` 預設 `performance.now()`；`src/bot.ts:547,577` 用 `Date.now()` 寫入工作開始時間；`src/bt/subtrees/work.ts:194–195,271–272` 直接相減。
- **觸發／影響**：以預設 `startBot()` 啟動 FARM/HUNT，且持續存在目標時，elapsed 是巨大的負值，正常程序生命週期內不會抵達工作期限。R1 已重現這個比較結果。
- **旁支影響**：Executor 的 pickup cooldown 使用 runner 時間，Perception 預設使用 epoch；Perception 的預過濾會失準，但 BT 還有自己的 cooldown 判斷，因此不能直接推論「拾取冷卻完全失效」。`options.now` 也未涵蓋指令、農事、戰鬥等所有時間來源。
- **建議**：在組合根建立同一個 monotonic clock，傳入所有 duration/deadline/cooldown 使用者；epoch 僅供人類日誌。不要只把某一個測試改成 `Date.now()` 掩蓋來源差異。
- **驗收**：經真實 command controller 建立任務，推進同一 fake clock 到期限前後；FARM/HUNT 都必須結束。另驗證換日／wall clock 跳動不影響任務期限。

Node 官方說明 `performance.now()` 的零點為目前 Node 程序啟動時間，不能直接減去 epoch timestamp。[Node Performance API](https://nodejs.org/api/perf_hooks.html#performancenow)

### SR-02：FarmPlant 取消後的失敗分支仍能操作世界

- **證據**：`src/actions/farming.ts:198–238`，`placeBlock` 的 await/catch 後到 fallback 之間沒有檢查 `active`／`ctx.isActive()`；`activateBlock` resolve 後直接 `swingArm`。`isStopped()` 在第 300 行僅回傳 `!active`。
- **觸發／影響**：播種途中被 Combat、指令或死亡取消，舊 `placeBlock` 晚到 reject，仍會執行 fallback。R4 已證實取消後有額外控制呼叫；此時 Executor 已可將 HAND/LOOK 移交給下一個 action。
- **建議**：所有成功、失敗、fallback 路徑在下一次控制操作前檢查 ctx。另分清「只剩回傳結果」與「底層插件仍可能送出操作」；不能用 `active=false` 假裝後者已停止。
- **驗收**：分別延遲 `equip`、`placeBlock`、`activateBlock` 的 resolve/reject，取消後不得再呼叫控制 API 或計入新任務。需涵蓋 library 內部 await 的合約測試，而不只檢查外層 Promise。

### SR-03：NavigationExecutionBoundary 全域覆寫 `placeBlock`，阻擋合法農事

- **證據**：`src/actions/navigation.ts:703` 建構時 `boundary.install(bot)`；`src/actions/navigation-guard.ts:76–105` 攔截全部 `bot.placeBlock`，要求 navigation context、bridge capability 與放置白名單；FarmPlant 不建立此 context。
- **觸發／影響**：正常組合後播種的主要 `placeBlock` 路徑被拒絕，反而依賴 fallback 到 `activateBlock`。獨立 farming adapter 測試未組合 navigation wrapper，無法發現此衝突。R3 已重現 guard 拒絕。
- **建議**：將導航挖放與農事放置權限分開，保留原始方法的明確受控入口。未知呼叫維持拒絕；不能以「沒有 navigation context 就一律放行」修補。每個入口都必須驗證自己的 run、token、generation 與資源。
- **驗收**：使用同一個 Bot 同時組合 navigation/farming，驗證合法播種可進到原始放置方法、非法導航仍被阻擋，且取消後兩者均不可操作。

### SR-04：完成旗標不是 task-scoped，第二次任務可能永遠不退出

- **證據**：`src/bt/subtrees/work.ts:230–256,310–336` 的兩個 `*FinishedTriggered` 是樹外閉包旗標。只在 guard 的 `exit` callback 嘗試重設；`guard.halt()`（`src/bt/nodes.ts:125` 附近）清除 node state，沒有重設這些閉包。
- **觸發／影響**：第一次完成後 selector 切去其他分支並 halt，下一次同類任務無目標時，finished callback 被永久抑制，產生 Idle request 卻留在 FARM/HUNT intent。R2 分別重現兩種任務，連 `tree.halt()` 都無法清掉旗標。
- **建議**：把完成判定與一次性呈現移出 BT callback，使用 `(generation, taskId)` 的 terminal transition；BT 只讀取本輪任務投影。
- **驗收**：連續開始／完成三輪同類任務；完成後切 FOLLOW 再重啟；死亡重生後重新派工。每輪各產生一次完成摘要與一次 intent 轉移。

### SR-05：無來源傷害會讓旁觀玩家變成反擊目標

- **證據**：`src/bot.ts:338–385` 在沒有 source 時取 4.5 格內玩家，依揮手時間排序後無條件取第一位；沒有要求最近真的揮手、也沒有時間窗或可信傷害來源。`recentArmSwings` 只在 reset 清空。
- **觸發／影響**：摔傷、環境傷害、怪物攻擊時旁邊剛好站著玩家，就可能反擊該玩家；若為 owner 還會意外切換 STAY。R6 已重現完全沒有揮手事件的旁觀者被標為 threat。
- **規範差異**：直接違反 `rule-typescript-coding.md` RULE-08；現有 attacker-inference 測試只驗證猜測成功情境。若要保留玩家反擊產品行為，必須另定可靠證據來源；不能把測試通過當成安全證據。
- **建議／驗收**：沒有可靠來源就不推定玩家攻擊者；附近玩家、過期 swing、環境傷害均不得建立玩家 threat。已確認的 hostile mob 防禦保留。

### SR-06：開門使用 HAND 卻未取得 HAND，停止確認也沒有反映底層操作

- **證據**：`src/bt/subtrees/work.ts:26–31` 的普通導航只持有 MOVE/LOOK；`src/actions/navigation.ts:820,989,1148` 等路徑仍呼叫 `DoorManager.tryOpenDoorInFront()`，內部第 296 行呼叫 `activateBlock`。cancel 先 `doorManager.reset()` 把 inFlight 設 false，再由 `isStopped()` 讀這個旗標。
- **底層查核**：已安裝 `mineflayer/lib/plugins/inventory.js:195–245` 的 `activateBlock` 會先 await `lookAt`，然後送 `block_place` 與揮手。單純清本地旗標無法取消這個 continuation。
- **影響**：跟隨／撤退與 Eat 的「不衝突並行」有例外；開門會使用手部並可能在控制權交接後繼續送出操作。這是來源與資源契約的靜態確認，尚未在 Paper 上量測干擾進食的頻率。
- **建議**：開門走事前宣告 HAND 的互動 action／run；純導航遇門先產生 observation，再由下一輪原子取得完整資源。持有 HAND 的 action 不存在時，不得偷開門。停止確認依真實控制能力，不依被 reset 的布林值。
- **驗收**：門前 Follow + Eat、撤退中遇門、開門 await 中死亡／搶佔；不得有未取得 HAND 的互動，也不得有移交後的舊操作。

## 4. P2：資料、生命週期與可觀察性

### SR-07：狩獵把「消失」當「擊殺」，且沒有任務期歸屬

- **證據**：`src/bot.ts:323–335` 把 attacked entity 的 `entityGone` 當 confirmed kill；`src/actions/hunting.ts:172–199` 的 `isDeadOrGone` 混合死亡、失效與失蹤。計數回呼沒有 taskId。
- **影響**：打過的動物離開追蹤範圍或被移除，會被誤報擊殺（R5）。`!stop`／`!follow` 沒有統一結束 session；同類新命令清空計數卻未保證換 run。單純 entity ID Set 也無法解決跨 session 的晚到事件。
- **建議**：`entityGone` 僅表示失去觀察；死亡證據與攻擊紀錄由 session 整合。即使 `entityDead` 加曾攻擊，也只能合理稱「參與攻擊後觀察到死亡」，不能保證最後一擊；需要精確歸因時另取伺服器證據。
- **驗收**：attacked+gone、unattacked+dead、dead+gone 去重、Combat 搶佔後 dead、新 hunt 後舊回呼、entity ID 重用。

本地 Mineflayer `entities.js:292–301` 明確將 `entity_destroy` 映射為 `entityGone`；`entityDead` 則由 status 3 映射。官方 API 亦列為不同事件：[Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)。

### SR-08：BT 內讀 live world／發出完成副作用，單輪快照邊界被穿透

- **證據**：`src/bt/subtrees/work.ts:191–224,268–307` 經 callbacks 直接呼叫 Perception 查世界；finish 與 retry callback 在 tree evaluation 內 enqueue intent、聊天、寫 log。
- **影響**：guard 與 describe 重複搜尋，測試必須理解閉包回呼；無法僅靠 snapshot 重播決策。搜尋結果 null 同時代表沒有目標、目標都在冷卻或區塊不可見，卻被視為 COMPLETED。
- **建議**：本輪先求出 typed observation（ready／temporarily-unavailable／exhausted／unknown），再凍結 snapshot。TaskSession 在決策前執行期限／完成歸約；navigation failure 在 outcome 階段處理。等待冷卻與完成任務必須有不同語義。
- **補充**：期限判定放在 work subtree 也會被更高分支長期遮蔽；SR-01 修好後，仍需讓 session deadline 不依賴當輪 work subtree 是否被 tick。

### SR-09：dispose 未恢復包裝方法，patch/listener 所有權不完整

- **證據**：`src/bot.ts:616–632` 只移除直接註冊事件；未呼叫 `boundary.uninstall(bot)`。`src/actions/navigation.ts:491–515` 額外包裝 pathfinder 方法並註冊匿名 `path_update` listener，沒有 disposer。
- **影響**：在同一 Bot detach/attach，可能層層包裝 `dig/placeBlock`、留下舊閉包；舊 boundary 仍拒絕新 run。R3 已確認方法沒有還原。既有 FakeBot 沒有完整 pathfinder，listener 清理測試未涵蓋這一層。
- **建議／驗收**：每一個訂閱、patch、timer 都有明確 owner 與冪等 disposer；同一 Bot 重複 attach/dispose 100 次，比對事件數與方法身分回到基準。只恢復仍由自己持有的 wrapper，避免覆蓋其他插件更新。

### SR-10：播種與 Spawn 的成功語義過於樂觀

- **證據**：`src/actions/farming.ts:255–261` 把任意非空方塊、種子減少，甚至 `!aboveBlock` 當成功。`src/actions/navigation.ts:1605–1616,1660–1671` 發出 `activateBlock` 後立刻 `onSpawnSet`，沒有等成功確認。
- **影響**：區塊未知、他人放置或操作失敗時可能回報成功，Spawn 座標還會立即存檔。這是靜態可達分支，尚未做伺服器確認測試。
- **建議**：未知資料不得等於成功；作物需符合預期 crop type，種子差異僅作輔助證據。Spawn 區分「已要求設定」與「已確認設定」，若目前協定無可靠確認，就在狀態與訊息上明示限制。

### SR-11：FAULTED 會封鎖全部執行，使用者只看到機器人不動

- **證據**：`src/execution/executor.ts:90,101` 有 fault 即拒絕 reconcile，包括 VOICE；`runtime()` 沒帶 fault 原因，`bot.ts` status 只列 RUNNING actions。Runner `decide()` 僅有 finally，Perception/BT 意外 throw 沒有上層失敗策略。
- **影響**：取消失敗後，連聊天回覆也可能停住；status 可能看似 Idle。取消 timeout 的「20 ticks」也不是在伺服器／事件循環停頓時保證 1 秒實時。
- **建議**：保留 fail-closed，但暴露 health/fault 與 owner/run/reason；定義可控關閉／重連程序。無法證明舊控制停止時，不允許 `!stop` 直接清鎖再繼續。急迫錯誤至少可透過獨立 logger／操作端看到，不應依賴已被封鎖的 Chat action。

### SR-12：持久化缺少完整驗證與失敗回報

- **證據**：`src/state-storage.ts:23–34` 只驗證 x，y/z 強制 Number 轉換，可得到 NaN；第 49 行直接覆寫檔案，catch 靜默忽略。`perception.ts` 同時負責感知、base/spawn 狀態與檔案 I/O。
- **影響**：損壞檔案可能生成無效座標；寫入失敗仍向玩家表示成功；中斷寫入可能破壞舊資料。預設單一 `data/state.json` 在多 Bot／多伺服器使用時亦無 namespace。
- **建議／驗收**：完整驗證 x/y/z 為 finite number；回傳 typed load/save result、記錄錯誤；同目錄暫存檔完成後 rename、單一序列化寫入者。若有多實例需求，再以 server/bot/dimension 隔離，先不引入資料庫。

### SR-13：日誌量多，但缺少診斷所需的結構與可控成本

- **證據**：`src/logger.ts:15–35` 固定啟動日期檔名、每筆 `appendFileSync`、debug 無過濾；JSON.stringify 在 try 外，circular data 可 throw。`src/actions/chat.ts:28` 佇列滿回傳 false，但大部分呼叫端忽略。
- **影響**：磁碟慢會拉長事件迴圈；寫入失敗不可見；長期運行沒有跨日切檔；`[hunting]` 文字不足以關聯是哪一次 task。聊天 queue 有界是優點，但完成通知可能被丟棄而沒有訊號。
- **建議**：保留小型 logger，增加 level、結構化 context、非遞迴 serialization fallback、bounded async buffer 與 flush/close；監控 dropped logs/chat。任務完成先儲存 terminal summary，訊息傳送成功與任務完成分開。不要宣稱聊天室端到端 exactly-once。

## 5. 型別、效能與規範落差

### SR-14（P2）：strict TypeScript 的效益被 `any` 與可選 port 弱化

`rg -n '\bany\b' src --stats` 得到 194 次文字匹配、164 行、9 檔（文字搜尋值，不等於 AST 型別數量）。`eslint.config.mjs` 關閉 `no-explicit-any`，也未啟用 type-aware Promise 規則。`CompanionPort` 宣告不足以描述 action 實際需要的能力，組合時普遍 `bot as any`；`ActionRequest.params` 用寬鬆 primitive Record，錯誤參數可被 `Number(undefined)` 轉成 NaN。

建議逐個邊界收斂：使用 Mineflayer 型別的 `Pick` 或小型結構 port，FakeBot 用 `satisfies`；先讓新增 session/controller/registry 零 any，再處理既有模組。對高風險 action params 使用有限的 discriminated union，避免複雜泛型框架。型別規則分階段提高，不做整庫一次性替換。

### SR-15（P2，待量測）：同步感知與日誌是優先 profiling 對象

| 路徑 | 可確認的成本 | 建議與驗證 |
| --- | --- | --- |
| `bot.ts:285–289` → `perception.sample()` | 每個 physicsTick（名義 20Hz）掃 entity、inventory；符合條件時找床，即使 BT 通常 10Hz | 分開 cheap safety sample 與 bounded work scan；記錄各 phase p50/p95/p99 |
| `work.ts` guard／describe → `getAvailableFarmland` | 同輪重複 `findBlock`；`perception.ts:637` 搜尋半徑固定 32 | 每 snapshot 共用搜尋結果；區塊未知保留 unknown；加短 TTL／事件 invalidation |
| `runner.enqueue` → `board.setWorld` → `snapshot` | 同一 world 多次 structuredClone，runtime 也多次 clone，再 deep freeze | 量測 allocation/GC 後減少重複複製；不能直接移除不可變保護 |
| `logger.ts:30` | 同步 I/O；戰鬥與 farming 經常 info log | 有界非同步 sink、level/sampling；同場景比較 loop delay |
| `recentArmSwings`／animal cooldown maps | swing 無 TTL pruning；animal cooldown 主要在 hunt 查詢時清理 | 保留有界時間窗；長連線 entity churn 下比較 map size／heap |

不建議先替小型固定資源 Arbiter 換 heap，也不建議未 profile 就加 worker 或全域 event bus。把測試執行時間當遊戲 runtime 效能指標沒有意義。

### SR-16（P2/P3）：文件、設定與實作沒有單一可信契約

- `navigation.config.ts` 設定 `allowParkour=false`、`allowSprinting=true`；`setupMovements()` 預設卻為 true/false。quota 設定為 3，但 `createNavigationTaskState` 另寫死 3；tick/fence config 也沒有成為所有時間邏輯的來源。
- Stage 2.4 計畫提到 `createCompanionBot`、`CompanionCore`、`enqueueCommandEvent`、`GoToPoint`、`setInterval`；目前實作為 `startBot`、`createRunner`／`enqueue`、`ComeOnce`、Mineflayer `physicsTick`。照文字直譯容易引入第二套 runtime。
- RULE-05 的無條件一 tick 移交、RULE-4.3 的動態 canDig，與 Stage 1 後來的固定資源契約／取消確認已衝突。應以明確修訂統一；不應要求實作同時符合互斥規則。
- Stage 2 通則仍寫任務後返回集合點，但現行 action 與工作日誌採原地 IDLE。死亡測試則明確保留 intent；不可在抽離 session 時悄悄改成所有任務都自動續跑或全部清空。
- 工作範圍目前主要限制目標位置，沒有保證 Bot 的實際路徑留在半徑內；Farm 的站位可在邊界外。若要求的是 Bot 活動範圍，需加入位置／路徑守衛，而非只篩 target。
- `package.json` 未宣告 `engines`／`packageManager`，同時存在 npm/pnpm lockfile；`src` 直接 import `vec3`，但它不是直接 dependency。應確認唯一安裝流程與直接依賴歸屬；本次未改 lockfile，也未做乾淨環境安裝。

## 6. 已有優點與應保留的設計

1. **Arbiter 小而明確**：整組取得資源、同優先級保留 incumbent、release 同時比 runId/token；不需要重寫。
2. **Executor 先撤銷再 cancel**：晚到結果有 generation/token fence；缺口在 adapter／插件控制層，不代表整個模型不可用。
3. **Runner 有防重入與事件合併**：world、status、最終 intent 適合 coalescing；新增任務事件時需另定不可丟失的順序契約。
4. **Blackboard detach + deep freeze**：避免世界物件直接污染歷史 snapshot，已有行為測試。
5. **Chat 有 rate limit 與 queue bound**，commands 有 owner 判斷；應補失敗可見性而非移除保護。
6. **Pathfinder 相容性測試有價值**：它實際檢查 movement／挖放邊界；需要補完整組合路徑，不能只留 isolated mock。

## 7. 建議執行順序與測試缺口

| 次序 | 工作 | 必要測試／結果 |
| --- | --- | --- |
| 1 | 統一 clock、修掉 stale fallback 與全域 placeBlock 衝突 | R1/R3/R4 轉成契約回歸測試；加 library 內部延遲控制測試 |
| 2 | 固定任務身分與完成生命週期 | R2；同類新命令、替換、停止、搶佔、死亡、重生、晚到結果 |
| 3 | 修正傷害、開門、擊殺證據 | R5/R6；HAND 並行、dead/gone 去重、未知結果不能當成功 |
| 4 | 抽離 controller/session/registry，補 disposer | 指令行為對照、100 次 attach/dispose、完整插件組合 |
| 5 | 可觀察性與 persistence 契約 | fault status、queue full、磁碟錯誤、malformed state |
| 6 | 量測後優化 perception/navigation | 相同 Paper 場景的 phase latency、heap、CPU 比較 |

既有測試的主要盲點：時間測試手工建一致 timestamp，未走預設 wiring；farming 測試未帶全域 navigation wrapper；取消測試只問 `isStopped()`；完成測試只跑一次任務；生命周期 FakeBot 未涵蓋 plugin patch；Paper E2E 只有 follow/unfollow/status。保留有價值的 134 tests，新增上述跨模組與負向情境，不用為了數量重複常數／實作細節測試。

## 8. Stage 2.4 的判定

**能改善 code，而且值得優先做；但原計畫的驗收不足以證明穩定性。** 拆出 CommandController 與 TaskSession 是合理方向；行數 <220 可作輔助指標，無法替代生命週期不變式。ActionRegistry 應保持組裝職責，避免成為新的業務容器；Session 不應直接同時掌管 Bot 訂閱、chat、storage 與 executor。

詳細的模組界線、事件順序、session 狀態、取消策略、分階段遷移與驗收矩陣，見 [system-design-proposal-session-architecture.md](../sys-design/system-design-proposal-session-architecture.md) 與 [system-design-proposal-llm-kev.md](../sys-design/system-design-proposal-llm-kev.md)。

---

## 9. 補充健檢：面向未來 Jev/Kev + Small LLM Tool-Call 架構之可演進性 (AI Readiness Audit)

若未來目標是以 **「Jev/Kev 識別與選擇 + 小模型 Tool-Call 分拆 (`[action1(args), action2(args)]`) + 任務管理 + Jev 成立辨別」** 取代行為樹（BT），並實現非同步「邊走邊想、不中斷移動」，現有 `src/` 程式碼存在以下 4 個必須在 Stage 2.4 一併對齊的架構缺口：

### SR-17：Action 參數型別鬆散（`Record<string, string | number | boolean>`），缺乏 Tool Schema 與前置成立檢查介面
- **證據**：[`src/execution/types.ts:12`](file:///Users/james/projects/playground-mineflayer/src/execution/types.ts#L12) 將 `ActionRequest.params` 定義為無結構 Record；各 Action（如 [`farming.ts:30–36`](file:///Users/james/projects/playground-mineflayer/src/actions/farming.ts#L30-L36)、[`hunting.ts:73–78`](file:///Users/james/projects/playground-mineflayer/src/actions/hunting.ts#L73-L78)）各自用 `Number(request.params.x)` 轉型，且前置條件檢查分散在 [`bot.ts`](file:///Users/james/projects/playground-mineflayer/src/bot.ts#L519-L555)（指令入口）與 [`work.ts`](file:///Users/james/projects/playground-mineflayer/src/bt/subtrees/work.ts#L191-L201)（BT guard）兩處。
- **對 Jev + 小模型的阻礙**：
  1. 小模型進行 Tool Calling 時需要明確的參數規格，而「Jev 階段四：辨別行動是否成立」需要在動作送進 `Arbiter` 前，快速驗證該 `action(args)` 在最新 `BlackboardSnapshot` 下是否合法（例如種子是否足夠、目標實體是否仍在範圍內）。
  2. 若前置條件繼續散落在 `bot.ts` 與 `work.ts`，未來拔除 BT 時就會連帶把安全驗證一起拔掉。
- **重構對策**：在 Stage 2.4 抽離 `ActionRegistry` (`src/actions/index.ts`) 時，為每個 Action 定義標準的 `ActionSpec`（包含強型別參數驗證與純函式 `validatePreconditions(snapshot, params)`），讓現階段的 `CommandController` / `BT` 與未來的 `Jev Verifier` / `Small LLM Tool-Caller` 共用同一套前置檢查。

### SR-18：動作完成結果（`ActionResult`）缺乏結構化領域數據，無法直接支撐多步任務推進與 RL Reward 計算
- **證據**：[`src/execution/types.ts:14–17`](file:///Users/james/projects/playground-mineflayer/src/execution/types.ts#L14-L17) 的 `ActionResult` 只有 `{ status: 'SUCCESS' | 'FAILURE', reason?: string }`。實際的業務進度（種了幾顆種子、殺了哪隻動物、因為什麼原因卡住）全部透過 [`bot.ts:110–167`](file:///Users/james/projects/playground-mineflayer/src/bot.ts#L110-L167) 的私下回呼（Side-channel callbacks）修改閉包變數。
- **對 Jev + 小模型的阻礙**：
  1. 小模型拆解出 `[action1(args), action2(args)]` 後，任務管理器需要知道 `action1` 的結構化結果才能決定是否推進至 `action2` 或觸發重規劃。
  2. Kev/Laya 的強化學習（RLCD / GRPO）需要自動收集每個 `runId` / `taskId` 期間的客觀回報（Reward）。
- **重構對策**：在 Stage 2.4 導入 `TaskSessionManager` 時，將原本散落的私下回呼統一改為結構化的 **Domain Facts（領域事實事件）**，同時服務現階段的統計回報與未來的多步任務排程及 RL 軌跡記錄。

### SR-19：`Runner` 的事件佇列以 `event.type` 為 Map Key 覆寫，無法承載連續多步任務或非同步認知事件
- **證據**：[`src/bt/runner.ts:37,76`](file:///Users/james/projects/playground-mineflayer/src/bt/runner.ts#L37) 使用 `new Map<RunnerEvent['type'], RunnerEvent>()`。若在同一個 100ms 視窗內連續推入兩個同類事件（例如任務管理器快速切換步驟，或同時收到多個領域事實），前一個事件會被無聲覆蓋。
- **重構對策**：將 `Runner` 的事件佇列拆分為 **Latest-Value State（如 `world` 快照覆寫）** 與 **Ordered Command/Fact Queue（有序佇列）**，為非同步認知管線鋪平道路。

---

## 10. 工程決策建議：先開發剩餘功能再一起重構，還是先進行部分優化重構？

### 結論：**強烈建議「先執行 Stage 2.4 局部核心重構 + P1 阻斷缺陷修復」，再開發 Stage 2.5~2.8 剩餘功能，最後接入 Jev/LLM。**

不建議「把 Stage 2.5 (`!farm`)、2.6 (`!harvest`)、2.7 (`Sleep`)、2.8 (`!box`) 全部硬塞進現有架構寫完後才大重構」，也不建議「現在就過度設計完整的 AI 框架」。原因如下：

1. **現有 P1 缺陷會直接卡死後續功能的開發與測試（技術債複利效應）**：
   - **全域 `bot.dig` / `bot.placeBlock` 攔截問題 (`SR-03`)**：目前 [`NavigationExecutionBoundary`](file:///Users/james/projects/playground-mineflayer/src/actions/navigation-guard.ts#L43-L104) 全域綁架了 `bot.dig` 與 `bot.placeBlock`。若不先修好這個邊界，接下來開發 **Stage 2.6 `!harvest`（必須呼叫 `bot.dig(cropBlock)` 收割成熟作物）** 時，只要一組合導航模組就會被直接拒絕拋錯。
   - **時鐘錯配 (`SR-01`) 與 BT 閉包完成旗標卡死 (`SR-04`)**：這兩個問題目前已經讓 `!hunt` 與 `!farm` 的第二次執行與 20 分鐘工時限制失效。若不先抽離 `TaskSessionManager` 並統一 `Clock`，接下來寫 `!harvest` 與 `!box` 若照抄 [`work.ts`](file:///Users/james/projects/playground-mineflayer/src/bt/subtrees/work.ts) 的寫法，等於把壞掉的模式再複製三遍，事後重構成本翻倍。
   - **`bot.ts` 認知負荷已達臨界點**：目前 [`src/bot.ts`](file:///Users/james/projects/playground-mineflayer/src/bot.ts) 已有 697 行。若再把收割補種、夜間睡眠甦醒、箱子註冊/存取/破壞監聽全部塞進 `attachCompanion()` 閉包中，`bot.ts` 將突破 1,100 行，屆時拆解極易改壞既有測試。

2. **分三步走的最佳路徑（兼顧速度、穩定度與未來 AI 演進）**：
   - **Phase A（現在立即做：Stage 2.4 精準重構 + P1 修復）**：
     - 修掉 `SR-01`（統一單調時鐘 `Clock`）、`SR-02`（`farming.ts` 取消後副作用防護）、`SR-03`（解開 `bot.dig / placeBlock` 對非導航 Action 的誤殺）、`SR-05`（移除無來源傷害盲猜玩家）。
     - 落地 Stage 2.4：將 [`src/bot.ts`](file:///Users/james/projects/playground-mineflayer/src/bot.ts) 拆分為 `CommandController`、`TaskSessionManager`（修復 `SR-04`、`SR-07`）與具備前置驗證介面的 `ActionRegistry`。
   - **Phase B（在乾淨底座上快速交付 Stage 2.5 ~ 2.8 功能）**：
     - 在新的 `ActionRegistry` 與 `TaskSessionManager` 底座上完成 `!farm` 收尾、`!harvest`、`Sleep` 與 `!box`。此時新增每個功能都只需獨立新增 `src/actions/*.ts` 並註冊，完全不用再動 `bot.ts` 核心，開發速度更快且零狀態污染。
   - **Phase C（Stage 3：平滑切換至 `Jev/Kev + Small LLM Tool-Call` 架構）**：
     - 由於 Phase A 的 `ActionRegistry`（直接對應小模型的 Tool Schemas 與 Jev 階段四驗證）與 `TaskSessionManager`（直接對應任務佇列管理與 RL Reward 收集）已預先對齊介面，屆時只需以 `CognitiveOrchestrator` 替換 `src/bt/**`，完全不需重寫底層 Action 或 Session。

