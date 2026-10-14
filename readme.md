# Playground Mineflayer

以 TypeScript 建立 Minecraft companion bot。Stage 1、2 已實作核心引擎與決策管線；目前能登入、感知基本狀態並接受主人指令，身體動作尚未啟用。

## 執行

本次驗證環境：Node 26.0.0、pnpm 10.27.0、TypeScript 7.0.2；Paper 26.1.2 使用 Java 25。

```sh
pnpm install
pnpm run typecheck
pnpm test
BOT_OWNER=IamJohnWick pnpm start
```

可設定 `BOT_HOST`（預設 `127.0.0.1`）、`BOT_PORT`（`25565`）、`BOT_USERNAME`（`CompanionBot`）。目前入口使用 offline authentication，對應本地測試伺服器。

主人在聊天室或私訊輸入：

- `follow`：意圖設為 `FOLLOW`。Stage 2 仍待機，實際跟隨由 Stage 3 實作。
- `stop`：意圖設為 `STAY`。
- `status`：回報意圖、血量、飢餓值及活動中的動作。

其他玩家的指令不生效。聊天回覆使用獨立 VOICE 佇列，每秒最多一則。

## 結構

- `src/blackboard.ts`：分區狀態與深度凍結快照。
- `src/perception.ts`、`src/commands.ts`：世界觀察與主人意圖。
- `src/bt/`：同步行為樹、子樹骨架、每兩個物理 tick 的決策管線。
- `src/execution/`：整組資源仲裁、動作取消、token/session 隔離。
- `src/actions/chat.ts`：目前唯一有遊戲副作用的 Action。
- `src/bot.ts`：連線、插件掛載、死亡／重生／斷線處理。
- `test/unit/`：不需伺服器的測試。
- `test/integration/stage-two-paper.test.ts`：真實 Paper 聊天驗收。

新入口只掛載 pathfinder，未載入自動戰鬥、進食或換裝插件。`base_bot.js`、`base_bot_smart.js`、`bot_01.js` 為保留的舊實驗程式；`bot:base` 與 `bot:smart` 仍可執行，並非新架構。

## Paper 驗收

先在獨立測試世界啟動 offline-mode Paper，例如：

```sh
cd papermc/paper_server_26.1
java -Xms512M -Xmx1G -jar paper-26.1.2-74.jar --nogui
```

再從專案根目錄執行：

```sh
BOT_PORT=25565 pnpm run test:paper
```

測試會登入 `Stage2Owner` 和 `Stage2Bot`，送出 `follow`、`stop`、`status`，確認意圖切換及 Idle 回落，最後登出。一般 `pnpm test` 不會連線。

## 設計與交接

- [最新設計](docs/sys-design/system-design-v1.1.md)
- [分階段實作計畫](docs/implement-plan.md)
- [Stage 1／2 審核與 Stage 3 交接](docs/agent-note/stage-1-2-handoff.md)

LLM、JEV/KEV、Agent Memory 均 pending，目前沒有建立相關接口。
