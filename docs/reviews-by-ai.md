# reviews by AI

## 20261014 new structure design

在 Mineflayer 結合 LLM 的開發中，要解決「狀態爆炸（if-else 耦合）」與「底層控制權搶奪（資源鎖）」，最標準的做法是借鑑 **ROS 2 (Robot Operating System) / 無人機飛控** 與 **3A 遊戲 AI** 的混合架構：**採用三層式解耦架構（Three-Tier Architecture），以行為樹（Behavior Tree）取代傳統狀態機，並引入控制器資源令牌（Resource Token / Action Preemption）機制。**

### 核心結論與架構總結

1. **三層職責分離（Three-Tier Separation）**：將系統拆為 **戰略層（LLM）**、**戰術層（Behavior Tree / Utility AI）** 與 **執行層（Actuator / Resource Arbitrator）**，避免不同頻率的邏輯互相干擾。
2. **解決狀態耦合（取代 FSM）**：使用 **具反應式優先級的行為樹（Reactive Behavior Tree）** 或 **效用 AI（Utility AI）**，將「求生」與「戰鬥」解耦為獨立的子樹，透過優先級動態中斷，新增能力時只需插拔節點。
3. **解決資源鎖衝突（Resource Locking）**：將 Mineflayer 的底層控制拆分為獨立的虛擬硬體通道（Legs 移動、Hands 手部動作、Head 視角、Chat 語音），透過 **優先級搶佔鎖（Priority-based Preemption Lock）** 決定誰擁有控制權。
4. **共享記憶中樞（Blackboard Pattern）**：所有感測器（血量、敵人距離）、LLM 指令與記憶（JEV/KEV）統一寫入 **黑板（Blackboard）**，各模組只對黑板讀寫，不直接互相呼叫。

---

### 一、 為什麼傳統 FSM + If-Else 會崩潰？

在你的場景中：「主人要求協同戰鬥（向前）」與「血量過低（向後逃跑）」同時發生時，本質上是兩個問題：

1. **決策頻率不對稱**：LLM 的推理是秒級（1~3 秒），而生存反應（扣血、苦力怕貼臉）是毫秒級（Mineflayer 的 `physicsTick` 每 50ms 一次）。如果讓慢速邏輯與快速邏輯直接操控 `bot.pathfinder`，指令就會互相覆蓋導致原地鬼畜。
2. **轉換邊（Transition）指數級爆炸**：有限狀態機（FSM）每新增一個狀態（例如「飢餓吃東西」），就必須在「戰鬥」、「逃跑」、「跟隨」等所有舊狀態中補上轉換條件，維護成本為 $O(N^2)$。

---

### 二、 借鑑機器人與無人機的「三層式架構」

無人機（如 PX4 + 機載電腦）與現代遊戲 AI（如《Halo》、《戰神》）都使用 **Subsumption Architecture（包容式架構）** 的變體：

#### 1. 戰略層（Deliberative Layer - 慢速，0.5~2 Hz）

* **負責模組**：LLM + 記憶檢索（JEV/KEV）。
* **職責**：只負責**設定目標（Intent/Goal）**，絕不直接呼叫 `bot.pathfinder` 或 `bot.attack`。
* **實作方式**：當主人下令「幫我打怪」，LLM 並非執行攻擊迴圈，而是將黑板（Blackboard）中的變數更新為 `current_goal = "COMBAT_ASSIST"`、`target_entity = "Zombie_123"`。

#### 2. 戰術決策層（Tactical Layer - 中速，10~20 Hz）

* **負責模組**：**Reactive Behavior Tree（反應式行為樹）** 或 **Utility AI（效用系統）**。
* **職責**：每 100ms 掃描一次黑板，根據當前優先級決定「現在該執行哪個 Action」。
* **如何解決「戰鬥 vs 逃跑」的擴充問題**：
在行為樹的頂層使用一個 **Reactive Selector（反應式選擇節點，從左到右依優先級評估）**：
* **分支 1（最高優先）：生存子樹（Survival Subtree）** —— 檢查條件：`HP < 30%`。若成立，執行「拉開距離 + 吃金蘋果」。
* **分支 2（次高優先）：任務子樹（Task Subtree）** —— 檢查條件：`current_goal == "COMBAT_ASSIST"`。若成立，執行「追擊目標並攻擊」。
* **分支 3（預設優先）：待機子樹（Idle/Follow）** —— 跟隨主人。


