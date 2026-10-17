---
name: ts-coding-guardrails
description: Concise TypeScript and Mineflayer coding guardrails for playground-mineflayer. Activate before writing or refactoring any .ts or test files in src/ or tests/.
---

# TypeScript & Mineflayer Coding Guardrails

Follow these 12 strict rules whenever modifying `src/**` or `tests/**`. Do not overengineer (enforce KISS & YAGNI).

## 1. Architecture & Anti-Overengineering
1. **Thin Composition Root**: Keep `src/bot.ts` under **220 lines**. Put chat routing in `src/command-controller.ts`, task session counters in `src/sessions/task-session-manager.ts`, and action wiring in `src/actions/index.ts`.
2. **Stateless BT Factories (`[RULE-02]`)**: Never declare mutable cross-task closure variables (e.g., `let finishedTriggered = false`) inside `src/bt/**`. All task lifecycle state belongs in `Blackboard` (`bb.data.task`) or `TaskSessionManager`.
3. **KISS Module Splitting**: Only split files when a module exceeds ~350 lines or mixes distinct responsibilities. Avoid speculative interfaces, DI containers, or unused abstractions.

## 2. Type Safety & Runtime Concurrency
4. **No `any` (`[RULE-01]`)**: Use `unknown` + type guards or Mineflayer types (`Bot`, `Entity`, `Block`, `Item`). Keep `@typescript-eslint/no-explicit-any` clean.
5. **Single Clock Source (`[RULE-10]`)**: Always use `Date.now()` (injected via `clock()`) for timestamps and elapsed-time checks (`lastHurtTime`, `lastEatTime`, `task.startTime`). Never mix `performance.now()` and `Date.now()`.
6. **Cancellation & Stale Token Isolation (`[RULE-04]`, `[RULE-05]`)**:
   - Check `if (!ctx.isActive()) return;` after **every** `await` and at the top of **every** `catch` block before calling fallback Mineflayer APIs.
   - Always remove listeners and stop pathfinding (`bot.pathfinder.setGoal(null)`, `bot.clearControlStates()`) inside `finally` or `onStop`.
7. **Action Wrapper Isolation (`[RULE-11]`)**: `NavigationExecutionBoundary` (`canDig`/`canPlace`) must only restrict `mineflayer-pathfinder` during `FOLLOW_PLAYER` and must never block `bot.dig` or `bot.placeBlock` invoked by other actions (`FARM_PLANT`, `HARVEST_CROP`).
8. **Static Action Contracts (`[RULE-09]`)**: `ActionAdapter.locks` and `priority` must remain static readonly metadata for `Arbiter`.
9. **Resource Lock Discipline**: Declare exact locks (`MOVE`, `COMBAT`, `USE_ITEM`, `HAND`, `CONTAINER`) for every action.

## 3. Observability & Testing
10. **Structured Logging (`[RULE-06]`)**: Use `Logger` (`tick`, `trace`, `event`, `error`); never use `console.log` in `src/**`.
11. **Multi-Round Task Reset Tests (`[TEST-05]`)**: Every task (`!hunt`, `!farm`, `!harvest`, `!box`) must include a test verifying **Round 1 Start -> Complete -> Round 2 Start -> Complete** to catch sticky state bugs.
12. **Mandatory Verification**: Always run `pnpm run typecheck && pnpm test` before completing any task.

## Full References (Read only when deeper detail is needed)
- [docs/rules/rule-typescript-coding.md](../../docs/rules/rule-typescript-coding.md)
- [docs/rules/rule-testing.md](../../docs/rules/rule-testing.md)
