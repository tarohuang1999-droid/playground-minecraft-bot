# Implementation Plans: Companion Bot

本專案採分階段漸進式架構開發，秉持 **KISS & YAGNI** 原則，詳細規格與實作計畫劃分如下：

- **[Stage 1: Companion Bot Core 與有界導航 (核心引擎與基礎設施)](implement-plan-stage-1.md)** [Done]
  - 核心狀態機與行為樹（Reactive BT）、資源仲裁器（Arbiter & Executor）、感知層、跟隨導航、戰鬥自衛、緊急撤退、進食補給、裝備換裝、物品撿拾、基地與重生點、門體通過與航點校正。
- **[Stage 2: 配置集中化、靜態檢查、物品查詢與自主狩獵](implement-plan-stage-2.md)** [Done]
  - **Stage 2.0**: 配置參數模組化與集中管理（`src/config/` 分類導出）。
  - **Stage 2.1**: 程式碼規範與靜態檢查工具建置（ESLint & Prettier）。
  - **Stage 2.2**: 裝備與背包物品查詢指令（`!item equipment` / `!item inventory`）。
  - **Stage 2.3**: 集合地錨定（直徑 50 格邊界約束）、工時限制（1 遊戲日）與自主動物狩獵（`!hunt`）。
- **[Stage 3: 核心架構輕量化重構與 P1 穩定性修復](implement-plan-stage-3.md)** [Next Up]
  - **Stage 3.1**: 單一時間原點（`Clock`）與底層控制安全邊界修復（解開 `NavigationExecutionBoundary` 對農事的誤攔截、補齊 `farming.ts` 取消檢查、修正無來源傷害誤判）。
  - **Stage 3.2**: 輕量級任務工作階段管理器（`src/sessions/task-session-manager.ts`，解決跨任務完成旗標卡死與 `entityGone` 誤算擊殺）。
  - **Stage 3.3**: 動作註冊表（`src/actions/index.ts`）與指令控制器（`src/command-controller.ts`）抽離。
  - **Stage 3.4**: `src/bot.ts` 極簡組裝根收斂（`< 220` 行）與跨回合回歸測試。
- **[Stage 4: 農業自動化修正、成熟收割、作息睡眠與容器管理](implement-plan-stage-4.md)** [Planned]
  - **Stage 4.1**: 多作物農事種植自動化修正與完成驗收（`!farm`）。
  - **Stage 4.2**: 多作物熟成收割與原地自動補種（`!harvest`）。
  - **Stage 4.3**: 夜晚自主回 Spawn 睡覺與天亮起床作息（Nightly Autonomous Sleep）。
  - **Stage 4.4**: 命名箱子管理、損毀自動移除與物品存取（`!box` register/list/remove/deposit/withdraw）。
  - **Stage 4.5**: Stage 4 綜合整合與端到端驗收測試矩陣。
- **[Pending: 延後優化與低優先級項目 (Low-Priority Backlog)](implement-plan-pending.md)** [Deferred]
  - 開門 `HAND` 微任務拆分、20Hz 感知分頻快取、非同步 Buffered Logger、原子存檔、導航幾何拆檔、Executor `FAULTED` 自動重連。
