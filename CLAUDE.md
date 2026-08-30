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
3. 讀 stdout 的統計與 reports/verify.png 截圖，對照 BACKLOG.md 該項的驗收標準
4. 不過就繼續改；過了才收工，回報 diff 摘要與驗證數據

**驗收指標的原則：量測「完成的翻譯工作」，不量測「量測當下的 DOM 殘留」。**
所以數量看 `stats.done`（累計完成數），不看 `xyiCount`——虛擬化的站（Threads 實測貼文容器
固定只有 5~6 個在 DOM 裡）會把離開視窗的內容連同 `<x-yi>` 一起卸載，`xyiCount` 量到的是
視窗容量而不是成效。`xyiCount` 與 `xyiPeak` 仍值得回報當參考值，但不作驗收依據。

## 環境事實（已實測，不用懷疑也不用重驗）
- 本地 Translator API 只存在於真 Chrome 138+ 桌面版；Playwright 內建 Chromium 沒有 → verify 一律用系統安裝的正式版 Chrome
- **正式版 Chrome 已移除 `--load-extension`（本機實證，Chrome 152）**：該旗標與 `--disable-extensions-except` 都不再生效，
  且 Playwright 預設會帶 `--disable-extensions`。結論：不要再嘗試用命令列旗標或 `launchPersistentContext` 注入擴充，
  CDP `Extensions.loadUnpacked` 那條路要非常規旗標（`--enable-unsafe-extension-debugging`），也不走。
- verify 的做法：`child_process.spawn` 真 Chrome（`--remote-debugging-port=9333 --user-data-dir=<root>/.pw-profile`）
  → `chromium.connectOverCDP` 附加 → `browser.contexts()[0]` 開分頁跑流程 → 結束時斷線並終止該 Chrome。
  **啟動前會先清掉佔用同 profile 的殘留 Chrome 行程**：同 profile 已有實例時，新啟動的 Chrome
  只會把網址轉交給舊實例然後自己退出，於是實際測到的是舊實例載入的**舊擴充產物**——
  rebuild 完全不生效而且無聲無息。這個坑踩過一次，別把清理邏輯拿掉。
- `.pw-profile` 是 verify 專用的固定 Chrome profile，**需要一次性手動安裝擴充**：
  chrome://extensions → 開發人員模式 → 載入未封裝 → 選 `.output/chrome-mv3` → 再點擴充圖示「啟用本地翻譯」下載語言包。
  裝過之後擴充就留在該 profile，每次啟動 Chrome 都從磁碟重讀 `.output/chrome-mv3`——**rebuild 後直接重跑 verify 即生效**。
  要測 Threads 等需登入的站，也在這個 profile 登入一次即可。
- LanguageDetector 在 content script：**spike 2 實測不可用，Batch 1 實測可用**（`detectorBroken: false`）。
  兩次結果不同，所以不要把任一邊當成定論。架構刻意不依賴任何一邊：偵測器優先，
  `guessSource` 備援殿後，兩條路共用 segmenter 匯出的同一份 `KANA` 定義（各寫一份遲早會不一致，#7 就是這樣來的）。
- **`.pw-profile` 不留任何登入 cookie，Threads 與 Reddit 一律不登入測**：repo 未來要公開，
  少一個要保護的祕密就少一個外洩面。登入態不另測——先前人工測試即為登入態，
  貼文結構同樣是 div/span 疊出來的，已被未登入的驗證涵蓋。
- Threads 未登入會彈登入牆 dialog，並把 `document.scrollHeight` 壓成視窗高度（實測 900），
  捲動完全無效、內容也進不了 DOM。verify.mjs 會在載入後與捲動前各按一次 Escape 關掉
  （通用 modal 手勢，非單站 hack）；關掉後 docH 900 → 10976。
- **Threads 會虛擬化列表**：貼文容器不論捲到哪都固定只有 5~6 個在 DOM 裡，離開視窗即整個卸載，
  連同我們的 `<x-yi>` 一起消失。所以這類站要看 `xyiPeak` 或 `stats.done`，
  「跑完當下的 xyiCount」量到的是視窗容量，不是翻譯成效。
- Reddit 首頁（`https://www.reddit.com/`）被反機器人擋（`Prove your humanity`），
  未登入讀不到內容；`https://www.reddit.com/r/programming/` 可以直接讀。
  `old.reddit.com` 需要登入，同樣不用。
- `Translator.availability()` 曾在每個新 browser session 對 ja 先回 `downloadable`，
  `create()` 一次後約 5 秒轉 `available`。**Batch 3 複測已不再重現**：連續三次全新 Chrome、
  完全不呼叫 `create()`，ja 都直接是 `available`。判讀：當時語言包還沒真的裝完，
  那 5 秒是補完下載的尾巴而不是「暖機」。→ 不需要每個 session 暖機（BACKLOG #8 已結案）。
  對照組 `ko→zh-Hant` 仍是 `downloadable`，可用來確認 availability 真的會回報未下載狀態。
- **`Translator.create()` 在無使用者手勢下不會被擋**（實測：等 transient activation 過期、
  `navigator.userActivation.isActive === false` 之後呼叫，照樣成功）。
  這代表**鐵律 5 是我們自律的，不是平台幫我們強制的**——content script 若對
  `downloadable` 的語言對呼叫 `create()`，會真的開始下載且沒有任何東西會阻止。
  「content script 只在 `available` 時翻譯」這條必須自己守住。
- `downloadprogress` 事件**即使模型已在磁碟也會觸發**（實測 loaded 0→1），
  所以不能用「有沒有收到 downloadprogress」來判斷這次 `create()` 是不是真的在下載。
- 注意 Playwright 的 `page.evaluate()` 自帶 user activation（`isActive === true`）。
  要測「無手勢」行為必須在 evaluate 內先等約 8 秒讓 transient activation 過期。

## 工作方式
- 一次只做 BACKLOG.md 的一個項目；動工前先簡述計畫再改
- 改 lib/segmenter.ts、lib/scheduler.ts 前先完整讀該檔
- 不主動新增依賴；需要時先提出理由
