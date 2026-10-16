# 測試編寫規範與防劣化鐵律 (rule-testing.md)

- **適用對象**：全專案單元測試（`test/unit/**`）、整合測試（`test/integration/**`）編寫、維護，以及 AI Coding Agent 測試設計。
- **核心目標**：確保測試具備高信號比、真實防護力，杜絕無效/虛榮測試（Vanity Tests）與鏡像維護負擔。

---

## 1. 核心測試原則 (Core Testing Principles)

* **行為與不變式導向 (Behavior & Invariant Driven)**：
  * 測試應著重驗證公開契約（Public Contract）、狀態轉移（State Transitions）以及領域不變式（Domain Invariants）。
  * 避免過度依賴對私有變數或內部函式調用次數的細節 Mock。
* **反鏡像測試與變更偵測器 (Anti-Tautology & No Change Detectors)**：
  * **嚴禁編寫純常數鏡像測試**：禁止單純把設定檔的靜態常數複製一份用 `assert.equal(config.val, 123)` 比對。此類測試只會在合理調參時引發假陽性（False Positive）失敗。
  * 設定檔測試應著重於**不變式檢驗**（例如：退出門檻必須嚴格小於進入門檻 `exit < enter`、緊急飲食血線必須小於常規飲食血線 `emergencyFood < routineFood`）。
* **禁止測試未使用的死代碼 (No Testing Dead Code / YAGNI)**：
  * 測試代碼的唯一目的是守護正在執行的業務邏輯。
  * 若某功能已被廢棄、或尚未有實際業務調用（如實驗性/未接入的 Node 變形），必須與業務代碼一同刪除，嚴禁為了「維持假性覆蓋率」而保留孤立的測試案例。
* **單一職責與測試內聚 (Single Responsibility & Cohesion)**：
  * 測試檔案應對應具體業務模組命名（例如 `chat.test.ts`、`commands.test.ts`、`navigation.test.ts`）。
  * 禁止使用過渡性里程碑名稱（如 `stage-two-components.test.ts`）作為長期測試檔名，專案推進後必須及時重組歸位。
  * 嚴格禁止不同測試檔案間存在重複的 Arrange-Act-Assert 測試案例。

---

## 2. 測試編寫鐵律 (Strict Testing Rules)

任何負責編寫與維護測試的 AI Agent / 開發者必須遵守以下條例：

1. **[TEST-01] 標準 AAA 架構 (Arrange-Act-Assert)**：
   * 每個測試必須清晰分為三段：準備資料/狀態（Arrange）、觸發單一受測行為（Act）、斷言預期結果（Assert），禁止在一組測試內無節制混雜多次獨立行為。
2. **[TEST-02] 協議與環境真實性 (Protocol Alignment)**：
   * 測試所模擬或發送的指令必須符合真實運行時規範（例如全專案 Chat 指令必須以 `!` 開頭）。
   * 嚴禁在測試中殘留已過時的指令語法，避免整合測試無效掛起（Timeout）。
3. **[TEST-03] 零殘留與隔離性 (Hermetic Tests & Cleanup)**：
   * 測試不得污染外部環境。若測試過程建立暫存檔案（如 `data/test-*.json` 或 `logs/test-*`），必須在 `finally` 或 `t.after()` 內保證被徹底清理。
   * EventEmitter 與定時器必須在測試結束時明確解綁（`dispose()` / `removeAllListeners()`）。
4. **[TEST-04] 非同步與競態測試必須明確邊界**：
   * 針對非同步動作（Promise, setTimeout, Physics Tick 柵欄），必須測試中途被取消（Preempted / Cancelled）或 session 重置時，舊回呼不能產生任何副作用（No Stale Continuation Effects）。
5. **[TEST-05] 交付前完整驗證**：
   * 提交測試重構或新測試前，必須先執行型別檢查（`pnpm run typecheck`）與測試套件（`pnpm test`），確保通過率為 100%。

---

## 3. 測試檔案組織對應表

| 模組路徑 | 對應單元測試路徑 | 測試核心範疇 |
| :--- | :--- | :--- |
| `src/config/**` | `test/unit/config.test.ts` | 閥值不變式檢驗（遲滯區間合法性、時間範圍邊界） |
| `src/bt/nodes.ts` | `test/unit/bt-nodes.test.ts` | 核心控制節點原語（selector, sequence, parallel, recovery） |
| `src/bt/runner.ts` | `test/unit/runner-pipeline.test.ts` | Physics Tick 排程、事件收斂、世代防重入 |
| `src/bt/subtrees/**` | `test/unit/{retreat,combat,pickup,maintenance}.test.ts` | 各子樹決策門檻與搶佔優先級 |
| `src/commands.ts` | `test/unit/commands.test.ts` | 指令語法解析、大小寫相容、陌生人權限過濾 |
| `src/actions/chat.ts` | `test/unit/chat.test.ts` | 訊息隊列上限、頻率限制（Rate-limiting）、佇列重置 |
| `src/execution/**` | `test/unit/arbiter.test.ts`, `executor-fence.test.ts` | 資源通道競爭仲裁、Tick 柵欄與釋放邊界 |
