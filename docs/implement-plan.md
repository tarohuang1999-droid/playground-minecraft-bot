# Implementation Plans: Companion Bot

本專案採分階段漸進式架構開發，詳細規格與實作計畫劃分如下：

- **[Stage 1: Companion Bot Core 與有界導航 (核心引擎與基礎設施)](implement-plan-stage-1.md)**
  - 核心狀態機與行為樹（Reactive BT）、資源仲裁器（Arbiter & Executor）、感知層、跟隨導航、戰鬥自衛、緊急撤退、進食補給、裝備換裝、物品撿拾、基地與重生點、門體通過與航點校正。
- **[Stage 2: 生存物資採集、自主狩獵、農業自動化與容器配置管理](implement-plan-stage-2.md)**
  - **Stage 2.0**: 配置參數模組化與集中管理（`src/config/` 分類導出）。
  - **Stage 2.1**: 程式碼規範與靜態檢查工具建置（ESLint、Prettier 與科技大廠 JS/TS 規範）。
  - **Stage 2.2**: 狀態清單增強（裝備展示與正規表達式過濾 `!state [regex]`）。
  - **Stage 2.3**: 集合地錨定（直徑 50 格邊界約束）、工時限制（不超過 1 遊戲日）與自主動物狩獵（牛/豬/羊/雞 `!hunt`）。
  - **Stage 2.4**: 多作物架構、小麥農事種植自動化（Triticum）與工時限制（`!farm`）。
  - **Stage 2.5**: 多作物熟成收割與原地自動補種（`!harvest`）。
  - **Stage 2.6**: 夜晚自主回 Spawn 睡覺與天亮起床作息（Idle Nightly Sleep）。
  - **Stage 2.7**: 命名箱子管理、損毀自動移除與物品存取（`!box` register/list/deposit/withdraw）。
  - **Stage 2.8**: Stage 2 綜合整合與端到端驗收測試矩陣。
