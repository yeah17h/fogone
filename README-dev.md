# 譯 — 開發骨架（M1 起點）

隱私優先雙語翻譯擴充。預設引擎：Chrome 本地 Translator API（L0），文字不出裝置。

## 需求
- Node.js 20+、桌面版 Chrome 138+

## 指令
```bash
npm install        # 安裝依賴（會自動跑 wxt prepare 產生型別）
npm run dev        # 開發模式：自動開一個 Chrome、存檔自動重載
npm run build      # 正式建置 → .output/chrome-mv3/
npm run compile    # 只跑 TypeScript 型別檢查
npm run zip        # 打包上架用 zip
```
不想用 dev 模式的話：`npm run build` 後到 chrome://extensions
「載入未封裝項目」選 `.output/chrome-mv3`。

## 使用流程（首次）
1. 點工具列圖示 → 「啟用本地翻譯」（在這一次點擊內下載 en/ja → 繁中語言包，鐵律 7）
2. 之後任何頁面：點圖示 → 「雙語翻譯此頁」；「關閉此頁翻譯」移除全部譯文

## 結構
```
entrypoints/content.ts     content script：收訊息、管 session 生命週期
entrypoints/popup/         React popup：啟用（語言包下載）＋翻譯開關
lib/engine.ts              引擎介面 + L0 本地引擎（L1 BYOK 之後照介面補）
lib/segmenter.ts           分段器（最值得寫測試的模組）
lib/renderer.ts            <x-yi> 譯文節點注入與移除
lib/scheduler.ts           可視優先佇列 + MutationObserver 動態頁面
types/builtin-ai.d.ts      Translator / LanguageDetector 型別宣告
```

## 骨架刻意還沒做的
翻譯快取（IndexedDB）、BYOK 引擎、資料流向面板、行內格式保留、
站點例外規則、設定頁。都在 PRD 範圍內，依 M1 清單補。