* **優勢**：因為是 **Reactive（反應式）**，當正在執行分支 2（戰鬥）時，只要下一個 Tick 發現 `HP < 30%`，分支 1 會立刻返回 Running 並**自動呼叫分支 2 的 `abort()` 函數**。未來要新增「裝備損壞自動換刀」或「閃避苦力怕」，只需在分支 1 和 2 之間插入一個新節點，完全不用改動原有的戰鬥或逃跑程式碼。

#### 3. 運動控制與資源仲裁層（Actuator & Resource Arbitrator - 高速，20 Hz / 50ms）

* **負責模組**：資源鎖管理器（Resource Lock Manager）+ Mineflayer 底層 API。
* **職責**：模擬 ROS 2 的 `ros2_control` 硬體資源管理，防止兩個行為同時操作同一個身體部位。

---

### 三、 核心實踐：如何設計 Mineflayer 的「資源鎖（Resource Channels）」

在機器人學中，移動底盤（Base）與機械臂（Arm）是分開上鎖的。在 Minecraft 中，你可以將 Bot 的身體拆解為 4 個互不干擾的硬體資源通道（Resource Channels）：

| 資源通道 (Channel) | 對應 Mineflayer 操作 | 衝突與併發規則 |
| --- | --- | --- |
| **`LOCOMOTION` (雙腿)** | `pathfinder`, `setControlState('forward')` | **互斥鎖**：同時只能有一個行為控制移動（不能一邊前進殺敵、一邊後退逃跑）。 |
| **`MANIPULATION` (雙手)** | `attack()`, `activateItem()` (吃東西/舉盾), `equip()` | **互斥鎖**：揮劍與吃東西互斥。但**與 `LOCOMOTION` 獨立**！ |
| **`HEAD` (視角)** | `lookAt()` | **低優先鎖**：通常綁定當前執行的主動作，但可被高優先級感測器短暫借用。 |
| **`VOICE` (聊天室)** | `chat()` | **完全獨立**：逃跑或戰鬥時，依然可以隨時發送求救訊息。 |

#### 資源鎖帶來的「聰明操作」：邊跑邊吃（Action Blending）

把資源拆開後，會產生非常高階的遊戲 AI 表現：

1. 當觸發「殘血逃跑」時，`FleeAction` 以 **Priority 100** 鎖定了 `LOCOMOTION`（向後跑）。
2. 同時，「自動回血節點」`HealAction` 檢查發現它只需要 `MANIPULATION`（右手拿食物吃），而 `MANIPULATION` 目前沒被鎖定（或是只被 Priority 50 的 `AttackAction` 佔用）。
3. `HealAction` 搶佔 `MANIPULATION` 鎖，取消揮劍、換上食物開始吃，而雙腿繼續執行 `FleeAction` 逃跑——**完美實現「邊逃跑邊吃東西」，且兩個邏輯模組彼此完全不知道對方的存在**。

---

### 四、 架構程式碼範例 (TypeScript / Node.js 概念實作)

以下展示如何用「資源通道仲裁器（Arbitrator）」與「反應式節點」把這套邏輯串起來：

```typescript
// 1. 定義硬體資源通道
enum ResourceChannel {
  LOCOMOTION = 'LOCOMOTION',     // 移動 (pathfinder / control state)
  MANIPULATION = 'MANIPULATION', // 手部 (攻擊 / 吃東西 / 方塊互動)
  HEAD = 'HEAD'                  // 視角 (lookAt)
}

interface LockHolder {
  ownerId: string;
  priority: number;
  onPreempted: () => void; // 被更高優先級搶佔時的清理回呼 (例如停止尋路)
}

// 2. 資源仲裁器 (借鑑 ROS 2 Action Server Preemption)
class ResourceArbitrator {
  private locks = new Map<ResourceChannel, LockHolder>();

  public acquire(
    channel: ResourceChannel,
    ownerId: string,
    priority: number,
    onPreempted: () => void
  ): boolean {
    const current = this.locks.get(channel);

    // 如果已經有更高優先級的動作佔用，拒絕請求
    if (current && current.ownerId !== ownerId && current.priority > priority) {
      return false;
    }

    // 如果搶佔了低優先級動作，先觸發對方的中斷清理 (Abort!)
    if (current && current.ownerId !== ownerId) {
      current.onPreempted();
    }

    this.locks.set(channel, { ownerId, priority, onPreempted });
    return true;
  }

  public release(channel: ResourceChannel, ownerId: string) {
    const current = this.locks.get(channel);
    if (current && current.ownerId === ownerId) {
      this.locks.delete(channel);
    }
  }
}

```

