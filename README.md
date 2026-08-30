# 幾個譯思 Fogone

*Fogone（fog + gone，霧、沒了）／發音 fog-gone*

**在你自己的裝置上把外文網頁變成雙語 —— 內容不離開電腦。**

Chrome 擴充。預設使用 Chrome 內建的本地 Translator API，原文與譯文並排顯示，
不覆蓋、不取代原文。給在意資料流向、但不想為此折騰設定的中文重度外文閱讀者。

> 開發中，尚未上架。版本 0.1.0（內測開門版）。

### 關於名字

**幾個譯思**是「幾個意思」的雙關——讀外文時心裡冒出的那句「這到底幾個意思」，
正是這個擴充要解決的。**Fogone** 由 fog（霧）與 gone（沒了）共用一個 g 縮合而成，
唸作 fog-gone：看不懂的那層霧，散了。中文名承擔主要市場的溝通，英文名承擔 repo、網域與國際場合。

---

## 資料流向

這是整個專案存在的理由，所以放在最前面。

| 模式 | 你的文字會去哪裡 |
|---|---|
| **預設（本地引擎）** | **哪裡都不去。** 翻譯由 Chrome 內建的裝置端模型完成，文字從未離開瀏覽器。 |
| **BYOK（尚未推出）** | 從你的瀏覽器**直連你自己設定的服務供應商**，用你自己的金鑰。 |

**免費與預設功能一律在你的裝置上、或直連你自選的服務完成，永不經過我們的伺服器。**

本地模式下文字根本沒有離開瀏覽器；BYOK 模式下資料直接到你指定的那家供應商
（那是你選的、你付費的、你隨時可以換掉的），中間不多停一站。

**零遙測**：沒有使用統計、沒有錯誤回報、沒有遠端 log。連「有多少人在用」我們都不知道。
擴充內的統計數字（翻了幾段、打了幾次引擎、快取命中幾次）只存在你的瀏覽器記憶體裡，
關掉分頁就消失，只有你看得到 —— 那是給你除錯用的，不是給我們的。

目前 `manifest.json` 的 `permissions` 是空陣列。

---

## 架構鐵律

專案裡所有技術決策都讓位給這五條。違反就是錯，沒有例外。

1. **免費與預設功能永不經過自家伺服器** —— 翻譯在你的裝置上完成，或直連你自選的服務；
   也不接來路不明的免費翻譯端點。
2. **零遙測**：不加任何統計上報、遠端 log。
3. **注入網頁的程式一律零框架純 DOM。** React 只准出現在擴充自有頁面；
   framework import 不得進 `lib/`。
4. **零破壞**：只加自己的節點（`<x-yi>`），不改原節點、不碰輸入框、不攔事件。
   「弄壞網站」是 P0 bug。這條涵蓋的不只是節點本身，也包含原內容的視覺位置。
5. **會觸發語言包下載的 `Translator.create()` 只能發生在使用者手勢內**（popup 的啟用鈕）；
   content script 只在 `availability === 'available'` 時翻譯。

第 4 與第 5 條是實際會被違反的兩條，程式碼裡相關位置都有註解說明為什麼那樣寫。

---

## 需求

- 桌面版 **Chrome 138 以上**（本地 Translator API 只存在於此）
- Node.js 20+（開發用）

Edge、Brave、Arc 等其他 Chromium 系瀏覽器目前沒有這個 API，不支援。

---

## 使用

1. 點工具列的擴充圖示 → **啟用本地翻譯**
   （語言包下載發生在這一次點擊內，這是鐵律 5 的落地處）
2. 之後任何頁面：點圖示 → **雙語翻譯此頁**
3. **關閉此頁翻譯** 會移除該頁全部譯文與標記，不留殘骸

YouTube 影片頁會另外把 CC 字幕（含自動生成字幕）即時翻成繁中，疊在原文字幕旁邊。

---

## 開發

```bash
npm install        # 安裝依賴（postinstall 會跑 wxt prepare 產生型別）
npm run dev        # 開發模式：自動開 Chrome、存檔自動重載
npm run compile    # TypeScript 型別檢查（每次改完先跑）
npm run build      # 正式建置 → .output/chrome-mv3/
npm run build:test # 測試建置（多含自動化用的觸發器，正式建置不含）
npm run zip        # 打包上架用 zip
```

不用 dev 模式的話：`npm run build` 之後到 `chrome://extensions` →
開啟開發人員模式 → 載入未封裝項目 → 選 `.output/chrome-mv3`。

### 驗證腳本

```bash
node scripts/verify.mjs <url> [--scroll]   # 一般網頁：分段、譯文數、外框排除、快取
node scripts/verify-yt.mjs [videoId] [秒]  # YouTube 字幕：cue 數、引擎呼叫、播放控制
node scripts/spike-summarizer.mjs          # Summarizer API 可行性量測（不會觸發下載）
```

驗證跑的是系統安裝的正式版 Chrome（本地 Translator API 只存在於它），
用 `.pw-profile` 這個固定 profile。**第一次要做一次性設定**：

1. 先 `npm run build:test`
2. 跑任一驗證腳本，它會開一個 Chrome 視窗
3. 在該視窗進 `chrome://extensions` → 開啟開發人員模式 → 載入未封裝項目 → 選 `.output/chrome-mv3`
4. 點擴充圖示 →「啟用本地翻譯」下載語言包

之後這個 profile 就記住了，rebuild 後直接重跑驗證即可。
（需要登入才能測的站，也在這個 profile 登入一次；但目前刻意不登入任何站——
repo 要公開，profile 裡少一份登入 cookie 就少一個要保護的祕密。）

所有已實測的環境事實記在 `CLAUDE.md`。

### 結構

```
entrypoints/content.ts     content script：訊息入口、session 生命週期
entrypoints/popup/         React popup：語言包啟用、翻譯開關、統計列
lib/engine.ts              引擎介面 ＋ L0 本地引擎（BYOK 之後照同介面新增）
lib/segmenter.ts           分段器：決定頁面上哪些東西該翻
lib/scheduler.ts           可視優先佇列、MutationObserver、統計
lib/renderer.ts            <x-yi> 譯文節點的注入與移除
lib/cache.ts               分頁層級翻譯快取（LRU）
lib/sites/                 站點專屬模組（目前：YouTube 字幕）
types/builtin-ai.d.ts      Translator / LanguageDetector 的型別宣告
                           （TypeScript 官方 DOM 型別尚未收錄這些 API）
```

站點專屬的知識一律關在 `lib/sites/` 裡 —— 通用管線不出現任何站名判斷。

---

## 尚未完成

翻譯快取的持久化（IndexedDB）、BYOK 引擎、資料流向面板、行內格式保留、
站點例外規則（資料驅動的例外清單）、PDF、摘要模式、設定頁。
已知問題與待辦見 `BACKLOG.md`。

---

## 授權

TBD
