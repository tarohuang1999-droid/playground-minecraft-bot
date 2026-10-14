# ADR-003：採用反應式行為樹與可搶佔資源鎖

- 日期：2026-10-14
- 狀態：Proposed（BT 與資源鎖為已明確要求；以下實作設計待審閱）
- 關係：擬取代 [ADR-002](002-simplify-npc-v1.md)；ADR-001／002 保留歷史，接受本案後再更新取代狀態。
- 設計：[system-design-proposal.md](../system-design-proposal.md)
- 待驗證：插件停止與非同步交接尚未確認可行；最新說明見 [設計 QA](../system-design-qa.md)。本 ADR 不代表已完成工程驗證。

## 背景

第一版提供跟隨、自衛、進食、鄰近撿拾與裝備。使用者要求採用 [review](../reviews-by-ai.md) 的行為樹與資源鎖方向，並預留 LLM、JEV／KEV 模型分類器／選擇器。Agent memory 是獨立的未來能力。

需要反應式中止與合法並行，例如戰鬥轉為撤退＋進食。插件可能跨用移動、視角與背包；單執行緒仍有非同步交接競態，BT 決策與資源生命週期必須分開。

## 決策

1. 分為感知／Blackboard、戰略意圖、戰術 BT、執行仲裁。Blackboard 分區更新，每輪讀取一致快照；長期 intent 與當前動作分離。
2. 第一版實作 ReactiveSelector、Sequence、Parallel、Guard、Action，以主要行為與身體維護子分支並行。採 JS／CommonJS 普通物件與 closure 的小型 BT 核心，明確定義每輪重評估與 halt。
3. 實作 MOVE、LOOK、HAND、INVENTORY、VOICE 所有權。每輪先產生請求，再穩定按優先級配置整組資源；同級保留 owner，不允許持部分鎖等待或執行中追加鎖。
4. 搶佔取消整個衝突 run，清理完成才授予新 lease。Map 保存 owners／runs，AbortController 通知取消，runId＋token 隔離過期操作。等待不阻塞其他資源，逾時不強行轉交。
5. 插件經 Action 適配並宣告完整副作用。純導航禁用挖放與換物，允許跟隨／撤退與進食並行；戰鬥 scope 持有移動、視角、手部與背包。
6. LLM、JEV／KEV、agent memory 全部 pending；本輪不制定接口、adapter、模型或儲存規格。只保留觀察、決策與執行的責任分離，不把 JEV／KEV 當記憶儲存。

## 選型與取捨

| 選項 | 決定與原因 |
| --- | --- |
| 單一全域 active behavior | 不採用，無法滿足受控並行要求 |
| 自有小型 Reactive BT | 採用，直接定義五種節點與交接契約；需自行驗證節點語義 |
| Mistreevous | 暫不作核心依賴；一般 selector 的 RUNNING 延續語義仍需 guard／適配才能得到本案反應性，且不取代非同步資源交接 |
| 多資源搶佔 | 第一版採用；增加生命週期管理成本，換取移動與進食並行及一致控制權 |
| Utility AI | 暫不引入，先用固定安全優先順序；模型分數僅在合法決策槽中比較 |

## 驗證與後續

BT 與搶佔順序使用可控制完成時機的 fake actions 測試；插件適配另以 Paper 驗證跟隨＋進食、撤退＋進食、戰鬥中止、撿拾恢復及死亡／斷線清理。

先落地此架構與五項功能，接 LLM、JEV／KEV 或 memory 時補各自規格。可以替換 BT 引擎，但反應性、取消與資源交接測試必須成立。提案接受後同步 rules 與 README，舊文件不限制本案採用 BT 與資源鎖。
