# Implementation Plan: Pending - 延後優化與低優先級項目 (Low-Priority Backlog)

- **狀態**：Deferred / Pending（遵循 KISS & YAGNI 原則，暫不納入 Stage 3 / Stage 4 必做範圍）
- **目的**：將系統健檢（[system-review-2026-10-17.md](agent-note/system-review-2026-10-17.md)）中屬於 **P2 / P3 非阻斷性、或需待實機效能瓶頸出現後才值得投入** 的工程優化集中列管，避免在當前階段造成過度設計（Overengineering）。

---

## 待辦項目清單 (Pending Items)

### 1. [Pending-01] 開門動作獨立拆分 `HAND` 資源微任務 (`SR-06`)
- **背景**：目前普通導航（`NormalFollow` / `Retreat`）僅宣告 `['MOVE', 'LOOK']` 以支援「邊走邊吃」，但遇到關閉的木門時，`DoorManager` 會在導航內部呼叫 `bot.activateBlock(door)`，短暫使用手部與視角。
- **延後原因**：現有 `DoorManager` 已有 1500ms 座標冷卻與開啟狀態檢查，實務上極少與進食發生致命衝突；若為此在 BT 與感知層拆分獨立的 `OpenDoor` 動作與狀態轉換，會大幅增加導航複雜度。
- **觸發條件**：未來在 PaperMC 實測中若明確觀察到「邊開門邊吃東西導致進食頻繁中斷」時再行實作。

### 2. [Pending-02] 感知層 20Hz 全量掃描分頻與快取 (`SR-15`)
- **背景**：目前每個 `physicsTick` (50ms) 皆呼叫 `perception.sample()` 掃描周圍實體與背包，並在每次 `snapshot()` 執行 `structuredClone` + `freezeDeep`。
- **延後原因**：在單一 Bot、視野半徑 32 格內，Node.js 單次掃描耗時通常 `< 0.5ms`。過早引入多層快取（Cache Invalidation）容易引發狀態不同步 Bug。
- **觸發條件**：未來啟動多隻 Bot 或實測 `physicsTick` p95 延遲超過 5ms 時，再將感知拆分為「20Hz 生存血量/威脅快掃」與「4Hz 背包/農地慢掃」。

### 3. [Pending-03] 非同步 Buffered Logger 與跨日日誌切檔 (`SR-13`)
- **背景**：`src/logger.ts` 目前使用 `fs.appendFileSync` 同步寫檔，且檔名固定為啟動當日日期。
- **延後原因**：本地開發與測試階段，同步寫入能確保崩潰瞬間日誌不遺失，且實作僅 49 行極度乾淨。
- **觸發條件**：未來長時間掛機（跨日運行）或磁碟 I/O 明顯拖慢 Event Loop 時，再改為 `fs.createWriteStream` 非同步緩衝寫入與每日切檔。

### 4. [Pending-04] `state-storage.ts` 原子寫入（Temp File + Rename）與多 Bot 隔離 (`SR-12`)
- **背景**：目前 `savePersistentState` 直接 `fs.writeFileSync('data/storage.json')`，且未針對不同伺服器或不同 `botName` 分檔。
- **延後原因**：目前為單機單 Bot 開發，`writeFileSync` 寫入數百 bytes JSON 極快。
- **觸發條件**：未來支援多 Bot 同時運行時，再將路徑改為 `data/storage-${botName}.json` 並加上 `.tmp` rename 原子寫入與嚴格 `Number.isFinite` 校驗。

### 5. [Pending-05] `src/actions/navigation.ts` 內部幾何與尋路輔助函式拆檔
- **背景**：`src/actions/navigation.ts` 目前約 1,756 行，包含門體中心點校正、斜角防卡牆、A* 切片生成器、安全逃跑點搜尋與各導航 Adapter。
- **延後原因**：該檔案雖然較長，但內部各函式已經過 Stage 1 嚴密測試驗證；若僅為了縮減行數而強行拆成 5~6 個零碎檔案，反而增加跨檔引用負擔。
- **觸發條件**：未來需要修改或重用幾何演算法時，再順手將純數學/幾何函式抽離至 `src/actions/nav-geometry.ts`。

### 6. [Pending-06] Executor `FAULTED` 狀態自動重連與 Watchdog (`SR-11`)
- **背景**：當底層動作取消逾時（1000ms `isStopped()` 仍為 false）時，Executor 進入 `FAULTED` 並停止所有動作以策安全。
- **延後原因**：在 Stage 3 修好 `isStopped()` 契約後，正常情況下不會進入 `FAULTED`；目前只需在 `!status` 中顯示 `fault` 資訊即可，無須過度設計自動重連狀態機。
