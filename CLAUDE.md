# CLAUDE.md — 譯（隱私優先雙語翻譯擴充）

## 這個專案
Chrome 擴充（WXT + TypeScript + React）。預設用 Chrome 內建 Translator API 在使用者裝置上翻譯，文字不出裝置。目標使用者：在意資料流向但不想折騰設定的中文重度外文閱讀者。

## 架構鐵律（違反＝錯，沒有例外）
1. 永不新增任何接觸使用者內容的伺服器呼叫；不接灰色免費翻譯端點。
2. 零遙測：不加任何統計上報、遠端 log。
3. 注入網頁的程式一律零框架純 DOM；React 只准出現在 entrypoints/ 的自有頁面；framework import 不得進 lib/。
4. 零破壞：只加節點（<x-yi>）、不改原節點、不碰輸入框、不攔事件。「弄壞網站」是 P0 bug。
5. 會觸發語言包下載的 Translator.create() 只能發生在使用者手勢內（popup 的啟用鈕）；content script 只在 availability === 'available' 時翻譯。

## 目錄地圖
- entrypoints/content.ts：訊息入口、session 生命週期（含 __YI_TESTING__ 測試觸發器，只進 build:test 產物）
- entrypoints/popup/：React popup（語言包啟用＋翻譯開關＋統計列）
- lib/engine.ts：引擎介面＋L0 本地引擎（BYOK 之後照同介面新增）
- lib/segmenter.ts：分段器——改動最頻繁的檔案，改完必跑驗證迴圈
- lib/scheduler.ts：可視優先佇列＋MutationObserver＋統計
- lib/renderer.ts：<x-yi> 注入與移除

## 指令
- `npm run compile`：型別檢查（每次改完先跑）
- `npm run build:test`：測試建置（含測試觸發器）
- `npm run build`：正式建置（不含觸發器）
- `node scripts/verify.mjs <url> [--scroll]`：載入擴充 → 開頁 → 觸發翻譯 → 輸出 xyiCount 與 reports/verify.png

## 驗證迴圈（每個修改都要走完）
1. `npm run compile && npm run build:test`
2. `node scripts/verify.mjs <與該 issue 相關的網站>`（動態頁加 `--scroll`）
3. 讀 stdout 的 xyiCount 與 reports/verify.png 截圖，對照 BACKLOG.md 該項的驗收標準
4. 不過就繼續改；過了才收工，回報 diff 摘要與驗證數據

## 環境事實（已實測，不用懷疑也不用重驗）
- 本地 Translator API 只存在於真 Chrome 138+ 桌面版；Playwright 內建 Chromium 沒有 → verify 一律 `channel: 'chrome'`
- LanguageDetector 在 content script 不可用；備援語言判斷（scheduler 的 guessSource）已內建
- `.pw-profile` 是 verify 專用的固定 Chrome profile：第一次跑要在跳出的視窗手動點擴充圖示「啟用本地翻譯」（一次性）；要測 Threads 等需登入的站，也在這個 profile 登入一次即可

## 工作方式
- 一次只做 BACKLOG.md 的一個項目；動工前先簡述計畫再改
- 改 lib/segmenter.ts、lib/scheduler.ts 前先完整讀該檔
- 不主動新增依賴；需要時先提出理由
