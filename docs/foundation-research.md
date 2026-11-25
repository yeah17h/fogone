# 幾個譯思 Fogone 重建基礎研究報告

- **撰寫日期**：2026-11-25
- **專案定位**：給中文使用者學外語的 Chrome 擴充功能——「閱讀為主、學習是附帶的收穫」，日常雙語翻譯仍是核心主功能；新增生詞標記（單字層級、可點選）、單字本與記憶小測驗；不做模糊翻譯顯示模式。
- **核心原則**：預設翻譯引擎維持 Chrome 內建 `Translator` API（本機離線翻譯、文字不出裝置）；沿用 `legacy/CLAUDE.legacy.md` 五條架構鐵律與兩條驗證／診斷原則；授權採 **AGPL-3.0-only**。
- **查證說明**：本報告中所有 GitHub 專案星數、授權條款、最後 commit 日期、Chrome 儲存配額與 npm／WASM 套件實際體積均於 **2026-11-25** 實查驗證；無法查得之項目皆明確標註「查不到」。`legacy/public/pdfjs/` 為 `.gitignore` 排除的建置產物，不列為原始碼分析。

---

## 1. 舊專案萃取

`legacy/` 為 Fogone v0.2.0 完整原始碼，採 **WXT 0.20 + TypeScript + React 19 + Vitest + Playwright CDP**，核心 `lib/` 總計不到 2,000 行且完全零框架依賴，已完整實作並實測驗證「網頁雙語翻譯」、「YouTube 字幕即時翻譯」與「PDF 文字層重排雙語閱讀」。

下表完整盤點 `legacy/` 底下**全部目錄與檔案**（依分類列出，確保無遺漏），並標註新專案的處置方式：**新專案直接搬**、**參考後重寫**、**不需要**。

### 1.1 `legacy/entrypoints/`（擴充入口點）

| 檔案路徑 | 舊專案職責 | 新專案處置 | 理由 |
|---|---|---|---|
| `legacy/entrypoints/content.ts` | 註冊 `<all_urls>` content script、處理 `yi:translate`／`yi:off`／`yi:ping`（回報 `isPdf` 與 `location.href`）、掛載 `__YI_TESTING__` 測試觸發器。 | **參考後重寫** | 生命週期與 `__YI_TESTING__` 條件編譯結構乾淨可沿用，但新專案需新增生詞標記（CSS Highlight）生命週期、單字點擊查詞與跟 background 單字本的訊息協定。 |
| `legacy/entrypoints/popup/index.html`<br>`legacy/entrypoints/popup/main.tsx` | React popup：使用者手勢內並行呼叫 `Translator.create()`（鐵律 5）、逐語言對顯示 availability 與 `anyReady` 翻譯按鈕解鎖、開啟 PDF 檢視器、顯示統計列。 | **參考後重寫** | 必須保留「逐對顯示 availability＋`anyReady` 解鎖＋手勢內啟用語言包＋統計列」，但 UI 需重新設計以容納生詞標記開關、單字本入口與測驗／複習狀態。 |
| `legacy/entrypoints/viewer/index.html`<br>`legacy/entrypoints/viewer/main.tsx` | React PDF 重排檢視器：拖放／選檔（繞開 `file://` 限制）、`?url=` 載入、`genRef` + `AbortController` 競態防護、命令式掛載 `<p>` 避開 React 重繪洗掉 `<x-yi>`、`data-yi-skip` 防自翻、閉合段落總帳、30 頁上限、逃生口連結與 `__yiViewer` 測試掛鉤。 | **參考後重寫** | 內部工程設計（命令式正文容器、`genRef`、閉合總帳、`data-yi-skip`）非常成熟，應保留核心骨架並重寫整合單字層級標記與點擊查詞功能。 |

### 1.2 `legacy/lib/`（核心純 TypeScript 零框架模組）

| 檔案路徑 | 舊專案職責 | 新專案處置 | 理由 |
|---|---|---|---|
| `legacy/lib/engine.ts` | `Engine` 介面與 `LocalEngine`（L0 Chrome 內建 `Translator` API、依語言對快取 translator promise、`SUPPORTED_SOURCES = ['en', 'ja']`、`TARGET = 'zh-Hant'`）。 | **新專案直接搬** | 介面抽象乾淨且完全符合鐵律 1、3、5；直接搬移後僅需視首發與後續語言調整 `SUPPORTED_SOURCES`。 |
| `legacy/lib/cache.ts` | 分頁級單例 LRU `TranslationCache`（筆數 2,000＋字元數 200 萬雙上限、以 `\u001f` 分隔 raw key 避免 32-bit hash 碰撞）。 | **新專案直接搬** | 已實測解決 Threads 虛擬化重翻與同頁重開翻譯 0 引擎呼叫；設計無瑕且無框架依賴。 |
| `legacy/lib/segmenter.ts` | 兩段式分段器（標準塊級單位＋命中 ≤12 時啟動密度備援）、`PAGE_CHROME` 與 `isContentHeader`（處理 `<aside><article><header>`）、`isLinkLabel`、`looksChinese`（`KANA` 短路）、`selfAndDescendants`、`unitText`（跳過 `X-YI`）。 | **參考後重寫** | 規則極具價值（全部踩坑皆已驗證），建議保留全部過濾與雙階段策略，但重寫時補上 **open Shadow DOM 遍歷**，並規劃與單字層級標記共用文字節點掃描視窗（避免重複遍歷 DOM）。 |
| `legacy/lib/scheduler.ts` | `Session` 排程器：`IntersectionObserver`（`rootMargin: '200px 0px'`）可視優先佇列、`MutationObserver`、併發上限 3、`LanguageDetector`＋`guessSource` 備援、共用 `translateText` 管線、完整 `SessionStats`。 | **參考後重寫** | 排程核心與共用 `translateText` 非常穩健，但新專案需在段落進入可視區或翻譯流程旁掛入「生詞高亮掃描」鉤子，並支援單字本更新後即時重刷高亮。 |
| `legacy/lib/renderer.ts` | 純 DOM `<x-yi>` 樣式注入、`mountPlaceholder`／`fill`／`fail`／`unmountAll`。 | **新專案直接搬** | 僅 52 行、嚴格遵守鐵律 3 與鐵律 4；生詞高亮與 Shadow DOM 查詞卡片另建獨立模組即可，不污染 `<x-yi>` 渲染器。 |
| `legacy/lib/sites/types.ts`<br>`legacy/lib/sites/index.ts`<br>`legacy/lib/sites/youtube.ts` | 站點模組隔離介面（`SiteHost`／`SiteModule`）與 YouTube 字幕翻譯（3 訊號 ASR 滾動字幕穩定化、`generation`＋`requestSeq`/`renderedSeq` 亂序防護、`#movie_player` 獨立覆蓋層、自動上下避讓）。 | **新專案直接搬** | 已經過完整實測與多輪 review；直接搬移即可立刻擁有穩定 YouTube 雙語字幕，後續再於字幕覆蓋層上擴充單字點選能力。 |
| `legacy/lib/pdf/items.ts` | 純資料 `TextItem`／`PageText` 型別與 `toTextItems`（旋轉偵測、`height` fallback），供檢視器與測試 fixture 產生器共用。 | **新專案直接搬** | 純資料結構，與 UI 解耦，直接復用。 |
| `legacy/lib/pdf/document.ts` | 唯一接觸 `pdfjs-dist` 的模組（維持 `content.js` 零 PDF.js 負擔）、`assertSafePdfUrl`（擋私網 IPv4／IPv6／IPv4-mapped IPv6／`fe80::/10` 與 30x 轉址後 `res.url` 複查）、`looksLikePdf`、100 MB 上限、網站存取權錯誤引導與資源清理。 | **新專案直接搬** | 經過兩輪安全審查與單元測試驗證的關鍵安全防線，務必原封搬移。 |
| `legacy/lib/pdf/reflow.ts` | PDF 段落重建引擎：6 分帶雙欄中縫偵測＋整份文件共識＋跨欄表格判定、基線容錯分群、缺空白還原、公文編號斷段、英文連字號接續、流程圖雜訊過濾、跨頁頁首頁尾去重、`finite()` 防 NaN。 | **新專案直接搬** | 高難度且有 3 份無授權爭議 fixture 與 291 行單元測試保護的核心資產，零修改直接搬。 |

### 1.3 `legacy/types/`、`legacy/test/`、`legacy/scripts/`

