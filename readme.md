# Playground Mineflayer

A playground and foundation for controlling Minecraft bots via Mineflayer, designed for LLM (Large Language Model) agent experimentation and automated gameplay.

---

## Overview

This project provides the perception and action foundation needed for LLM-powered Minecraft agents:
* **Perception & State**: Collects world states, player positions, block data, and chat events via Mineflayer.
* **Skill Execution**: Executes movement and block interactions through modular plugins (`mineflayer-pathfinder`, `mineflayer-collectblock`).
* **Local Testbed**: Includes standalone PaperMC server setups for reproducible offline testing.

---

## Project Structure

* `companion_bot.js`: Enhanced interactive companion bot (`CompanionBot`) featuring reliable player-following heartbeat, single navigation (`come`), resource gathering (`get [item]`), and coordinate reporting (`position`).
* `base_bot_smart.js`: Autonomous bot (`SmartWorker`) with basic pathfinding and logging.
* `base_bot.js`: Minimal baseline bot (`[BOT]bob`) verifying server connection and chat mirroring.
* `test/companion_bot.test.js`: Unit tests for command parsing, alias matching, and position formatting logic.
* `paper_server_26.1/`: Local PaperMC server runtime (Minecraft 26.1.2) configured for offline testing (`online-mode=false`).
* `paper_server_26.2/`: PaperMC 26.2 server jar and workspace.
* `docs/cheatsheet-nvm.md`: Node Version Manager (nvm) quick reference sheet.
* `package.json`: Project dependencies, test runners, and launcher scripts.

---

## NPC v1 Design Handoff

The next NPC is designed but not implemented yet. Its structure is deliberately small: `bot.js`, `commands.js`, `controller.js`, `behaviors/`, and `skills/`. Start with [docs/README.md](docs/README.md) for the plain-language flow, coding templates, and five-step implementation checklist. The scripts below still launch the existing prototype bots.

---

## Prerequisites

* **Node.js**: v22+ (required by the installed Mineflayer 4.39.0); the new NPC design targets Node 24
* **Java Runtime**: JDK 21+ (required for modern PaperMC versions)
* **Minecraft Client**: Matching Minecraft version (e.g. 26.1.2) if joining manually to interact with the bot

---

## Installation

Install project dependencies:

```bash
npm install
```

Core dependencies:
* `mineflayer`: High-level Minecraft client API.
* `mineflayer-pathfinder`: A* pathfinding and navigation logic.
* `mineflayer-collectblock`: Automatic block search and collection routines.

---

## Usage Guide

### 1. Start the Local PaperMC Server

Run the local PaperMC server instance:

```bash
java -Xmx2G -Xms2G -jar paper_server_26.1/paper-26.1.2-74.jar nogui
```

* The server runs on `localhost:25565`.
* `online-mode` is set to `false` in `paper_server_26.1/server.properties` for local offline authentication.

### 2. Launch the Bot

* **Run Smart Autonomous Bot**:
  ```bash
  npm run bot:smart
  # or: node base_bot_smart.js
  ```
  Connects as `SmartWorker`.

* **Run Basic Echo Bot**:
  ```bash
  npm run bot:base
  # or: node base_bot.js
  ```
  Connects as `[BOT]bob` and echoes chat messages.

---

## In-Game Bot Commands (`companion_bot.js`)

When `companion_bot.js` is running, players can issue the following commands in game chat:

* `follow`: Starts continuous following mode. Keeps a 2.5-block safe distance, backed by an active heartbeat loop so the bot never freezes when you move away.
* `come`: Pathfinds directly to your current position once, stopping within 1.5 blocks.
* `get [item]` / `get [count] [item]`: Automatically searches for and collects the specified block or dropped item within a 48-block radius.
  * Examples: `get wood`, `get 3 dirt`, `get 5 oak_log`, `get stone`, `get iron`
  * Includes smart aliases (e.g. `wood` matches logs/wood/stems, `dirt` matches grass/dirt, `stone` matches stone/cobble/deepslate).
* `position` (or `pos`, `where`): Reports the bot's current coordinates (X, Y, Z), distance to the caller, health, and hunger.
* `stop`: Immediately halts all ongoing actions, pathfinding goals, and follow modes.
* `help`: Prints command usage in chat.

---

## Testing

Run unit tests verifying command parsing, alias mapping, and formatting:

```bash
npm test
```

---

## LLM Integration Architecture

The planned NPC separates perception, decision selection, and cancellable execution. LLMs propose authorized high-level orders; a future decision-head classifier selects from rule-validated task candidates. Safety and self-defense remain deterministic, and model calls never block the control loop.

Owner tasks, current behavior, and future mood/needs are separate data; emotions do not require separate state machines. See [future model integration](docs/model-integration.md) and [the NPC architecture](docs/npc-architecture.md). These interfaces are a design target; the current prototype does not implement the LLM or classifier adapters.