#### 在行為節點中使用資源鎖：

```typescript
// 戰鬥節點 (Priority: 50)
class CombatNode {
  constructor(private bot: any, private arbitrator: ResourceArbitrator) {}

  tick(blackboard: any) {
    if (blackboard.llmGoal !== 'COMBAT') return 'FAILURE';

    // 請求雙腿與雙手控制權 (Priority 50)
    const hasLegs = this.arbitrator.acquire(
      ResourceChannel.LOCOMOTION, 'Combat', 50,
      () => this.bot.pathfinder.setGoal(null) // 被搶佔時立刻清空尋路！
    );
    const hasHands = this.arbitrator.acquire(
      ResourceChannel.MANIPULATION, 'Combat', 50,
      () => this.bot.stopDigging()
    );

    if (hasLegs) {
      // 執行向前追擊敵人
      this.bot.pathfinder.setGoal(new GoalFollow(blackboard.target, 2));
    }
    if (hasHands && this.bot.entity.position.distanceTo(blackboard.target.position) < 3) {
      this.bot.attack(blackboard.target);
    }
    return 'RUNNING';
  }
}

// 逃跑節點 (Priority: 100 - 生存最高優先)
class FleeNode {
  constructor(private bot: any, private arbitrator: ResourceArbitrator) {}

  tick(blackboard: any) {
    if (this.bot.health > 6) {
      // 血量安全時釋放鎖
      this.arbitrator.release(ResourceChannel.LOCOMOTION, 'Flee');
      return 'FAILURE';
    }

    // 以 Priority 100 強制搶佔雙腿！
    // 這會自動觸發 CombatNode 的 onPreempted()，清空追擊尋路
    const hasLegs = this.arbitrator.acquire(
      ResourceChannel.LOCOMOTION, 'Flee', 100,
      () => this.bot.pathfinder.setGoal(null)
    );

    if (hasLegs) {
      // 設定反向逃跑目標 (GoalInvert)
      this.bot.pathfinder.setGoal(new GoalInvert(new GoalFollow(blackboard.threat, 10)));
    }
    return 'RUNNING';
  }
}

```

---

### 五、 進階優化：如果不想連優先級都寫死？（Utility AI / 效用系統）

如果你覺得在行為樹裡排 Priority（100 vs 50）還是不夠靈活（例如：敵人也只剩一滴血，這時應該硬換掉他，還是逃跑？），真實高等遊戲 AI（如《模擬市民》、《極地戰嚎》）會結合 **Utility AI（效用評分）**：

* 不再使用非黑即白的 `HP < 30%`，而是為每個行為定義一條 **計分公式（Score 0.0 ~ 1.0）**：
* **逃跑分數** = $(1 - \text{自身血量比例})^2 \times \text{周圍威脅係數}$
* **強殺分數** = $(1 - \text{敵人血量比例}) \times \text{主人指令權重}$


* 每個 Tick 計算一次分數，**直接拿算出來的「效用分數」當作上述 `ResourceArbitrator` 的 `priority` 參數**。這樣就能完美做到「我殘血想跑（分數 0.75），但敵人剩一刀且主人下死令（分數 0.85），所以決定拼死砍最後一刀」的極度擬真行為，而且新增任何行為都只是多寫一個計分公式。

### 核心結論與總結

1. **完美融合且不衝突**：Mineflayer 基於 **Node.js 單執行緒事件迴圈（Event Loop）**，其底層內建每 50ms 觸發一次的 `physicsTick`（20Hz，與 Minecraft 伺服器同步）。你的理解完全正確，不同層級只需要掛載在**同一個 Event Loop 下的不同頻率計時器與非同步回呼（Async Callback）**，共用同一個記憶體中的 **Blackboard（黑板物件）**，完全不會有 Multi-threading 的 Race Condition（競爭危害）問題。
2. **注意官方套件陷阱**：千萬**不要**使用 Mineflayer 官方的 `mineflayer-statemachine`，因為它本質還是傳統 FSM（有限狀態機），狀態一多就會回到你原本的痛點。
3. **推薦開源工具組合**：直接採用 **`mistreevous`**（現代化 TypeScript 行為樹引擎，原生支援反應式中斷 `abort`）搭配 **`mindcraft`**（開源的 Mineflayer + LLM 代理框架）的底層技能封裝概念。

