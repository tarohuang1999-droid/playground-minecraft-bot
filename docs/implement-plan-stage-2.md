# Implementation Plan: Stage 2 - 配置集中化、靜態檢查、物品查詢與自主狩獵

- **目標讀者**：AI Coding Agent / 實作工程師
- **狀態**：Completed (Stage 2.0 ~ 2.3 已完成；重構移至 [Stage 3](implement-plan-stage-3.md)，剩餘農業/睡眠/箱子功能移至 [Stage 4](implement-plan-stage-4.md))
- **前置依賴規範**：
  - [system-design-v1.1.md](sys-design/system-design-v1.1.md)（核心架構、Blackboard Schema、Arbiter 仲裁規範）
  - [implement-plan-stage-1.md](implement-plan-stage-1.md)（Stage 1 基礎設施、執行器 fence、導航與戰鬥基底）
  - [rule-typescript-coding.md](rules/rule-typescript-coding.md)（TypeScript 開發規範）

---

## 階段目錄 (Stage 2 Breakdown)

- **Stage 2.0: 配置參數模組化與集中管理 (`src/config/`)** [Done]
- **Stage 2.1: 程式碼規範與靜態檢查工具建置 (ESLint & Prettier)** [Done]
- **Stage 2.2: 裝備與背包物品查詢指令 (`!item equipment` / `!item inventory`)** [Done]
- **Stage 2.3: 集合地錨定、工時限制與自主動物狩獵 (`!hunt`)** [Done]

> **後續階段拆分說明**：
> - 原 Stage 2.4（`src/bot.ts` 核心架構重構與 P1 穩定性修復）已獨立為 **[Stage 3: 核心架構輕量化重構與 P1 穩定性修復](implement-plan-stage-3.md)**。
> - 原 Stage 2.5 ~ 2.9（`!farm` 修正、`!harvest` 收割補種、夜晚自動睡眠、`!box` 箱子管理與整合測試）已移至 **[Stage 4: 農業自動化、作息睡眠與容器管理](implement-plan-stage-4.md)**。
> - 非緊急之效能與周邊優化收錄於 **[Pending: 延後優化與低優先級項目](implement-plan-pending.md)**。

---

## Stage 2.0: 配置參數模組化與集中管理 (`src/config/`)

### 2.0.1 階段目標
將分散於 `src/policy.ts`、`src/actions/navigation.ts`、`src/logger.ts` 等模組中的常數、閾值與各項重要參數分類抽離至 `src/config/`，以功能領域劃分獨立配置檔案，並於 `src/config/index.ts` 統整導出，`src/policy.ts` 保持向後相容引用。

### 2.0.2 檔案與模組劃分
- `src/config/navigation.config.ts`：跟隨遲滯門檻、停滯與超時、挖放白名單、移動限制。
- `src/config/combat.config.ts`：交戰距離、撤退閾值。
- `src/config/survival.config.ts`：進食門檻、作息時間。
- `src/config/work.config.ts`：拾取參數、狩獵參數、農業參數、箱子參數。
- `src/config/system.config.ts`：決策週期、執行器 fence、聊天冷卻、視野半徑、資料持久化路徑。
- `src/config/index.ts`：統一匯出所有配置。

### 2.0.3 驗收門檻
- [x] 執行 `pnpm run typecheck` 與 `pnpm test` 100% 通過，全專案無壞掉的舊引用。
- [x] 所有魔法數字皆可在 `src/config/` 統一維護調整。

---

## Stage 2.1: 程式碼規範與靜態檢查工具建置 (ESLint & Prettier)

### 2.1.1 階段目標
引入 ESLint 與 Prettier 規範，確保全專案排版統一、語法乾淨並杜絕低階錯誤。

### 2.1.2 驗收門檻
- [x] `pnpm run lint` 與 `pnpm run format:check` 正常運作無崩潰（0 errors, 0 warnings）。
- [x] ESLint 與 Prettier 無互相衝突之排版報錯。
- [x] 執行 `pnpm run format` 自動排版全庫檔案。

---

## Stage 2.2: 裝備與背包物品查詢指令 (`!item equipment` / `!item inventory`)

### 2.2.1 階段目標
新增獨立的 `!item` 指令，支援裝備清單（`equipment`）與背包物品統計（`inventory`）兩種查詢模式。

### 2.2.2 驗收門檻
- [x] `!item equipment` 正確輸出六大部位裝備名稱（空位為 none）。
- [x] `!item inventory` 正確彙整輸出背包物品與數量，並顯示剩餘空槽位數。
- [x] 無效參數時輸出 `Usage: !item equipment | !item inventory`。
- [x] 不破壞既有 `!state` / `!status` 指令功能。

---

## Stage 2.3: 集合地錨定、工時限制與自主動物狩獵 (`!hunt`)

### 2.3.1 階段目標
實作自主狩獵行為：當收到 `!hunt` 指令時，Bot 以當前座標為暫時集合地（Rally Point），在直徑 50 格（半徑 25 格）範圍內搜尋目標動物（預設支援：`chicken`, `pig`, `cow`, `sheep`），接近並擊殺動物，自動拾取掉落物；單次任務限制**不超過遊戲中一天（20 分鐘）**，範圍內無動物或工時結束時直接切換為 `IDLE` 並發送完成訊息。

### 2.3.2 驗收門檻
- [x] 執行 `!hunt` 時正確錨定當前座標為集合點，只鎖定半徑 25 格內的動物。
- [x] 獵殺過程自動換上最佳武器，擊殺後成功拾取掉落物。
- [x] 動物逃逸出 25 格範圍時主動放棄，不追出限定區域。
- [x] 執行時限達 20 分鐘（遊戲中一天）或動物獵殺完畢時，發送完成統計訊息並切換為 `IDLE`。