| 檔案路徑 | 舊專案職責 | 新專案處置 | 理由 |
|---|---|---|---|
| `legacy/types/builtin-ai.d.ts` | Chrome 內建 `Translator`、`LanguageDetector` 與 `__YI_TESTING__` 的精簡 TypeScript 宣告。 | **新專案直接搬** | 精簡準確；新專案若需新增 `CSS.highlights.highlightsFromPoint` 等新 DOM 型別，可另補宣告檔。 |
| `legacy/test/pdf-url.test.ts`<br>`legacy/test/reflow.test.ts`<br>`legacy/test/fixtures/{arxiv-2col,gov-han,whitepaper}.json` | SSRF 防線單元測試（6 組繞過案例）、PDF 重排單元測試與三份授權乾淨的 PDF 文字層 fixture（CC BY 4.0、台灣政府公開文件、MIT）。 | **新專案直接搬** | 珍貴的回歸防護網且無授權風險，新專案持續於此基礎上擴充單字斷詞與資料層測試。 |
| `legacy/scripts/chrome.mjs` | 跨平台（macOS + Windows PowerShell CIM）真 Chrome CDP 啟動器，含殘留 profile 行程清理與 `Secure Preferences` 擴充 ID 解析。 | **新專案直接搬** | 解決 Chrome 152 移除 `--load-extension` 與 Windows/macOS 差異的必備基礎建設。 |
| `legacy/scripts/verify.mjs`<br>`legacy/scripts/verify-yt.mjs`<br>`legacy/scripts/verify-pdf.mjs` | 真 Chrome E2E 驗證腳本（網頁／捲動續翻、YouTube 字幕、PDF 檢視器＋fail-hard 閘門＋記憶體壓測）。 | **新專案直接搬**（並擴充） | 維持舊專案「跑真 Chrome 驗證」的誠實閉環；搬移後再新增 `verify-vocab.mjs` 驗證生詞標記與單字本。 |
| `legacy/scripts/sync-pdfjs-assets.mjs`<br>`legacy/scripts/make-pdf-fixtures.ts` | Prebuild 同步 `pdfjs-dist` `cmaps`（以 `.pdfjs-version` 戳記避免誤判，刻意跳過 `standard_fonts/` 省 816 KB）與重建測試 fixture。 | **新專案直接搬** | 直接配合 `lib/pdf/*` 使用，確保 `public/pdfjs/` 不進 Git 且跨 Mac／Windows 建置一致。 |
| `legacy/scripts/spike-summarizer.mjs` | 一次性 Summarizer API 探勘腳本（已證實繁中 `zh-Hant` 回 `unavailable`）。 | **不需要** | 歷史探勘已完成並記錄結論，新專案不需攜帶一次性實驗腳本。 |
| `legacy/scripts/store-assets.mjs` | 自動產出 6 張 24-bit 無 alpha Chrome Web Store 圖片（嚴格遵守無 SA 授權來源）。 | **參考後重寫** | 產圖腳本框架與授權規範很有價值，但須配合正式 wordmark（BACKLOG #12）與新學習功能畫面重做。 |

### 1.4 根目錄設定、對外承諾與靜態資源

| 檔案路徑 | 舊專案職責 | 新專案處置 | 理由 |
|---|---|---|---|
| `legacy/CLAUDE.legacy.md` | 5 條架構鐵律＋2 條驗證／診斷原則（合計常稱七條鐵律）、環境事實與驗證迴圈。 | **參考後重寫** | 規則精神完整沿用至新專案 `CLAUDE.md`，並補充「單字本本機儲存」與「生詞標記零 DOM 修改」的新增邊界。 |
| `legacy/PRIVACY.md`<br>`legacy/store/listing.md`<br>`legacy/store/submission-notes.md` | 對外隱私權政策（網址 `https://github.com/yeah17h/fogone/blob/main/PRIVACY.md`）、商店頁文案與無 SA 截圖來源規則。 | **參考後重寫** | **關鍵注意事項**：舊 `PRIVACY.md` 明寫「不使用 `chrome.storage` 或 `IndexedDB`、`permissions` 為空陣列」。新專案加入本機單字本後，**上架前必須同步改寫 `PRIVACY.md` 與商店文案**，誠實說明單字本存於本機瀏覽器且不上傳；並沿用既有網址與無 SA 截圖規範。 |
| `legacy/wxt.config.ts`<br>`legacy/package.json`<br>`legacy/tsconfig.json`<br>`legacy/vitest.config.ts`<br>`legacy/.gitignore`<br>`legacy/.gitattributes` | WXT 建置設定（`npm_lifecycle_event === 'build:test'` 注入 `__YI_TESTING__`）、腳本與型別／測試組態。 | **參考後重寫** | 結構極佳；新專案升版至 WXT 0.21.5、加入 `storage` 權限（若採 `chrome.storage.local`）與 background service worker 入口，同時保留 `npm_lifecycle_event` 跨平台寫法。 |
| `legacy/LICENSE`<br>`legacy/THIRD_PARTY.md`<br>`legacy/CONTRIBUTING.md`<br>`legacy/README.md` | AGPL-3.0 授權全文、第三方元件聲明與貢獻說明。 | **新專案直接搬**（`LICENSE`）／**參考後重寫**（其餘） | `LICENSE`（AGPL-3.0-only）直接沿用；`README.md` 與 `THIRD_PARTY.md` 依新功能與新套件清單更新。 |
| `legacy/BACKLOG.md`<br>`legacy/docs/pre-public-checklist.md`<br>`legacy/docs/research/pdf-text-layer.md` | 歷史 issue 紀錄、公開前檢查清單與 PDF 偵察報告。 | **參考後重寫**（`pre-public-checklist.md`）／**不需要**（其餘留 `legacy/` 備查） | `pre-public-checklist.md` 上架前仍有高度參考價值；其餘屬於舊版歷史脈絡，重點已萃取至本報告第 2 節。 |
| `legacy/public/icon/{16,32,48,128}.png`<br>`legacy/store/assets/*.png`<br>`legacy/reports/verify.png` | 佔位圖示（16px 「譯」糊成色塊，見 BACKLOG #12）、舊版商店圖片與驗證截圖。 | **不需要** | 須重新設計正式 wordmark（含獨立 16px 版本）並在重建完成後重產商店圖。 |
| `legacy/public/pdfjs/` | `.gitignore` 排除的 prebuild 產物（由 `sync-pdfjs-assets.mjs` 產生）。 | **不需要**（非原始碼） | 非版本庫原始碼，由建置腳本於各平台自動生成。 |

---

## 2. 踩坑清單（新專案須逐條繼承）

以下彙整舊專案在真實網站、編碼與語言偵測、Shadow DOM、YouTube 字幕、PDF 重排與 Chrome 138+/152+ 環境中實際踩過並驗證的坑。每條均附上**問題**、**舊解法（或已知未解邊界）**與**檔案路徑**。

### 2.1 特定網站與 DOM／Shadow DOM 特殊情況

| # | 問題 | 舊的解法（新專案繼承要點） | 舊專案檔案 |
|---|---|---|---|
| 1 | **導覽列、側欄、UI 標籤過翻撐破版面**（BBC 主導覽 Home→故鄉、MDN 側欄與 API 名稱被翻且換行）。 | 排除 `PAGE_CHROME` 祖先（`nav`、`header`、`footer`、`aside`、`[role=navigation/menubar/tablist]`），但用 `isContentHeader` 保留文章內部的 `<article><header>`（同時排除 `<aside><article><header>`）；用 `isLinkLabel` 跳過純連結短標籤（≤2 詞且幾乎全在 `<a>` 內）。 | `legacy/lib/segmenter.ts`、`legacy/BACKLOG.md`（#1） |
| 2 | **純 `div`/`span` 站點（Threads）抓不到主內容**（標準塊級選擇器命中過低）。 | 採兩段式分段：標準選擇器命中 ≤12 才啟動 `collectDenseUnits` 密度備援（直接文字節點夠長、比例 ≥0.5、過濾帳號與時間戳）。注意已知限制：策略在 `start()` 決定後不再重評，且密度容器可能順帶吞進短中繼資料子節點。 | `legacy/lib/segmenter.ts`、`legacy/lib/scheduler.ts`、`legacy/BACKLOG.md`（#2） |
| 3 | **虛擬化列表（Threads）卸載 `<x-yi>` 與 `data-yi-done` 導致捲回重複翻譯**，且 `xyiCount` 只量到視窗容量（5～6 個）。 | 建立分頁級 LRU `translationCache`（捲回命中快取不重呼叫引擎）；驗收原則改看累計 `stats.done` 而非當下 `xyiCount`。 | `legacy/lib/cache.ts`、`legacy/lib/scheduler.ts`、`legacy/CLAUDE.legacy.md`、`legacy/BACKLOG.md`（#2、#10） |
| 4 | **`MutationObserver` 漏掉「新增節點本身即翻譯單位」的情況**（`root.querySelectorAll()` 不包含 `root` 自己）。 | 透過 `selfAndDescendants` 先檢查 `root` 自身是否符合選擇器再併入子孫查詢結果並去重。 | `legacy/lib/segmenter.ts`、`legacy/BACKLOG.md`（#2） |
| 5 | **SPA 移動節點時誤將自家 `<x-yi>` 譯文當成原文再翻一次**。 | 掃描單位時檢查是否已含 `querySelector('x-yi')`，且 `unitText()` 走訪文字節點時刻意跳過 `X-YI` 子樹。 | `legacy/lib/segmenter.ts` |
| 6 | **Threads 未登入會彈登入牆 dialog，把 `document.scrollHeight` 壓成視窗高度（900px）**，導致自動捲動失效。 | 驗證腳本於載入後與捲動前各送出一次 `Escape` 關掉 modal（通用手勢，非單站 hack），`scrollHeight` 立即恢復（900→10976）。 | `legacy/scripts/verify.mjs`、`legacy/CLAUDE.legacy.md` |
| 7 | **Reddit 首頁反機器人攔截（`Prove your humanity`），且貼文標題是裸 `<a>` 收不到**；同家族盲點：**青空文庫純 `<br>` 頁面被密度備援收成單一萬字巨型單元**。 | 驗證改打 `r/programming`；裸 `<a>` 標題與 `<br>` 密集容器分段為舊版**已定位但尚未實作**的邊界（#9），新專案設計分段器時須列為規劃考量。 | `legacy/lib/segmenter.ts`、`legacy/BACKLOG.md`（#9）、`legacy/CLAUDE.legacy.md` |
| 8 | **Shadow DOM（隔離 DOM）盲點與全螢幕崩潰風險**：舊版 `segmenter.ts` 的 `querySelectorAll` **不會穿透 open Shadow DOM**（如 Web Components、部分現代文件站與 Reddit 新版元件會漏翻）；另外參考開源專案實績（`kiss-translator` #1135），在全螢幕切換時若對 Shadow Host 呼叫 `moveBefore` 會觸發 Chromium 崩潰。 | 舊版尚未實作 Shadow DOM 穿透；新專案須在分段器與生詞標記中補上**遞迴遍歷 open `shadowRoot`**（並為每個 `shadowRoot` 掛載 `adoptedStyleSheets`），而 Fogone 自身的查詞卡片 Shadow Host 固定掛在 `document.documentElement` 且絕不搬動頁面原節點。 | `legacy/lib/segmenter.ts`、`legacy/lib/renderer.ts` |