---

### 一、 Mineflayer 底層機制與「多頻率 Loop」如何完美融合？

Minecraft 的世界是以 **20 TPS（Ticks Per Second，即每 50ms 一個 Tick）** 運行的，而 Mineflayer 在底層已經幫你做好了這個最快的硬體迴圈：`bot.on('physicsTick', ...)`。

在 Node.js 的架構下，你不需要開多個 Thread，而是透過 **Tick 分頻（Tick Throttling）與非同步 I/O（Async/Await）** 來實現三種不同 Cycle Time 的 Loop：

#### 1. 三層 Loop 的實際運作方式

| 層級 | Cycle Time (頻率) | 在 Mineflayer / Node.js 中的觸發方式 | 職責與資源互動 |
| --- | --- | --- | --- |
| **感測與執行層 (Actuator / Sensor)** | **50ms (20 Hz)** | `bot.on('physicsTick', () => { ... })` | 每個 Tick 更新感測資料（自身血量、最近敵人距離）寫入 `Blackboard`；由 `mineflayer-pathfinder` 在底層計算 A* 步進與物理跳躍。 |
| **戰術決策層 (Behavior Tree)** | **100ms ~ 200ms (5~10 Hz)** | 在 `physicsTick` 內用計數器（每 2~4 個 Tick 跑一次 `bt.step()`）或 `setInterval` | 掃描 `Blackboard`，執行行為樹評估。若需要切換行為，透過 `ResourceArbitrator` 搶佔鎖並更新 Pathfinder 的 Goal。 |
| **戰略推理層 (LLM + JEV/KEV)** | **1s ~ 3s+ (事件驅動 / 慢速)** | `bot.on('chat')` 或低頻 `setInterval` 觸發 `async function` (非阻塞 HTTP 請求) | 在背景等待 LLM API 與記憶檢索回傳，拿到結果的瞬間**只修改 `Blackboard` 上的目標變數**，下一個 100ms 的 BT Tick 就會自動接手。 |

#### 2. 為什麼一定要把 BT 控制在 5~10 Hz，而不是跟著 20 Hz 跑？

* **`mineflayer-pathfinder` 的特性**：當你呼叫 `bot.pathfinder.setGoal(new GoalFollow(...), true)` 時，第二個參數 `dynamic = true` 會讓 Pathfinder 自己在底層以 20Hz 自動追蹤目標位置。
* 如果你的行為樹每 50ms 就重新 `new Goal()` 並塞給 Pathfinder，會導致它的 A* 尋路快取不斷被重置，Bot 就會卡在原地抽搐。
* **正確做法**：透過我們上一篇寫的 `ResourceArbitrator`，只有當「搶佔成功（行為發生切換）」的那一瞬間，才呼叫 `bot.pathfinder.setGoal()`；只要同一個節點持續維持 `RUNNING`，就讓底層 Pathfinder 自己跑 20Hz 的迴圈即可。

---

### 二、 可直接套用的開源專案與 Behavior Tree 函式庫

在 Node.js / TypeScript 生態系中，針對你「需要反應式搶佔（Reactive Preemption）」與「Mineflayer + LLM 整合」的需求，以下是經過實戰驗證的最佳開源選擇：

#### 1. 行為樹引擎首選：`mistreevous` (TypeScript / JS)

* **GitHub**: `nikkorn/mistreevous` (`npm install mistreevous`)
* **為什麼選它**：
* 它是目前 Node.js 生態中維護最乾淨、原生 TypeScript 編寫的行為樹庫。
* **原生支援 `exit` / 中斷回呼**：當高優先級分支（如殘血逃跑）條件成立時，它會自動中斷正在 `RUNNING` 的低優先級分支（如協同戰鬥），並自動觸發該節點的清理函數——這正是對接我們 `ResourceArbitrator.release()` 的核心機制。
* 支援用簡單的 DSL（類似設定檔的語法）定義樹結構，未來你甚至可以讓 LLM 動態生成行為樹子節點。



