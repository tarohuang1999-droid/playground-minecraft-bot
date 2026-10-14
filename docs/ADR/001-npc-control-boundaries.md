# ADR-001：以單一行為仲裁保留模型接入邊界

- 狀態：Superseded by [ADR-002](002-simplify-npc-v1.md)。以下是舊設計，僅保留歷史，不作實作依據。
- 日期：2026-10-12
- 取代：design-review-v1.md 的堆疊 FSM、LLM 直接呼叫 skill；以及舊架構的取消後立刻啟動／規則與模型共用分數假設。

## Context

目前是 CommonJS Mineflayer playground。v1 需要跟隨、伐木、自衛與逃跑；使用者後續要接入 LLM 與將 lm_head 改為 decision head 類型的有限動作模型，並支援多 bot。主要失敗風險是長時間 async 操作彼此搶移動、視角、手持物，而非少了一個大型規劃框架。

## Decision

1. 用普通 behavior 物件、純函式 rules selector 和一個有生命週期的 arbiter。安全／反擊／任務是固定 tier；同時只允許一個 active run。
2. 中斷使用 AbortController，但交接要等舊 Promise 與 finally完成。取消超時切faulted並斷線，不強行開第二個控制者。
3. JSON DecisionView 是模型與測試邊界；記憶、Entity、Map 與控制物件不外洩。LLM 提交高階order；分類器從規則產生的合法task集合選擇。模型結果必須有版本、deadline與revision檢查。
4. v1 使用 JS/CommonJS＋JSDoc、Node內建測試、JSON狀態；不新增runtime依賴。單process單bot，已知邊界只保留orders、deciders、skills。
5. v1伐木採一次一格的goto/equip/look/dig流程；新入口不啟用collectblock複合流程。現有套件與舊腳本保留。

## Alternatives considered

| 方案 | 優點 | 不採用原因 |
| --- | --- | --- |
| 堆疊 FSM | 很容易表達worker→combat→resume | 恢復時仍需重取世界、處理async取消；堆疊不是解決資源競爭的必要條件 |
| Behavior tree / GOAP | 複雜任務組合與規劃較方便 | 五個行為尚無需求，增加節點系統、debug與agent上下文成本 |
| 任意 utility 分數混合模型概率 | 表面上容易替換 | 分數尺度不同，不能自然保證安全優先或合法性；改為mask＋tier＋choice |
| 多行為資源鎖 | 可同時跟隨與撿物 | 鎖、死鎖、取消與視角衝突成本高，v1不需要 |
| LLM直接操作skills | 規劃自由度高 | 網路延遲、舊輸出、權限、安全與取消問題會滲入底層 |
| 立即使用collectblock | 已有工具選擇與掉落物收集 | 本機版本有內部async鏈、取消等待與movement變更；為有限v1需求不值得增加仲裁適配成本 |
| TS／資料庫／Manager先建好 | 更強工具與中央管理 | 目前資料和部署規模尚不需要，先保留可擴充邊界，不預建系統 |

## Consequences

- 玩家命令、LLM、Manager共用orders權限；分類器不能改tier或把非法動作變合法。
- Follow／chop可重啟，安全中斷後依最新世界恢復；不保留舊async call stack。
- 單一控制者使v1容易測試，但不能同時導航與獨立撿物；需要並行時必須新增ADR並修改arbiter。
- Primitive伐木可能留下掉落物、不一定砍完整棵樹；這是已記錄的產品限制。
- 小型決策頭不保證低延遲或好策略；訓練、校準、shadow評估與容量測量在模型接入階段做。
- 後續接模型仍需新增adapter、backpressure、stale檢查與測試，不是「替換一行decider」即可上線。

## Revisiting triggers

實際出現並行行為需求、長任務序列、共享隊伍狀態，或量測證實單process單bot成本過高時再評估核心變更。多個類似order／model transport出現後才抽共用框架，不為第二種尚不存在的provider建立抽象層。