### 2.2 編碼、語言偵測與快取

| # | 問題 | 舊的解法（新專案繼承要點） | 舊專案檔案 |
|---|---|---|---|
| 9 | **日文漢字被 `looksChinese` 誤判為中文而整段跳過**（中日共用 `U+4E00–9FFF` 碼位）。 | 在計算漢字佔比前先用 Unicode `Script=Hiragana\|Katakana`（`KANA`）短路回傳 `false`；用 Unicode Script 屬性可同時涵蓋半形片假名（`U+FF66–FF9D`），又不會誤抓共用標點 `・`/`ー`（`Script=Common`）。 | `legacy/lib/segmenter.ts`、`legacy/BACKLOG.md`（#3、#7） |
| 10 | **不同檔案各自寫一套假名／字元規則會漂移不一致**（#7 根因），且用 `[a-z]` 過濾字母會誤刪韓文與歐語字元。 | 由 `segmenter.ts` 匯出單一 `KANA` 常數供 `scheduler.ts` 共用；所有字母判斷統一採用 Unicode 屬性 `/\p{L}/u`。 | `legacy/lib/segmenter.ts`、`legacy/lib/scheduler.ts`、`legacy/lib/pdf/reflow.ts`、`legacy/CLAUDE.legacy.md` |
| 11 | **32-bit 快取雜湊會靜默碰撞**（2,000 筆約 0.05% 機率顯示錯段譯文），且只限筆數不限字元數會讓長文撐爆記憶體；鍵分隔符若寫成實體控制字元會害 Git 當成二進位檔。 | `TranslationCache` 直接以完整字串當 key（引擎 id + 語言對 + 原文），分隔符寫成轉義字面量 `\u001f`，並設**雙重上限**（`MAX_ENTRIES = 2000` 且 `MAX_CHARS = 2_000_000`）。 | `legacy/lib/cache.ts`、`legacy/BACKLOG.md`（#10） |

### 2.3 Chrome 內建 AI 與跨平台驗證環境

| # | 問題 | 舊的解法（新專案繼承要點） | 舊專案檔案 |
|---|---|---|---|
| 12 | **`LanguageDetector` 在 content script 環境曾實測不可用**（不同批次結果不一致）。 | 架構不賭任一邊：`LanguageDetector` 可用時優先使用，失敗或不可用時無縫退回 `guessSource`（共用 `KANA` 規則），統計列改中性文案顯示。 | `legacy/lib/scheduler.ts`、`legacy/CLAUDE.legacy.md`、`legacy/BACKLOG.md`（#6） |
| 13 | **`Translator.availability()` 在網頁環境對 `ja→zh-Hant` 會出現間歇性偽陰性**（回 `downloadable` 而擴充頁面同時回 `available`）；若 popup 用 `pairs.every(available)` 閘門會連可用的英文都卡死。 | Popup 改採 `anyReady`（任一語言對可用就開翻譯鈕），並逐對顯示實際 availability（區分 `downloadable`／`downloading`）與「啟用其餘語言包」按鈕。 | `legacy/entrypoints/popup/main.tsx`、`legacy/lib/scheduler.ts`、`legacy/BACKLOG.md`（#8、#14） |
| 14 | **`Translator.create()` 無使用者手勢不會被 Chrome 阻擋**，且 `downloadprogress` 即使模型已在磁碟仍會觸發（0→1）。 | 鐵律 5 必須自律守住：content script 嚴格只在 `availability === 'available'` 呼叫 `create()`；絕不用「有無收到 `downloadprogress`」反推是否在下載。 | `legacy/lib/engine.ts`、`legacy/entrypoints/popup/main.tsx`、`legacy/CLAUDE.legacy.md` |
| 15 | **Chrome 152 正式版移除 `--load-extension`**；且同 profile 若有殘留 Chrome 行程，新啟動行程會把網址轉交給舊實例，導致測到舊 build 卻無聲無息。 | 捨棄 `--load-extension`，改用固定 `.pw-profile`＋`child_process.spawn` 啟動真 Chrome（`--remote-debugging-port`）＋CDP 附加，且啟動前必清殘留同 profile Chrome 行程。 | `legacy/scripts/chrome.mjs`、`legacy/CLAUDE.legacy.md` |
| 16 | **Windows／macOS 腳本不相容**：PowerShell 不支援 `VAR=1 cmd`、沒有 `pgrep`/`sleep`、磁碟機路徑大小寫不一致。 | `wxt.config.ts` 改讀 `process.env.npm_lifecycle_event === 'build:test'`；`chrome.mjs` 在 Windows 用 PowerShell `Get-CimInstance` 查行程、用 `Atomics.wait` 跨平台等待。 | `legacy/wxt.config.ts`、`legacy/scripts/chrome.mjs` |

### 2.4 YouTube 字幕特殊情況

| # | 問題 | 舊的解法（新專案繼承要點） | 舊專案檔案 |
|---|---|---|---|
| 17 | **直接串接 `.caption-visual-line` 的 `textContent` 會把字黏在一起**（例：`coming tothe`）。 | 逐行讀文字後以 `.join(' ')` 空格連接。 | `legacy/lib/sites/youtube.ts`、`legacy/CLAUDE.legacy.md` |
| 18 | **自動生成 CC 是滾動視窗**（約 2.7 次/秒逐字增刪，無乾淨 cue 邊界）。 | 實作三訊號穩定化：停頓 `STABLE_MS = 700`ms、非追加型大幅變動即定稿、最長等待 `MAX_PENDING_MS = 2500`ms 強制送翻。 | `legacy/lib/sites/youtube.ts` |
| 19 | **非同步翻譯亂序回傳與 SPA 切影片殘留舊字幕**。 | 維護 `generation`（切影片遞增）與 `requestSeq`/`renderedSeq` 單調序號，且失敗或跳過時同樣推進 `renderedSeq` 以免舊回傳蓋回畫面。 | `legacy/lib/sites/youtube.ts` |
| 20 | **播放器控制列顯示／收起時，YouTube 只改字幕視窗的 `style` 屬性來上下移動**（約 80px）。 | `MutationObserver` 必監聽 `attributes: ['style']`，且在「字幕文字未變提前 return」**之前**先執行 `position()` 重新對齊。 | `legacy/lib/sites/youtube.ts`、`legacy/CLAUDE.legacy.md` |
| 21 | **預設字幕貼底僅距底約 10px（放不下 40px 譯文），且不應改動原生字幕位置**（鐵律 4）；全螢幕時要跟著進全螢幕。 | 譯文覆蓋層掛在 `#movie_player`（不污染 `.ytp-caption-window-container` 且自動跟隨全螢幕），設 `pointer-events: none`；下方夠放就置下、不夠自動置上，絕不注入 CSS 推原文字幕。 | `legacy/lib/sites/youtube.ts`、`legacy/BACKLOG.md`（#11）、`legacy/CLAUDE.legacy.md` |
| 22 | **`player.getOption('captions','tracklist')` 不填 `kind`/`name`**，無法判斷是否為自動生成字幕。 | 驗證腳本改由讀取字幕選單標籤（如「英文 (自動產生)」）識別 ASR，站內導航改點 `.ytp-next-button` 避開常變動的側欄 DOM。 | `legacy/scripts/verify-yt.mjs`、`legacy/CLAUDE.legacy.md` |

### 2.5 PDF 檢視器、安全與重排特殊情況