#### 2. 輕量級程式碼優先替代方案：`fluent-behavior-tree`

* **GitHub**: `ashblue/fluent-behavior-tree`
* **為什麼選它**：如果你不喜歡寫樹狀設定檔，喜歡純粹用 TypeScript 鏈式呼叫（Builder Pattern）把行為樹組裝起來，這個庫極度輕量（不到幾百行程式碼），非常適合直接魔改把 `ResourceArbitrator` 塞進它的 `Selector` 節點裡。

#### 3. Mineflayer + LLM 現成參考架構：`mindcraft`

* **GitHub**: `kolbytn/mindcraft`
* **可借鑑之處**：這是目前最火紅的 Mineflayer + LLM 開源框架。雖然它的頂層還是偏向 LLM Agent，但它的 **`src/agent/library/skills.js`** 與 **`modes.js`** 已經幫你寫好了大量防呆的底層反應（例如：自動閃避苦力怕、受到攻擊自動反擊、快淹死時自動浮出水面、飢餓自動吃東西）。
* **它的缺點（正好你可以改進的地方）**：`mindcraft` 的 `modes.js` 目前就是用類似傳統 `if-else` 輪詢來硬切控制權，常會跟 LLM 下達的長動作發生搶鎖衝突。你可以直接把它的 `skills.js` 拿來當作行為樹底層的葉子節點（Action Nodes），再用 `mistreevous` + `ResourceArbitrator` 取代它原本粗糙的 `modes.js`。

---

### 三、 實戰整合：Mineflayer 三層 Loop 骨架程式碼

這段程式碼可以直接作為你專案的 `mainLoop.ts` 核心骨架，展示如何把 `physicsTick` (20Hz)、`BehaviorTree` (5Hz) 與 `LLM` (Async) 零衝突地綁在一起：

```typescript
import mineflayer from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';

const bot = mineflayer.createBot({ host: 'localhost', username: 'HighTierNPC' });
bot.loadPlugin(pathfinder);

// 1. 共享黑板 (Single Source of Truth)
const blackboard = {
  // 感測層寫入 (20 Hz)
  hp: 20,
  nearestHostile: null as any,
  distanceToThreat: Infinity,
  // 戰略層 (LLM) 非同步寫入 (0.5 Hz / Event-driven)
  llmIntent: 'FOLLOW_MASTER' as 'FOLLOW_MASTER' | 'COMBAT_ASSIST' | 'IDLE',
  designatedTargetId: null as number | null,
};

let tickCounter = 0;

bot.once('spawn', () => {
  const defaultMove = new Movements(bot);
  bot.pathfinder.setMovements(defaultMove);

  // ==========================================
  // Loop 1 & 2: 綁定在 Mineflayer 內建的 20Hz (50ms) 物理迴圈
  // ==========================================
  bot.on('physicsTick', () => {
    // [Layer 1: 20Hz 感測器更新] (每 50ms 執行，極度輕量，不阻塞)
    blackboard.hp = bot.health;
    const threat = bot.nearestEntity(e => e.type === 'hostile');
    blackboard.nearestHostile = threat;
    blackboard.distanceToThreat = threat 
      ? bot.entity.position.distanceTo(threat.position) 
      : Infinity;

    // [Layer 2: 5Hz 行為樹與資源鎖決策] (每 4 個 Tick = 200ms 執行一次)
    tickCounter++;
    if (tickCounter % 4 === 0) {
      behaviorTree.step(blackboard); // 觸發 BT 評估與 ResourceArbitrator 搶佔
    }
  });
});

// ==========================================
// Loop 3: 慢速戰略層 (LLM + JEV/KEV 記憶檢索) - 完全非同步
// ==========================================
bot.on('chat', async (username, message) => {
  if (username === bot.username) return;

  // 非同步呼叫 LLM 與檢索 JEV/KEV，期間需要 1~2 秒
  // 但完全不會卡住上面 50ms 的 physicsTick 與逃跑反應！
  const decision = await queryLLMAndMemory(username, message, blackboard);

  // LLM 只負責改寫黑板上的「戰略意圖」，不直接碰 bot.pathfinder！
  if (decision.action === 'ATTACK_TARGET') {
    blackboard.llmIntent = 'COMBAT_ASSIST';
    blackboard.designatedTargetId = decision.targetEntityId;
  }
});

```