# Implementation Plans: Companion Bot

本專案採分階段漸進式架構開發，詳細規格與實作計畫劃分如下：

- **[Stage 1: Companion Bot Core 與有界導航 (核心引擎與基礎設施)](implement-plan-stage-1.md)**
  - 核心狀態機與行為樹（Reactive BT）、資源仲裁器（Arbiter & Executor）、感知層、跟隨導航、戰鬥自衛、緊急撤退、進食補給、裝備換裝、物品撿拾、基地與重生點、門體通過與航點校正。
- **[Stage 2: 生存物資採集、自主狩獵與農業自動化 (State, Hunt, Farm, Harvest)](implement-plan-stage-2.md)**
  - 狀態清單增強（裝備展示與正規表達式過濾）、集合地錨定（直徑 50 格邊界約束）、自主動物狩獵（牛/豬/羊/雞）與生肉掉落物收集、小麥農業種植（Triticum）與成熟收割補種。