| # | 問題 | 舊的解法（新專案繼承要點） | 舊專案檔案 |
|---|---|---|---|
| 23 | **Chrome 原生 PDF 檢視器沒有可讀 `document.body`**；且本機 `file://` 權限預設關閉無法在 manifest 申請。 | Content script 偵測 `document.contentType === 'application/pdf'` 回報 popup，引導使用者開啟自有 `viewer` 頁面；本機檔採拖放／`<input type="file">` 繞開 `file://` 限制。 | `legacy/entrypoints/content.ts`、`legacy/entrypoints/viewer/main.tsx`、`legacy/docs/research/pdf-text-layer.md` |
| 24 | **具 `<all_urls>` 權限的 `?url=` 抓取有 SSRF 風險**：可被 30x 轉址到 `127.0.0.1` 或被 IPv4-mapped IPv6（`[::ffff:7f00:1]`）與 `fe90::`～`febf::` 繞過。 | `assertSafePdfUrl` 還原 IPv6 內嵌 IPv4、封鎖私網／loopback／link-local 完整範圍，並在 `fetch`（`credentials: 'omit'`）回來後**對 `res.url` 再驗一次**；附 6 組回歸單元測試。 | `legacy/lib/pdf/document.ts`、`legacy/test/pdf-url.test.ts`、`legacy/BACKLOG.md`（#15） |
| 25 | **使用者把「網站存取權」改為「點按時」時，`fetch` 只丟 `TypeError: Failed to fetch`**；下載途中斷線則在 `res.arrayBuffer()` 才丟錯。 | 先檢查 `navigator.onLine` 區分離線與存取權限，給出明確 `chrome://extensions` 修改路徑；並單獨 `try/catch` 包住 `res.arrayBuffer()`；先驗 `%PDF-` 魔術位元組與 100 MB 上限。 | `legacy/lib/pdf/document.ts`、`legacy/BACKLOG.md`（#15） |
| 26 | **React 重繪會把檢視器裡的 `<x-yi>` 洗掉**；段落很少時密度備援還會把檢視器自己的統計列翻掉；快速切換檔案會競態覆蓋或洩漏 PDF.js worker。 | 正文 `<p>` 由命令式 DOM 容器掛載（不交給 React）；檢視器 UI chrome 全面加 `data-yi-skip`；用 `genRef` + `AbortController` 擋競態，解析失敗或結束皆在 `finally` 呼叫 `task.destroy()`／`page.cleanup()`。 | `legacy/entrypoints/viewer/main.tsx`、`legacy/lib/pdf/document.ts`、`legacy/BACKLOG.md`（#15） |
| 27 | **雙欄論文按 y 排序會左右交錯，全頁表格硬拆兩欄會毀掉**；缺空白字元 PDF（如 arXiv）會黏字、基線 `Math.round(y)` 會拆行、旋轉裝訂文字與頁首頁尾干擾閱讀。 | 6 分帶中縫偵測＋整份文件共識＋逐行 `crossesAt` 跨欄判定；`unit * 0.3` 基線容錯分群；非 CJK 間距 `> 0.1 * height` 補空白；結構式流程圖雜訊過濾（`wideGaps >= 2`＋相鄰重複且 ≥3 字避免誤殺 `COCO`）；跨頁頁首頁尾 `normKey` 去重；公文編號 `NUMBER_PREFIX` 斷段；英文連字號僅於次行小寫開頭接合；`finite()` 防 NaN。 | `legacy/lib/pdf/reflow.ts`、`legacy/lib/pdf/items.ts`、`legacy/test/reflow.test.ts` |
| 28 | **`pdfjs-dist` 打包進 `content.js` 會暴漲體積**，且 `standard_fonts/` 佔 816 KB 多餘空間；只數檔案數同步 `cmaps` 會在升版後漏更。 | 嚴格隔離 `pdfjs-dist` 僅在 `lib/pdf/document.ts` 與 `viewer` 使用（維持 `content.js` 約 17 KB）；prebuild 腳本以 `.pdfjs-version` 版本戳記同步 `cmaps/` 並跳過 `standard_fonts/`。 | `legacy/lib/pdf/document.ts`、`legacy/scripts/sync-pdfjs-assets.mjs` |

---

## 3. GitHub 前 5 名比較（開源「翻譯＋語言學習」瀏覽器擴充功能）

以下資料均於 **2026-11-25** 直接查詢 GitHub REST API、各專案根目錄 `LICENSE` 全文與 `package.json` 驗證。

### 3.1 篩選與授權前提說明

