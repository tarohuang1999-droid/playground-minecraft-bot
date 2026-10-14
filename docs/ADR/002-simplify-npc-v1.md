# ADR-002：縮小NPC第一版的結構

- 日期：2026-10-12
- 狀態：Accepted（設計，尚未實作）
- 取代：[ADR-001](001-npc-control-boundaries.md)的檔案分層、tier與模型預建規格。

## 原因

使用者指出先前設計難以理解、拆分過多。第一版只有五種行為，沒必要先建立core、deciders、orders、blackboard和mode註冊層。Coding rules的要求是給agent看的文件，不是要求新增遊戲rules.js。

## 決定

採用bot.js、commands.js、controller.js、behaviors/、skills/。判斷條件寫在各behavior.priority；controller只比較與切換。感知和JSON存檔先留bot.js內具名函式，複雜後再抽檔。

保留真正必要的單一run與取消等待，移除tier、分數加成、最短停留、指數退避、模型封包版本、訓練日誌等v1機制。只保留follow距離門檻與固定2秒錯誤重試。

主人task、身心資料、current行為分開。情緒和飢餓影響行為判斷，不各自建立FSM或複製全部行為。v1先不實作情緒與吃飯。

## 取捨

相比全部放一支腳本，這個結構仍可分別測命令、行為與取消；相比原方案，檔案和概念都更少。未來接模型會需要補驗證與非同步處理，但現在不為尚未選定的模型建立框架。維持既有JS/CommonJS與套件；本次僅改文件。
