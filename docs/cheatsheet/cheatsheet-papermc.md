


# cheatsheet papermc

這是一份實用的 **PaperMC / Spigot 伺服器管理指令速查表 (Commands Cheatsheet)**，涵蓋日常運維、世界管理、權限與效能監控：

---

### 一、 伺服器管理與運維 (Server Management)

* **`/stop`**：安全關閉伺服器（會自動觸發存檔並踢出線上玩家）。
* **`/reload`**：重新載入伺服器的設定檔 (`server.properties`, `bukkit.yml`, `spigot.yml`, `paper-global.yml`) 與外掛。*（註：部分外掛或複雜變更仍建議重啟伺服器以避免記憶體殘留問題）*。
* **`/save-all`**：強制立即將所有世界資料與玩家資料寫入硬碟。
* **`/save-off`** / **`/save-on`**：關閉 / 開啟自動存檔（通常用於備份前夕）。
* **`/whitelist add <玩家>` / `remove <玩家>**`：管理伺服器白名單。
* **`/op <玩家>` / `deop <玩家>**`：給予或拔除管理員權限。

---

### 二、 玩家與世界管理 (Players & World)

* **`/kick <玩家> [原因]`**：將指定玩家踢出伺服器。
* **`/ban <玩家> [原因]`**：封鎖玩家。
* **`/tp <玩家> [目標玩家/座標]`**：傳送到指定玩家或坐標（例如：`/tp @s 0 64 0`）。
* **`/gamemode <survival/creative/adventure/spectator> [玩家]`**：切換遊戲模式。
* **`/time set <day/night/數值>`**：調整世界時間。
* **`/weather <clear/rain/thunder>`**：改變天氣。
* **`/gamerule <規則名稱> <值>`**：調整遊戲規則（例如：`/gamerule keepInventory true` 開啟死亡不掉落）。

---

### 三、 紙片伺服器 (Paper) 專屬效能與除錯指令

Paper 內建了許多強大的效能診斷工具，不需要額外安裝外掛：

* **`/paper tps`** 或 **`/tps`**：
* 查看伺服器目前的 **TPS（每秒遊戲刻數）**。正常情況下應維持穩定在 `20.0`。
* 同時會顯示過去 5秒、1分鐘、5分鐘及 15分鐘的平均 TPS。


* **`/paper mspt`**：
* 查看 **MSPT (Milliseconds Per Tick)**。這是評估伺服器效能更精準的指標，代表每個 Tick 花費的毫秒數。理想情況下應低於 `50ms`（大於 50ms 代表伺服器開始卡頓）。


* **`/paper chunk`**：
* 查看目前載入的區塊（Chunk）數量與分布狀況。


* **`/paper reload`**：
* 僅重新載入 Paper 專屬的設定檔（`paper-global.yml`、`paper-world.yml`）。



---

### 四、 常用伺服器管理快捷技巧

* **`/perf`**（如果安裝了 Spark 外掛，強烈建議裝）：
* `/spark profiler`：開始進行效能分析，找出是哪個外掛、實體（Entity）或區塊造成伺服器卡頓。


* **`/gc`**（部分核心或外掛支援）：
* 顯示記憶體佔用狀況並手動觸發垃圾回收（Garbage Collection），釋放記憶體。