- **明確排除的熱門專案**：
  - [immersive-translate/immersive-translate](https://github.com/immersive-translate/immersive-translate)（19,881★）：官方 README 明確聲明為**閉源（not open-source）**，版本庫僅含 issue 追蹤與文件，無任何原始碼。
  - [FilipePS/Traduzir-paginas-web](https://github.com/FilipePS/Traduzir-paginas-web)（6,089★，MPL-2.0，最後 commit 2026-10-29）：純整頁即時翻譯工具，無生詞標記、查詞彈窗或單字本等語言學習功能。
- **AGPL-3.0-only 授權相容規則（依 GNU.org 官方 GPLv3／AGPLv3 第 13 條）**：
  - **MIT／Apache-2.0／BSD／ISC**：寬鬆授權，可 fork 並將衍生專案整體以 **AGPL-3.0-only** 釋出（須保留原始版權聲明與授權條款）。
  - **GPL-3.0（含 GPL-3.0-only 與 GPL-3.0-or-later）**：**不可未經原著作權人同意而直接將原檔改授權為 AGPL-3.0-only**。依據 GPLv3 §13 與 AGPLv3 §13，只能將 GPL-3.0 模組與 AGPL-3.0 模組「組合連結」於同一個程式內，原始 GPL-3.0 檔案仍須維持 GPL-3.0 標示，整體組合後的網路互動條款則受 AGPL-3.0 §13 規範。換言之，**若要「fork 骨架並整份改為純 AGPL-3.0-only」，GPL-3.0 專案並不符合條件**。

### 3.2 前 5 名總覽比較表

| # | 專案名稱與連結 | 星數 | 最後 Commit | 實查授權（非 source-available） | 技術棧 | 能否直接 Fork 當 AGPL 骨架 | 能否借用模組或架構 |
|---|---|---:|---|---|---|---|---|
| 1 | [fishjar/kiss-translator](https://github.com/fishjar/kiss-translator) | 13,530 | **2026-11-25** | **GPL-3.0**（標準 GPLv3 全文） | React 18 + MUI v5 + CRA (`react-scripts` 5 + `react-app-rewired`) + Vite（local-ai）+ JS/TS 混寫 | **否**（授權無法純改 AGPL，且舊 CRA 棧＋肥大依賴） | **低**（僅參考 WebDAV 同步與站點規則概念） |
| 2 | [FluentRead/FluentRead](https://github.com/FluentRead/FluentRead) | 11,170 | **2026-11-24** | **GPL-3.0**（標準 GPLv3 全文） | **WXT 0.21.5 + Vue 3 + Element Plus** + TS + Dexie + kuromoji + OCR/TTS | **否**（Vue 3 棧不同、45+ 龐大依賴、GPL-3.0 限制） | **低～中**（參考 open Shadow DOM 遍歷思維） |
| 3 | [mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog) | 10,539 | **2026-11-25** | **GPL-3.0**（標準 GPLv3 全文） | **WXT 0.21.5 + React 19 + Tailwind 4 + shadcn** + Dexie + Jotai + PostHog + Better Auth | **否**（內建遙測與雲端帳號違鐵律 1/2、React 進網頁違鐵律 3、無 PDF、GPL-3.0） | **中**（參考 WXT 0.21 + React 19 + Dexie + FSRS 單字本架構） |
| 4 | [yomidevs/yomitan](https://github.com/yomidevs/yomitan) | 2,958 | **2026-11-12** | **GPL-3.0-or-later**（標準 GPLv3 全文） | **零 UI 框架**（純 JS + JSDoc 型別檢查）+ Handlebars + esbuild + Dexie + `hangul-js` | **否**（無整頁雙語／YouTube／PDF、非 WXT、GPL-3.0 限制） | **高（設計思維）**（零 DOM 修改游標掃詞與規則詞形還原為業界標竿，建議自行以 AGPL 重寫） |
| 5 | [xiao-zaiyi/illa-helper](https://github.com/xiao-zaiyi/illa-helper) | 2,917 | **2026-07-02** | **MIT**（前五唯一可直接改 AGPL） | **WXT 0.20.6 + Vue 3 + Tailwind 4 + Reka UI** + TS + Gemini SDK | **否**（雖為 MIT，但 Vue 3＋LLM 行內替換改 DOM 違鐵律 4＋無雙語／YT／PDF） | **低**（僅參考 WXT 專案配置） |

### 3.3 各專案深度分析

1. **Kiss Translator（[fishjar/kiss-translator](https://github.com/fishjar/kiss-translator)）**
   - **架構與功能**：老牌沉浸式翻譯開源替代品，涵蓋網頁雙語、YouTube 字幕、PDF/EPUB、劃詞查詞（Collins 字典＋生詞本）、Chrome Built-in AI 與 WebDAV 跨裝置同步。
   - **維護活躍度**：極活躍（最後 commit 2026-11-25，13,530★）。
   - **不推薦當骨架的原因**：建置鏈仍停留在已停止維護的 Create React App（`react-scripts` 5.0.1 + `react-app-rewired`）；引入極重依賴（`@huggingface/transformers`、`@paddleocr/paddleocr-js`、`@wllama/wllama`、MUI v5）；在網頁端渲染 MUI 元件違反鐵律 3；授權為 GPL-3.0 無法直接改授權為 AGPL-3.0-only。

2. **FluentRead 流畅阅读（[FluentRead/FluentRead](https://github.com/FluentRead/FluentRead)）**
   - **架構與功能**：功能包山包海的開源翻譯與閱讀器，具雙語翻譯、AI 閱讀卡片、生詞本、學習中心、PDF/EPUB/DOCX 與 YouTube/Bilibili 字幕，同時打包瀏覽器擴充、Obsidian、Zotero 與 Userscript。
   - **維護活躍度**：極活躍（最後 commit 2026-11-24，11,170★）。
   - **不推薦當骨架的原因**：前端採 Vue 3 + Element Plus（與 Fogone 既有的 React＋網頁端零框架路線衝突）；執行期依賴高達 45 個以上重型套件（內含 `@faanau/kuromoji`、`kuroshiro`、PaddleOCR、Tesseract、Kokoro TTS、QuickJS），與 Fogone 輕量零遙測路線背道而馳；GPL-3.0 授權限制。

3. **Read Frog 陪讀蛙（[mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog)）**
   - **架構與功能**：現代化的雙語閱讀＋語言學習擴充，與 Fogone 新定位最接近——具雙語翻譯、YouTube/Netflix 雙語字幕、Shadow Root 劃詞工具列、Notebase 生詞本與 FSRS 閃卡複習。
   - **維護活躍度**：極活躍（最後 commit 2026-11-25，10,539★）。
   - **不推薦當骨架的原因**：
     - 直接違反鐵律 1 與 2：內建 `posthog-js` 遙測、`better-auth` 雲端帳號系統與 `@read-frog/api-contract` 後端依賴，並塞入 22 個 `@ai-sdk/*` 雲端模型 SDK。
     - 違反鐵律 3：在網頁 content script 掛載 React UI（曾引發真實效能退化 issue #1093 Speedometer 3.1 降分）。
     - 缺少 PDF 文字層重排檢視器；GPL-3.0 授權無法直接改授權為 AGPL-3.0-only。
   - **可借鏡之處**：證實 **WXT 0.21.5 + React 19 + Dexie + FSRS** 在現代 MV3 學習型擴充上的可行性。

4. **Yomitan（[yomidevs/yomitan](https://github.com/yomidevs/yomitan)）**
   - **架構與功能**：開源外語查詞彈窗的黃金標準（原 Yomichan 社群接手版），支援 20+ 語言離線 `.zip` 字典匯入 IndexedDB、不修改原網頁 DOM 的游標掃詞引擎（`DOMTextScanner` + `TextSourceGenerator`）、多語詞形還原規則與 AnkiConnect 串接。
   - **維護活躍度**：穩定活躍（最後 commit 2026-11-12，2,958★）。
   - **不推薦當完整骨架、但極具架構參考價值的原因**：沒有整頁雙語翻譯、沒有 YouTube 雙語字幕、沒有 PDF 重排，也非 WXT 框架；且為 GPL-3.0-or-later 無法直接改 AGPL-3.0-only。但其**「零 DOM 修改游標取詞」**與**「輕量規則變形還原」**完全契合 Fogone 鐵律 3 與鐵律 4，值得參考其演算法思路以純 TypeScript 自行重寫。

5. **Illa Helper 浸入式學語言助手（[xiao-zaiyi/illa-helper](https://github.com/xiao-zaiyi/illa-helper)）**
   - **架構與功能**：主打「i+1 可理解輸入」的詞彙學習擴充，用 LLM 挑選網頁中的單字直接行內替換或高亮標記，配 WXT + Vue 3 介面。
   - **維護活躍度**：中（最後 commit 2026-07-02，2,917★）。
   - **不推薦當骨架的原因**：雖然是前五名中**唯一 MIT 授權**（可直接 fork 改 AGPL-3.0-only），但其技術棧為 Vue 3、無整頁雙語翻譯／YouTube／PDF、以雲端 LLM 為前提，且行內單字替換會直接修改原文 DOM 文字節點（違反鐵律 4），改造量比從 Fogone `legacy/` 重建還要大得多。

> **額外查核提醒（授權地雷案例）**：搜尋過程中另有開源翻譯＋個人生詞本擴充 [translate-tools/linguist](https://github.com/translate-tools/linguist)（1,092★，最後 commit 2026-09-04，React 17 + Webpack 5 + Bergamot 離線翻譯），經查其**根目錄 `LICENSE` 為 `BSD-3-Clause`，但 `package.json` 卻寫 `GPL-3.0`**，存在明顯授權標示衝突，且無雙語整頁／PDF 功能，故不納入前五亦不建議借用。

---

## 4. 單字層級（原文標記生詞與點擊查詞）

### 4.1 舊專案與開源候選的做法比較

| 方案／來源 | 代表專案 | 實作機制 | 視覺標記生詞 | 點擊／查詞體驗 | 對鐵律 3＆4（零框架／零 DOM 破壞）的相容性 |
|---|---|---|---|---|---|
| **段落級附加** | 舊專案 Fogone (`legacy/`) | 僅在翻譯單位尾端追加 `<x-yi>`，完全不處理單字層級。 | 無 | 無 | 完全合規，但缺少單字學習功能。 |
| **DOM 拆節點包裹 (`<span>`/`<mark>`)** | `illa-helper`、傳統高亮擴充 | 用 `Range` 或 `TreeWalker` 把原本的 `TextNode` 拆碎並插入 `<span class="highlight">`／`<mark>` 綁 `click` 事件。 | 支援（任意 CSS） | 直接點擊 `<span>` | **違反鐵律 4**。會破壞 React/Vue 虛擬 DOM（常見 `NotFoundError: removeChild` 崩潰）、觸發大規模版面重排（Reflow）、打斷原本 CSS 選擇器與選字複製。 |
| **僅劃詞選取工具列** | `read-frog`、`FluentRead`、`kiss-translator` | 監聽 `mouseup` + `window.getSelection()`，在選取處彈出 Shadow DOM 浮動按鈕或卡片。 | **不支援**（原文上看不出哪些字是生詞） | 需拖曳或連點選字，閱讀流會被打斷 | 零 DOM 修改，合規；但無法達成「在原文標出生詞」的需求。 |
| **游標命中掃詞（Point Scanning）** | `yomitan`（`DOMTextScanner` + `TextSourceGenerator`） | 透過 `document.caretPositionFromPoint` / `caretRangeFromPoint` 由滑鼠座標反推當下字元與周邊 `TextNode`，跨行內標籤／ruby／Shadow DOM 讀出詞彙並彈查詞框。 | **不支援**（不主動標亮生詞） | 按修飾鍵懸停或點一下即可查任何字，極順暢 | **完全合規**（零 DOM 修改、零重排）。 |
| **CSS Custom Highlight API ＋ 游標命中混合方案** | **本報告推薦** | **標記層**：`StaticRange` + `new Highlight()` + `CSS.highlights.set('yi-vocab', ...)` + `::highlight(yi-vocab)` 畫底線／底色。<br>**點擊層**：`CSS.highlights.highlightsFromPoint(x, y)`（Chrome 140+）命中已標記生詞；未標記字以 `caretPositionFromPoint` + `Intl.Segmenter` 取詞。 | **支援**（純繪製層底色／底線，零 DOM 節點） | 點已標記生詞直接彈卡片；查任意生字採輕量手勢（如 `Alt+點擊` 或選字）不劫持連結 | **100% 符合鐵律 3＆4**（不改動任何原網頁文字節點、不新增行內節點、一鍵 `CSS.highlights.delete()` 瞬間清空）。 |

### 4.2 推薦做法與實作細節

推薦採用 **「CSS Custom Highlight API（生詞視覺標記）＋ Yomitan 式零修改游標取詞（點擊／查詞）＋ 單一純 DOM Shadow Host 查詞卡片」** 的混合架構。由於 Fogone 的執行門檻本就是 **Chrome 138+**（Chrome 105 即支援 CSS Custom Highlight API；Chrome 140 新增 `highlightsFromPoint()`），幾乎沒有舊版瀏覽器相容包袱。

具體分層設計如下：

1. **生詞視覺標記（零 DOM 修改）**
   - 當段落進入可視區（沿用 `scheduler.ts` 的 `IntersectionObserver` 視窗，或使用者新增／移除生詞時），在該段落的 `TextNode` 中以 `Intl.Segmenter` 掃出單字邊界並比對本機單字本集合（以原形 lemma 查表）。
   - 每個命中的生詞建立一個 `StaticRange`（不隨 DOM 變更自動重算，效能遠優於 live `Range`）加入 `Highlight` 物件，註冊為 `CSS.highlights.set('yi-vocab-learning', hl)`（可依熟悉度分不同名稱如 `yi-vocab-new`、`yi-vocab-familiar`）。
   - 透過 `document.adoptedStyleSheets` 注入 `::highlight(yi-vocab-learning)` 樣式（僅限繪製屬性：`background-color`、`text-decoration`、`color`、`text-shadow`——這反而成為防呆機制，結構上保證不會觸發版面重排）。
   - 關閉功能或切換頁面時，呼叫 `CSS.highlights.delete(...)` 即可零成本還原。

2. **點擊與命中偵測（守住鐵律 4「不攔事件、不碰輸入框」）**
   - **已標記生詞**：監聽 passive `click`（或 `pointerup`，避開正在拖曳選字 `getSelection().toString().length > 0`、避開 `<a>`／`<button>`／`<input>`／`[contenteditable]`）：
     - 在 Chrome 140+ 直接呼叫 `CSS.highlights.highlightsFromPoint(e.clientX, e.clientY)` 取得命中的 `StaticRange` 與對應單字；若在 Chrome 138–139 則自動退回 `caretPositionFromPoint` 反查是否落在已知 `StaticRange` 範圍內。
     - 點中已標記生詞（且非超連結／輸入框）時，直接顯示該生詞卡片（釋義、例句、標為已掌握／移出單字本）。
   - **原文任意未標記單字**：為避免覆蓋網站原本的點擊互動（例如點擊展開文章、選字複製），採**明確且不衝突的手勢**：
     - 方式 A：`Alt + 點擊`（或自訂修飾鍵）直接由 `caretPositionFromPoint` + `Intl.Segmenter` 定位游標下的單字並彈出查詞／加入生詞本卡片（借鏡 Yomitan 體驗）。
     - 方式 B：使用者雙擊／拖曳選取單字時，於選區旁顯示極小「查詞／加生詞」浮動按鈕（不主動搶焦點）。
   - **YouTube 字幕與 PDF 檢視器**：
     - PDF 檢視器正文 `<p>` 是 Fogone 自有頁面，可直接套用同一套 CSS Custom Highlight API＋點擊查詞。
     - YouTube 雙語字幕若未來要支援點選原文字幕單字，因原生字幕容器受鐵律 4 保護且覆蓋層採 `pointer-events: none`，第一階段先維持字幕純翻譯，待核心穩定後再於覆蓋層提供可選的互動模式。

3. **查詞與生詞卡片（守住鐵律 3）**
   - 在 `document.documentElement` 下僅掛載**唯一一個**自訂元素 `<x-yi-card>` 搭配 `attachShadow({ mode: 'open' })`，內部採純 DOM／TypeScript 渲染（不帶 React）。
   - 絕對不對頁面既有元素或 fullscreen 容器執行 `moveBefore`（避開 `kiss-translator` #1135 的 Chromium 崩潰坑）。

4. **已知限制與應對**
   - `CSS.highlights` 是文件級全域 registry，會與目標網站共用 → 全部命名加 `yi-` 前綴避免衝突。
   - 若頁內有 open Shadow DOM，該 `shadowRoot` 內部的文字無法吃到外層 `document` 的 `::highlight()` 樣式 → 遍歷 open `shadowRoot` 時同步將同一份輕量 `CSSStyleSheet` 加入 `shadowRoot.adoptedStyleSheets`。
   - 虛擬化或動態修改文字節點的網站可能讓舊 `StaticRange` 失效 → 配合 `MutationObserver` 與可視區重掃機制更新該段落對應的 `StaticRange`。

---

## 5. 資料層（本機儲存與跨裝置同步評估）

### 5.1 本機儲存選項與官方容量上限

以下配額均依 Chrome Developers 官方文件（`chrome.storage` 與 Storage & Quota 文件）查證：

| 維度 | `chrome.storage.local` | `IndexedDB`（擴充 origin） |
|---|---|---|
| **預設容量上限** | **10 MB**（`QUOTA_BYTES = 10,485,760` bytes；依各 key 長度＋JSON 序列化值長度加總計算）。 | 單一 origin 最高可用 **硬碟總容量的 60%**（全瀏覽器共用池最高 80%）；實務上可輕鬆存數百 MB 至數 GB。 |
| **突破上限方式** | 在 `manifest.json` 申請 `unlimitedStorage` 權限即可解除 10 MB 限制。 | 申請 `unlimitedStorage` 權限（或呼叫 `navigator.storage.persist()`）可免於配額與系統空間不足時的驅逐。 |
| **所需權限** | 須在 `manifest.json` 新增 `"storage"` 權限（**不會**觸發安裝時額外警示視窗）。 | **不需任何額外 manifest 權限**（原生 Web API；僅解除驅逐才需 `unlimitedStorage`）。 |
| **資料模型與查詢能力** | 純 Key-Value（JSON 物件）。沒有次級索引、無法做範圍查詢（例如「找出今日到期需複習的 20 個單字」必須全表讀出再過濾）。 | 完整物件資料庫，支援**多欄位索引、複合索引、範圍查詢與交易**（適合單字原形查詢、SRS 到期排程、例句紀錄、未來離線字典）。 |
| **存取作用域（關鍵陷阱）** | Content script、Popup、Viewer、Background Service Worker 皆可直接讀寫**同一份**擴充資料，並有 `chrome.storage.onChanged` 即時廣播變更。 | **Content script 呼叫 `indexedDB` 會連到「該網站自己的 origin」，而非擴充的資料庫！** 因此網頁端必須透過 `chrome.runtime.sendMessage` 委由 Background Service Worker 讀寫擴充的 IndexedDB。 |
| **清除瀏覽資料影響** | 不受使用者「清除瀏覽資料」影響，僅移除擴充時刪除。 | 擴充專屬 origin 不受一般網站清除瀏覽資料影響，僅移除擴充時刪除。 |
| **推薦封裝套件** | 直接呼叫原生 API（或 WXT 內建 `wxt/utils/storage`）。 | `idb` v8.0.4（**ISC**，產物 **11.6 KB**）極輕量零黑箱；或 `dexie` v4.4.7（**Apache-2.0**，`dexie.min.mjs` **87.5 KB**）適合複雜索引與 schema 升級。**僅跑在 background／自有頁面，絕不進 content script（守鐵律 3）。** |

**本機儲存推薦架構（雙層分工）**：
- **`IndexedDB`（主力資料庫，由 Background Service Worker 管理）**：儲存完整單字本（原形、變形、釋義、出處例句與 URL、新增時間、熟悉度、SRS 複習進度與測驗紀錄），以及未來若擴充的離線字典或持久翻譯快取。
- **`chrome.storage.local`（輕量設定＋快速高亮索引快取）**：儲存使用者偏好設定（開關狀態、標記樣式、目標語言等），以及一份極精簡的「已知生詞原形集合摘要」（如數千個單字僅約數十 KB），讓 content script 頁面啟動時可一次讀出並即時監聽 `onChanged` 更新 CSS Highlight，減少跨程序訊息往返延遲。
- **對外承諾同步更新提醒**：舊版 `legacy/PRIVACY.md` 明寫「不使用 `chrome.storage` 或 `IndexedDB`、`permissions` 為空陣列」。新專案啟用本機單字本後，上架前**必須更新 `PRIVACY.md` 與商店頁文案**，明確說明：新增 `"storage"` 權限僅用於本機儲存使用者設定與單字本，所有資料仍 100% 留在使用者電腦內、絕不上傳。

### 5.2 Mac 與 Windows 跨裝置同步：要不要做？代價是什麼？

前提約束：**同步絕對不可以經過 Aya 的伺服器**（守鐵律 1）。在此前提下有三條路徑：

| 方案 | 機制 | 優點 | 代價與限制 |
|---|---|---|---|
| **方案 A：MVP 不做自動同步，提供「JSON 備份匯出／匯入（＋Anki CSV 匯出）」** | 使用者需要搬移或雙機同步時，匯出單一 JSON 檔（可存到使用者自己的 iCloud Drive／OneDrive／Google Drive／Syncthing 資料夾）在另一台匯入（做 ID/原形去重合併）。 | 零額外權限、零帳號綁定、零衝突演算法複雜度、100% 符合極簡隱私定位；實作成本僅 1～2 天。 | 非即時自動同步；使用者在 Mac 與 Windows 之間切換需手動點匯出／匯入（或自行透過 File System Access API 綁定本機雲端同步資料夾）。 |
| **方案 B：`chrome.storage.sync`（Chrome 內建 Google 帳號同步）** | 透過使用者既有的 Chrome 同步通道自動同步設定與精簡單字清單。 | 免架伺服器、免額外帳號登入、Mac ↔ Windows 只要登入同一個 Chrome Profile 即自動同步。 | **容量與寫入極度受限**（官方配額）：總容量上限僅 **100 KB**（`QUOTA_BYTES = 102,400` bytes）、單一項目上限 **8 KB**（`QUOTA_BYTES_PER_ITEM = 8,192`）、最多 **512 個項目**（`MAX_ITEMS`）、寫入頻率上限 **120 次／分鐘、1,800 次／小時**。<br>**實算上限**：若只存精簡欄位（原形＋狀態＋SRS 數值，不含長例句與網頁 URL，每字約 150～250 bytes），整份單字本最多只能塞 **300～500 個字**（即便分塊壓縮也約僅 1,000～1,500 字，且丟失例句）。此外會將單字本資料託管至 Google 同步雲端，須在隱私權政策另作揭露。 |
| **方案 C：BYO 儲存後端（WebDAV／GitHub Gist／Google Drive AppData）** | 使用者自行填寫 WebDAV（如堅果雲、Nextcloud、NAS）或授權個人 GitHub／Google Drive 存放同步檔（同 `kiss-translator` 的 WebDAV 做法）。 | 不經 Aya 伺服器、無 100 KB 容量限制、可完整同步例句與複習歷史。 | **工程與使用門檻高**：須處理跨裝置雙向衝突合併（Last-Write-Wins 或變更日誌／墓碑刪除機制）、憑證／Token 本機安全存放、額外網路錯誤與重試狀態；且一般非技術使用者沒有 WebDAV，設定門檻偏高。 |

**同步策略建議**：
- **重建第一版（MVP）建議「先不做自動雲端同步」**，先做好本機 **IndexedDB 單字本＋一鍵 JSON 匯出／合併匯入（附合併去重規則，避免覆蓋另一台的新進度）**。理由：先把「翻譯＋單字標記＋單字本＋測驗」核心體驗打磨到上架標準，不要讓分散式同步衝突與配額限制拖慢重建進度。
- **若 Aya 自己日常強烈需要 Mac ↔ Windows 自動同步**：
  - 短期最省力且不綁雲端帳號的擴充路線，是在第二階段加入**「選用式 WebDAV 同步」**（或「綁定使用者本機同步資料夾的檔案同步」），完全預設關閉、明確標示資料僅流向使用者自選位置。
  - **不建議**把完整單字本硬塞進 `chrome.storage.sync`（100 KB 上限對真正每天閱讀的外語學習者很快就會爆滿）；`chrome.storage.sync` 至多只適合作為「偏好設定」的同步通道。

---

## 6. 斷詞（英／日／韓方案、實查體積與首發語言建議）

單字層級標記與單字本面臨兩個核心問題：**「切詞（Tokenization）」**（把句子切成獨立單字邊界）與**「詞形還原（Lemmatization / Deinflection）」**（讓文中的 `running`／`ate`、`食べられなかった`、`먹었습니다` 能對應回單字本裡的原型 `run`／`eat`、`食べる`、`먹다`）。

### 6.1 瀏覽器內建 `Intl.Segmenter` 實測（增加體積：0 KB）

Chrome 87+ 內建 `Intl.Segmenter`（底層使用 Chromium 內附 ICU 規則與字典，對擴充體積增加 **0 KB**）。於本機 Node.js v24（同源 ICU 資料）實測 `new Intl.Segmenter(lang, { granularity: 'word' })` 並過濾 `isWordLike` 的實際輸出如下：

| 語言 | 測試句 | `Intl.Segmenter` 實測切分結果 | 評析 |
|---|---|---|---|
| **英文 (`en`)** | `I'm reading don't-stop state-of-the-art papers, running quickly.` | `I'm` \| `reading` \| `don't` \| `stop` \| `state` \| `of` \| `the` \| `art` \| `papers` \| `running` \| `quickly` | **邊界乾淨可靠**，正確保留縮寫撇號、拆分連字號與標點；僅缺詞形還原（`papers`→`paper`、`running`→`run`），極易用極輕量規則補足。 |
| **日文 (`ja`)** | `食べられなかった美味しいケーキを友達と食べた。` | `食` \| `べら` \| `れ` \| `なか` \| `っ` \| `た` \| `美味しい` \| `ケーキ` \| `を` \| `友達` \| `と` \| `食` \| `べた` | **活用動詞被切碎**（`食べられなかった` 拆成 6 塊、`食べた` 拆成 `食`+`べた`），且無詞性、無原型 `食べる`、無假名讀音。只靠 `Intl.Segmenter` 無法做好日文生詞標記。 |
| **韓文 (`ko`)** | `학교에서 친구들과 맛있는 밥을 먹었습니다.` | `학교에서` \| `친구들과` \| `맛있는` \| `밥을` \| `먹었습니다` | **僅依空白切到「語節（어절）」層級**，助詞（`에서`、`들과`、`을`）與敬語時態詞尾（`-었습니다`）全部黏在詞幹上，無法直接比對原型單字本（`학교`、`친구`、`밥`、`먹다`）。 |

### 6.2 英／日／韓開源斷詞與詞形還原函式庫體積實查

以下所有版本、授權與體積均於 **2026-11-25** 直接向 `registry.npmjs.org`、`unpkg.com` 與 GitHub API 查證（絕無估算）：

#### 英文（English）

| 方案／開源套件 | 版本與授權 | 讓擴充增加的實際體積 | 能力與限制 |
|---|---|---|---|
| **瀏覽器內建 `Intl.Segmenter('en')`** | 內建標準 API | **0 KB** | 精準切詞；不提供原型還原。 |
| **自寫規則式英文詞形還原**（參考 Yomitan `english-transforms.js` 思維） | 自寫（AGPL-3.0-only） | 參考基準：Yomitan `ext/js/language/en/` 原始 JS 共 **11.3 KB**（壓縮後僅數 KB） | 規則涵蓋複數、過去式、進行式、比較級與常見不規則動詞表（約數百條），零外部依賴且速度極快。 |
| `compromise` | v14.20.0 / **MIT** | 完整瀏覽器 bundle `compromise.js`：**333.5 KB**（分拆：`compromise-one.mjs` **89.6 KB**、`compromise-two.mjs` **258.8 KB**；npm unpacked 2.74 MB） | 附輕量詞性標註與詞形還原，但對單純單字標記偏重。 |
| `wink-lemmatizer` | v3.0.4 / **MIT** | **隱藏體積地雷**：主檔僅 **6.5 KB**（npm 35.4 KB），但強制依賴 `wink-lexicon` v2.2.0（npm unpacked **11.99 MB**）＋ `wink-porter2-stemmer` v2.0.1（26 KB） | **切勿直接引入**——光詞彙表就讓擴充暴漲約 12 MB。 |

#### 日文（Japanese）

| 方案／開源套件 | 版本與授權 | 讓擴充增加的實際體積 | 能力與限制 |
|---|---|---|---|
| `Intl.Segmenter('ja')` | 內建標準 API | **0 KB** | 如 6.1 實測，動詞活用會被切碎且無原型／讀音，無法獨立支撐生詞標記。 |
| `tiny-segmenter` | v0.2.0 / 類 BSD 客製條款 | 未壓縮 JS **21.1 KB** | 僅做表層切詞，準確率低於 MeCab，且無詞性、原型與讀音。 |
| `budoux`（Google） | v0.10.4 / **Apache-2.0** | `budoux-ja.min.js`：**33.0 KB**（`ja.js` 文節模型 22.9 KB；`ja_word.js` 單字模型 52.9 KB；全套件 unpacked 2.69 MB） | 設計初衷是「文節斷行（Line breaking）」，非形態素分析，不提供詞形還原或讀音。 |
| `kuromoji` / `@faanau/kuromoji` | `kuromoji` v0.1.2 / `@faanau/kuromoji` v0.2.1（**Apache-2.0**） | IPADIC 12 個 `.dat.gz` 字典檔合計 **16.97 MB**（17,791,956 bytes；`@faanau/kuromoji` unpacked **17.06 MB**；原版 `kuromoji` 含測試源碼 unpacked 39.35 MB） | 完整 MeCab IPADIC 切詞、詞性、原型與讀音；但擴充包體直接暴增 ~17 MB，載入記憶體約百 MB 級（且原版 `kuromoji` 多年未維護，社群改用 fork 如 `@faanau/kuromoji`）。 |
| `lindera-wasm-web-ipadic`（Rust/WASM MeCab） | v2.0.0 / **MIT**（註：`lindera-wasm-ipadic` v2.1.0 為 17.21 MB unpacked） | `lindera_wasm_bg.wasm` **12.46 MB** ＋ JS glue **27.1 KB**（unpacked 共 **12.50 MB**） | Rust 編譯 WASM，速度優於純 JS `kuromoji` 且 MIT 相容，但內嵌 IPADIC 仍讓擴充增加 **12.5 MB**。 |
| **Yomitan 規則逆變形＋可選離線字典**（架構模式） | 參考思維（自行重寫 AGPL） | Yomitan `ext/js/language/ja/` 規則檔合計 **144.9 KB**（`japanese-transforms.js` 97.9 KB）；**但必須搭配 IndexedDB 內的使用者匯入字典（如 JMdict）做前綴比對** | 擴充本體極小，但使用者首次使用日文須另行下載或匯入大型字典檔，入門門檻高於英文。 |

#### 韓文（Korean）

| 方案／開源套件 | 版本與授權 | 讓擴充增加的實際體積 | 能力與限制 |
|---|---|---|---|
| `Intl.Segmenter('ko')` | 內建標準 API | **0 KB** | 如 6.1 實測，僅能按空白切出語節，無法剝離助詞與活用詞尾。 |
| `hangul-js` | v0.2.6 / **MIT** | npm unpacked **98.7 KB** | 僅做韓文字母（Jamo）拆解與組合，**不是斷詞器**，必須搭配複雜逆變形規則與字典。 |
| `lindera-wasm-web-ko-dic`（Rust/WASM MeCab-ko） | v2.0.0 / **MIT**（註：`lindera-wasm-ko-dic` v2.1.0 為 36.12 MB unpacked） | `lindera_wasm_bg.wasm` **22.07 MB** ＋ JS glue **27.1 KB**（unpacked 共 **22.10 MB**） | 完整韓文形態素分析與詞性還原，但擴充體積暴增 **22.1 MB**（v2.1 達 36.1 MB）。 |
| `kiwi-nlp`（`bab2min/Kiwi`） | v0.25.0 / **Apache-2.0** | WASM 執行檔 `kiwi-wasm.wasm` **5.38 MB** ＋ JS **105 KB** ＋ 必備外部語言模型 `kiwi_model_v0.25.0_base.tgz` **83.89 MB**（壓縮後）→ 合計約 **89.4 MB** | 韓文形態素準確率極高，但總體積近 **90 MB**，完全不適合直接打包進 Chrome 擴充。 |
| `open-korean-text` | — | **查不到**官方維護的瀏覽器 JS/WASM npm 套件（原專案為 Scala/JVM 函式庫） | 無法直接用於瀏覽器擴充。 |
| **Yomitan 規則逆變形＋字典**（架構模式） | 參考思維 | Yomitan `ext/js/language/ko/` 規則檔 **269.2 KB** ＋ `hangul-js` **98.7 KB**，且仍須搭配韓文字典進 IndexedDB | 規則複雜度與字典門檻皆為三語最高。 |

### 6.3 第一個支援的外語建議：**英文（`en`）**

建議新專案第一個支援生詞標記與單字本學習的外語為 **英文（`en`）**，理由如下：

1. **擴充體積近乎零負擔（0 KB＋約 10 KB）**：英文單字靠 Chrome 內建 `Intl.Segmenter('en')`（0 KB）加上約 10～15 KB 自寫規則式詞形還原＋常見不規則動詞表即可達到高準確率，不需打包 12.5～89 MB 的日韓字典模型，完美延續舊專案 `content.js` ~17 KB 的輕快優勢。
2. **Chrome 內建 `Translator` API 最穩定**：舊專案實測紀錄（`legacy/BACKLOG.md` #8、#14）已證實 `en→zh-Hant` 在網頁與擴充環境皆穩定為 `available`；反觀 `ja→zh-Hant` 存在網頁環境間歇性 `downloadable` 偽陰性，而 `ko→zh-Hant` 在舊版甚至尚未經過實戰驗證。
3. **驗證素材與日常閱讀場景最廣**：技術文件（MDN）、新聞（BBC）、學術 PDF（arXiv 雙欄論文、白皮書）與 YouTube 英文講座在舊專案已有完整 E2E 驗證腳本與無授權爭議的測試 fixture。
4. **後續語言擴充路線清晰**：
   - **第二語言：日文（`ja`）**——舊專案翻譯管線與 `KANA` 偵測皆已支援日文雙語翻譯；等英文的單字標記＋單字本＋測驗架構跑穩後，再針對日文評估「按需下載詞典／WASM 模組至 IndexedDB（不塞進預設安裝包）」或「Yomitan 式可選字典匯入」，避免讓不學日文的使用者被迫下載 12.5～17 MB。
   - **第三語言：韓文（`ko`）**——形態素與字典體積最大（22～89 MB）且 Chrome 本地 `ko→zh-Hant` 尚未實戰驗證，排在日文之後最合理。

---

## 7. 結論與建議

### 7.1 骨架選擇：**不 Fork 任何第三方開源專案，以 Fogone `legacy/` 核心重建自有骨架**

不建議 fork 第 3 節任一開源專案作為骨架，理由非常明確：

1. **授權硬傷**：前五名中有四個（`kiss-translator`、`FluentRead`、`read-frog`、`yomitan`）為 **GPL-3.0**，無法未經原著作權人同意而將 fork 下來的檔案直接改授權為 **AGPL-3.0-only**；唯一 MIT 授權的 `illa-helper` 採用 Vue 3、LLM 行內替換改寫 DOM 且無雙語／YouTube／PDF，完全不匹配。
2. **架構與鐵律衝突**：三個主流雙語翻譯專案（`kiss-translator`、`FluentRead`、`read-frog`）皆不同程度違反 Fogone 架構鐵律——內建遙測（PostHog）、雲端帳號驗證（Better Auth）、在目標網頁掛載 React/Vue/MUI 框架、或打包數十 MB 的 OCR／TTS／LLM 依賴。清理這些歷史債的成本遠高於從零建立。
3. **舊專案本身就是最精良的自有骨架**：`legacy/` 已經以不到 2,000 行純 TypeScript（零網頁端框架依賴）解決了本專案最難的三座大山——Chrome 138+ 本地 `Translator` API 整合、YouTube 滾動 ASR 字幕穩定化、以及 2 欄 PDF 文字層重排＋SSRF 防線，並具備真 Chrome CDP 驗證迴圈。
4. **正確的開源借鏡方式**：在**自有乾淨 AGPL-3.0-only 程式碼庫**中，直接搬移 `legacy/lib/` 成熟模組（見第 1 節），並吸收業界最佳設計思維以純 TypeScript 自行重寫（借鏡 Yomitan 的零 DOM 修改游標取詞與規則詞形還原、搭配 Chrome 原生 CSS Custom Highlight API、未來複習階段引入 MIT 授權的 `ts-fsrs`）。

### 7.2 技術棧評估：**建議沿用 WXT + TypeScript + React，並升版與明確分層**

| 層級 | 建議技術棧 | 沿用／調整理由 |
|---|---|---|
| **擴充建置框架** | **WXT 0.21.5**（MIT，從舊版 0.20 升級） | 持續活躍維護（`read-frog`、`FluentRead` 皆已用 0.21.5）、原生 MV3 支援、跨平台開發體驗好，且不強迫 content script 帶入任何前端框架。 |
| **語言與靜態檢查** | **TypeScript 5.x**（嚴格模式） | 沿用；對 Chrome 內建 AI、CSS Custom Highlight API 與 IndexedDB schema 提供編譯期防護。 |
| **網頁注入層（`content.ts`、`lib/`）** | **零框架純 DOM／純 TypeScript**（嚴守鐵律 3） | 維持 `content.js` 極輕量（舊版約 17 KB）與零 Speedometer 效能拖累；生詞標記採 CSS Custom Highlight API，查詞卡片採單一 `<x-yi-card>` Shadow DOM 純 DOM 渲染。 |
| **擴充自有頁面（`popup`、`viewer`、新 `vocab`/測驗頁）** | **React 19**（沿用） | 舊專案已有經驗且開發單字本列表、篩選、小測驗互動介面效率高；依鐵律 3 嚴格限定僅出現在 `entrypoints/` 自有頁面，絕不進入 `lib/` 或 content script。 |
| **本機資料層** | **IndexedDB（`idb` v8.0.4 ISC 或 `dexie` v4.4.7 Apache-2.0）**＋ **`chrome.storage.local`** | Background Service Worker 集中管理擴充 origin 的 IndexedDB（避免 content script 誤寫網站 origin）；`chrome.storage.local` 放輕量設定與生詞原形快取索引。 |
| **測試與真實環境驗證** | **Vitest + Playwright CDP（共用 `scripts/chrome.mjs`）** | 沿用舊專案最核心的「真 Chrome 驗證迴圈」與 fail-hard 驗收閘門，新增單字斷詞單元測試與生詞標記 E2E 驗證。 |
| **預設翻譯引擎** | **Chrome 內建 `Translator` API（L0 本機引擎）** | 維持不變——文字不出裝置是 Fogone 最核心的隱私定位與差異化優勢。 |

### 7.3 第一個支援的外語：**建議英文（`en`）**

- 單字層級標記＋單字本＋記憶測驗的第一個外語建議鎖定 **英文（`en`）**：`Intl.Segmenter('en')`（0 KB）＋自寫極簡詞形還原規則（約 10～15 KB），零大型字典體積負擔，且 Chrome 內建 `en→zh-Hant` 最穩定。
- **日文（`ja`）** 維持雙語翻譯能力（舊管線已具備），單字層級學習排在**第二階段**（搭配按需下載詞典／WASM，避免膨脹主安裝包）；**韓文（`ko`）** 排在**第三階段**。

### 7.4 上架前必做配套提醒

- **同步更新 `PRIVACY.md` 與商店頁文案**：因新增本機單字本需啟用 IndexedDB 與 `chrome.storage.local`（manifest 新增 `"storage"` 權限），上架 Chrome Web Store 前必須同步修訂 `PRIVACY.md`，確保與舊有對外承諾網址（`https://github.com/yeah17h/fogone/blob/main/PRIVACY.md`）一致且字字屬實。
- **正式視覺識別（BACKLOG #12）**：重建後上架前替換 16px 糊掉的佔位圖示，並重產符合無 ShareAlike 規範的 6 張商店素材圖。

---

> ### 最終決策權（由 Aya 拍板決定）
>
> 以上均為基於實查數據與 `legacy/` 實戰經驗提出的技術建議，**所有最終方向一律由 Aya 決定**。進入下一階段（架構設計／實作）前，請 Aya 確認以下 5 項決策：
>
> 1. **骨架策略**：是否確認「**不 fork 第三方專案**，直接以 Fogone `legacy/` 核心模組重建乾淨的 AGPL-3.0-only 自有骨架」？
> 2. **技術棧**：是否確認沿用 **WXT（升至 0.21.5）＋ TypeScript ＋ React 19（僅限自有頁面，網頁端維持零框架純 DOM）**？
> 3. **單字層級互動**：是否採用 **CSS Custom Highlight API（標記）＋ 零 DOM 修改游標取詞（點擊生詞／`Alt+點擊` 或選字查生字）**？
> 4. **資料層與 Mac／Windows 同步**：本機 IndexedDB 封裝偏好極簡的 **`idb`（11.6 KB）** 還是查詢友善的 **`dexie`（87.5 KB）**？MVP 階段是否同意**先做本機＋JSON 匯出／合併匯入**，暫緩自動跨機同步（待第二階段再視需求加選用式 WebDAV）？
> 5. **首發外語**：是否確認第一個完整支援生詞標記與單字本的外語為 **英文（`en`）**，日文排第二、韓文排第三？
