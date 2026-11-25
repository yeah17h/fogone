# Fogone 重建基礎研究筆記（Step 0）

研究深度：深 — 本任務明確指定「研究深度：深」，且為全新從零重建專案，需深入評估舊專案萃取、開源骨架選擇與授權相容性、單字層級互動、本機資料與同步層、多語斷詞體積與首發語言。

> 本文件記錄研究過程的完整查證數據與建議，並與正式設計依據報告 `docs/foundation-research.md` 同步維護（每完成一節即存檔）。
> 查核 `.aya/deep-research/`：本 repo 目前無 ChatGPT / Gemini 外部深度研究報告，故無外部報告交叉比對項目。
> 所有第三方專案數據、npm 體積與 GitHub 狀態均於 **2026-11-25** 即時查詢驗證；查無資料處一律標註「查不到」。

---

## 一、常見的坑與實作避坑原則

| 類別 | 常見的坑 | 實作時怎麼避免 |
|---|---|---|
| 授權相容性 | 標榜「開源」的瀏覽器翻譯擴充常為閉源（如 Immersive Translate）或 GPL-3.0；GPL-3.0 檔案無法直接改授權成 AGPL-3.0-only，僅能依 GPLv3/AGPLv3 §13 維持原檔 GPL-3.0 並組合散布。 | 任何候選專案必查根目錄 `LICENSE` 全文與 `package.json` 是否一致；若需 AGPL-3.0-only 乾淨單一授權，只借鏡設計思維自行重寫，或只引入 MIT／Apache-2.0／BSD／ISC 套件。 |
| 編碼與多語字元 | CJK 漢字橫跨中文與日文（`U+4E00–9FFF`）會導致日文被誤判成中文；用 `[a-z]` 過濾字母會誤刪韓文與歐語字母；文字分隔符若直接寫入 raw 控制字元（如 `0x1F`）會被 Git 視為二進位檔。 | `looksChinese` 必先以 Unicode `Script=Hiragana\|Katakana` 短路，且與備援語言判斷共用同一份 `KANA` 定義；字母判斷統一用 `/\p{L}/u`；控制字元一律寫轉義字面量 `\u001f`。 |
| 跨平台路徑與腳本（Windows / macOS） | Windows PowerShell 不支援 `VAR=1 cmd` 語法，沒有 `pgrep`/`sleep`，路徑分隔符為 `\` 且磁碟機大寫不一致；Chrome 152+ 正式版已移除 `--load-extension`。 | 建置旗標改讀 `npm_lifecycle_event`；驗證腳本共用跨平台 `scripts/chrome.mjs`（Windows 用 `Get-CimInstance`、跨平台 `Atomics.wait`、統一路徑正規化）並以固定 `.pw-profile` + CDP 附加。 |
| Chrome 內建 AI 環境差異 | `LanguageDetector` 在 content script 環境曾實測不可用；`Translator.availability()` 在網頁環境對 `ja→zh-Hant` 會出現間歇性偽陰性（回 `downloadable` 而擴充頁面回 `available`）；`Translator.create()` 無使用者手勢不會被平台阻擋。 | 語言偵測固定走「`LanguageDetector` 優先 + `guessSource` 備援」；popup 逐語言對顯示 availability 且採 `anyReady` 解鎖；content script 嚴格自律僅在 `available` 才呼叫 `create()`（守鐵律 5）。 |
| DOM 破壞與網站相容（含 Shadow DOM） | 用 `<span>`/`<mark>` 包裹原文文字節點會破壞 React/Vue 虛擬 DOM 與事件（違反鐵律 4）；`querySelectorAll` 漏掉 MutationObserver root 自身；虛擬化列表（Threads）會卸載 `<x-yi>` 導致重複翻譯；對 fullscreen shadow host 呼叫 `moveBefore` 會觸發 Chromium 崩潰。 | 雙語譯文維持只追加 `<x-yi>`，生詞標記改用零 DOM 修改的 **CSS Custom Highlight API** + `caretPositionFromPoint`；MutationObserver 必用 `selfAndDescendants`；維持分頁級 LRU 快取與 `stats.done` 驗收；查詞彈窗獨立掛於 `document.documentElement` 且不移動頁面原節點。 |
| PDF 安全與併發競態 | 具 `<all_urls>` 權限的 PDF 檢視器若只驗證初始 URL，會被 30x 重新導向或 IPv4-mapped IPv6（`[::ffff:7f00:1]`）繞過私網檢查造成 SSRF；快速切換檔案會發生非同步競態覆蓋；React 重繪會洗掉 `<x-yi>`。 | `assertSafePdfUrl` 還原 IPv6 內嵌 IPv4 並在 `fetch` 後對 `res.url` 二次驗證；載入管線使用 `genRef` + `AbortController` + `finally` 釋放 `task.destroy()`/`page.cleanup()`；PDF 段落 DOM 由命令式容器掛載、不交給 React 協調。 |
| 擴充儲存隔離與隱私承諾 | 在 content script 直接呼叫 `indexedDB` 會寫入**目標網站**的 origin 而非擴充本身；舊版 `PRIVACY.md` 承諾「不使用 `chrome.storage` 與 `IndexedDB`、`permissions: []`」，新增單字本時若忘記同步更新會違背對外承諾。 | 所有 IndexedDB 讀寫統一經由 background service worker（擴充 origin）透過 `chrome.runtime.sendMessage` 代理；上架前同步修訂 `PRIVACY.md` 與商店文案，明確揭露「僅存於使用者本機裝置、不上傳」。 |
| 斷詞套件隱藏體積 | 看似輕量的斷詞套件可能暗藏龐大字典依賴（例：`wink-lemmatizer` 本體 6.5 KB，但依賴 `wink-lexicon` 11.99 MB）；日韓高精度形態素模型動輒 12.5～89 MB。 | 導入任何 NLP/斷詞套件前必查 `registry.npmjs.org` 與完整依賴樹實際體積；優先利用瀏覽器內建 `Intl.Segmenter`（0 KB）搭配極輕量規則詞形還原。 |

---

## 二、舊專案慣例與可重用基礎（淺級盤點摘要）

舊專案位於 `legacy/`（v0.2.0，架構極精簡，核心 `lib/` 約 1,900 行零框架 TypeScript）：
- **沿用架構鐵律與原則**（`legacy/CLAUDE.legacy.md`）：5 條架構鐵律（免費與預設永不經自家伺服器、零遙測、網頁注入零框架純 DOM、零破壞、手勢內才觸發語言包下載）＋ 2 條驗證原則（診斷面板每一格皆須可變動、驗收看 `stats.done` 不看 `xyiCount`）。
- **命名與內部識別字慣例**：產品名「幾個譯思 Fogone」，內部識別字維持 `<x-yi>`、`yi:` 訊息前綴、`.pw-profile`（避免無謂 churn）。
- **可直接搬移的核心模組**：`legacy/lib/engine.ts`、`legacy/lib/cache.ts`、`legacy/lib/renderer.ts`、`legacy/lib/sites/*`（含 YouTube 字幕模組）、`legacy/lib/pdf/{items,document,reflow}.ts`、`legacy/types/builtin-ai.d.ts`、`legacy/test/*`、`legacy/scripts/{chrome,sync-pdfjs-assets,make-pdf-fixtures,verify,verify-yt,verify-pdf}.mjs`。
- **需參考後重寫的模組**：`legacy/entrypoints/{content.ts,popup/,viewer/}`、`legacy/lib/segmenter.ts`（補 Shadow DOM 與單字層級協作）、`legacy/lib/scheduler.ts`（整合生詞掃描鉤子）、`legacy/scripts/store-assets.mjs`（待正式視覺識別與學習功能截圖）。
- **不需要的項目**：`legacy/scripts/spike-summarizer.mjs`、`legacy/public/icon/*`（16px 糊掉佔位圖）、`legacy/public/pdfjs/`（gitignored 建置產物，非原始碼）。

---

## 三、標準函式庫與現成套件評估（中級摘要）

| 用途 | 候選方案 | 最新版本／授權 | 實際體積（2026-11-25 實測） | 評估與結論 |
|---|---|---|---|---|
| 擴充建置框架 | `wxt` | `0.21.5` / **MIT** | npm unpacked 358.9 KB（僅建置期，不進產物） | **沿用並升級**（舊專案 0.20 → 0.21.5）。MV3 原生支援、不強迫 content script 帶框架；`read-frog` 與 `FluentRead` 皆採用。 |
| 網頁內單字標記與點擊 | Chrome 原生 **CSS Custom Highlight API** + `highlightsFromPoint()` + `caretPositionFromPoint` | 瀏覽器內建（Chrome 105+ / 140+） | **0 KB** | **自行封裝**。100% 零 DOM 修改，完美符合鐵律 4；搭配 Chrome 138+ 基線無相容包袱（`highlightsFromPoint` 針對 140+ 並保留 `caretPositionFromPoint` 備援）。 |
| 本機資料庫（單字本／SRS） | `idb` vs `dexie` vs 原生 IndexedDB | `idb` `8.0.4`（**ISC**）／`dexie` `4.4.7`（**Apache-2.0**） | `idb`: 11.6 KB（unpacked 82.6 KB）；`dexie.min.mjs`: 87.5 KB（unpacked 3.24 MB） | **推薦 `idb`（11.6 KB）或 `dexie`（87.5 KB）**（均僅跑在 background／自有頁面，不進 content script）。若重視極輕量與零魔法選 `idb`；若重視多索引條件查詢與 schema migration 便利選 `dexie`。 |
| 間隔重複演算法（未來複習） | `ts-fsrs` | `6.0.1` / **MIT** | `dist/index.mjs`: 43.1 KB（unpacked 847.6 KB） | **未來複習階段推薦直接用**，MIT 與 AGPL 相容、體積小且業界標準（Read Frog 亦採用）。 |
| 英文斷詞與詞形還原 | 瀏覽器 `Intl.Segmenter('en')` + 自寫規則詞形還原 | 瀏覽器內建 + 自寫 | **0 KB** + 約 10～15 KB（參考 Yomitan `en` 11.3 KB） | **自己寫極簡還原規則**。避免 `wink-lemmatizer`（拖帶 `wink-lexicon` 11.99 MB）與 `compromise`（333.5 KB）。 |
| 日文斷詞 | `Intl.Segmenter('ja')` / `budoux` / `kuromoji` / `lindera-wasm-web-ipadic` | 內建 / Apache-2.0 / Apache-2.0 / MIT | 0 KB / 33.0 KB / **16.97 MB** / **12.50 MB** | **暫不作第一語言**。內建 `Intl.Segmenter('ja')` 實測會切碎動詞活用（`食べられなかった` → `食\|べら\|れ\|なか\|っ\|た`）且無原型／讀音；要精準還原原型需 +12.5～17 MB 字典或外掛可選字典下載。 |
| 韓文斷詞 | `Intl.Segmenter('ko')` / `lindera-wasm-web-ko-dic` / `kiwi-nlp` | 內建 / MIT / Apache-2.0 | 0 KB / **22.10 MB** / **89.4 MB**（WASM 5.38 MB + 模型 83.89 MB） | **排在最後**。實測 `Intl.Segmenter('ko')` 僅按空白切語節（`학교에서\|친구들과\|맛있는\|밥을\|먹었습니다`），無法去助詞與詞尾；形態素分析體積極大。 |

---

## 四、GitHub 開源專案前 5 名比較（深級摘要，2026-11-25 實查）

> **排除說明**：`immersive-translate/immersive-translate`（19,881★）README 明確標示為**閉源（not open-source）**且 repo 無原始碼；`FilipePS/Traduzir-paginas-web`（6,089★，MPL-2.0，2026-10-29）僅做整頁翻譯、無語言學習／生詞功能。

| # | 專案 | 星數 | 最後 Commit | 授權（實查 `LICENSE`） | 技術棧 | 適不適合當骨架／改動量 |
|---|---|---:|---|---|---|---|
| 1 | [fishjar/kiss-translator](https://github.com/fishjar/kiss-translator) | 13,530 | 2026-11-25 | **GPL-3.0** | React 18 + MUI v5 + CRA (`react-scripts` 5) + OCR/WASM/WebDAV | **不適合**。舊 CRA 建置、依賴極肥大、MUI 注入網頁違鐵律 3、GPL-3.0 無法直接改授權為 AGPL-3.0-only。 |
| 2 | [FluentRead/FluentRead](https://github.com/FluentRead/FluentRead) | 11,170 | 2026-11-24 | **GPL-3.0** | WXT 0.21.5 + Vue 3 + Element Plus + Dexie + kuromoji + OCR/TTS | **不適合**。Vue 3 棧不同、45+ 龐大執行期依賴（含 kuromoji/OCR/TTS）、GPL-3.0 授權限制。僅參考 open Shadow DOM 遍歷思維。 |
| 3 | [mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog) | 10,539 | 2026-11-25 | **GPL-3.0** | WXT 0.21.5 + React 19 + Tailwind 4 + Dexie + 22 個 AI SDK + PostHog + Better Auth | **不適合**。內建 PostHog 遙測（違鐵律 2）、雲端帳號驗證（違鐵律 1）、React 掛進網頁（違鐵律 3 且曾引發 Speedometer 退化）、無 PDF 閱讀器、GPL-3.0 限制。僅參考 WXT 0.21 + Dexie + FSRS 概念。 |
| 4 | [yomidevs/yomitan](https://github.com/yomidevs/yomitan) | 2,958 | 2026-11-12 | **GPL-3.0-or-later** | 純 JS（JSDoc 型別檢查）+ Handlebars + esbuild + Dexie | **不適合當完整骨架，但為最佳參考對象**。無整頁雙語／YouTube／PDF、非 WXT、GPL-3.0-or-later 無法直接改 AGPL；其零 DOM 修改游標掃詞與輕量規則變形架構極值得用 AGPL 自行重寫。 |
| 5 | [xiao-zaiyi/illa-helper](https://github.com/xiao-zaiyi/illa-helper) | 2,917 | 2026-07-02 | **MIT**（前五唯一可直接改 AGPL） | WXT 0.20.6 + Vue 3 + Tailwind 4 + Reka UI | **不適合**。雖為 MIT，但屬 Vue 3 且產品路線是 LLM i+1 行內替換、直接改寫原文 DOM 文字節點（違鐵律 4），且無雙語整頁／YouTube／PDF。 |

> 附註觀察：`translate-tools/linguist`（1,092★，2026-09-04）出現授權標示矛盾（根目錄 `LICENSE` 為 `BSD-3-Clause`，`package.json` 寫 `GPL-3.0`），已列於正式報告附註提醒避開。

---

## 五、正式報告寫作進度（即時檢查點）

- [x] 已完成所有 `legacy/` 盤點、GitHub/npm/官方文件實查與 `Intl.Segmenter` 實測
- [x] `docs/foundation-research.md` 第 1 節：舊專案萃取（已涵蓋 `legacy/` 全部目錄與設定檔）
- [x] `docs/foundation-research.md` 第 2 節：踩坑清單（已收錄 28 條含具體 `legacy/` 檔案路徑）
- [x] `docs/foundation-research.md` 第 3 節：GitHub 前 5 名比較（皆附連結、實查授權與最後 commit 日期）
- [x] `docs/foundation-research.md` 第 4 節：單字層級（推薦 CSS Custom Highlight API + 零 DOM 修改游標取詞混合方案）
- [x] `docs/foundation-research.md` 第 5 節：資料層與跨裝置同步（已附官方配額與三方案代價分析）
- [x] `docs/foundation-research.md` 第 6 節：斷詞與首發語言（已附實查體積與 `Intl.Segmenter` 實測，推薦英文首發）
- [x] `docs/foundation-research.md` 第 7 節：結論與建議（已明確標出最終由 Aya 決定）
- [x] 更新 `.aya/state.md` 並檢查 `git status`

---

## 六、最終推薦與理由（待 Aya 確認）

1. **骨架選擇：不 Fork 第三方開源專案，以 Fogone `legacy/` 核心重建自有 AGPL-3.0-only 骨架。**
   - 理由：GitHub 前 5 名中有 4 個為 GPL-3.0（無法直接改授權為 AGPL-3.0-only），唯一 MIT 的 `illa-helper` 是 Vue 3＋破壞性 DOM 替換；主流雙語專案多含遙測／雲端帳號／網頁注入前端框架，違背鐵律 1～4。舊專案 `legacy/` 已以 <2,000 行零框架 TS 解決 Chrome 138+ 本地翻譯、YouTube ASR 字幕與 2 欄 PDF 重排，只需直接搬移成熟核心並以純 TS 重寫借鏡自 Yomitan／CSS Custom Highlight API 的單字學習模組。
2. **技術棧：沿用 WXT（升至 0.21.5）＋ TypeScript ＋ React 19（限自有頁面）＋ Vitest ＋ Playwright CDP。**
   - 理由：維持網頁端零框架（鐵律 3）與真 Chrome 驗證閉環，擴充自有頁面（popup／viewer／單字本／小測驗）用 React 19 兼顧開發效率。
3. **單字層級：CSS Custom Highlight API（標記）＋ `highlightsFromPoint`／`caretPositionFromPoint`（游標命中）＋ 單一純 DOM `<x-yi-card>` Shadow Host。**
   - 理由：100% 零 DOM 修改，完全守住鐵律 4 且吃滿 Chrome 138+/140+ 原生能力。
4. **資料層與同步：Background 託管 IndexedDB（推薦 `idb` 11.6 KB 或 `dexie` 87.5 KB）＋ `chrome.storage.local` 存設定與精簡生詞原形快取；MVP 先不做自動雲端同步，改提供 JSON 備份匯出／合併匯入（後續視需求加選用式 WebDAV，不用 100 KB 上限的 `chrome.storage.sync` 塞單字本）。**
   - 理由：零伺服器、不踩 100 KB 配額牆、提醒同步更新 `PRIVACY.md`。
5. **第一個支援的外語：英文（`en`）。**
   - 理由：`Intl.Segmenter('en')`（0 KB）＋ ~10 KB 自寫規則詞形還原零體積負擔，且 Chrome 內建 `en→zh-Hant` 最穩定；日文（需 12.5～17 MB 字典或可選外掛）排第二、韓文（22～89 MB）排第三。

> 完整 7 節論證與實查明細請見 `docs/foundation-research.md`。**以上所有最終方案均待 Aya 拍板確認後再進入下一階段。**
