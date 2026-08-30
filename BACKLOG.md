# BACKLOG — spike 2 結果轉入（2026-08-30）

來源：BBC、MDN、Zenn、Threads、Reddit 五站實測（v0.0.4，L0 本地引擎）。
根因紀錄：LanguageDetector 在 content script 不可用（Reddit 統計列出現備援警語證實）；目前翻譯由備援語言判斷驅動，運作正常。

## #1 [P0] 導覽與 UI 標籤不該翻（過翻＋版面擠壓）
- 現象：BBC 主導覽 Home→故鄉、Culture→耕種、Live→仕、頁首 NEWS→息；MDN 側欄與右側目錄整排被翻、API 名稱 NavigationActivation→航行；BBC 導覽列被譯文撐開換行、版面擠壓。
- 方向：分段器排除位於 nav、header、footer、aside、[role=navigation]、[role=menubar]、[role=tablist] 祖先內的單位；純連結的短標籤單位（≤2 個詞、內容幾乎全是 <a>）不翻。
- 驗收：BBC 首頁主導覽零譯文且不換行；MDN 側欄與右側目錄零譯文；兩站正文照翻（正文 xyiCount 不低於現況八成）。

## #2 [P0] Threads 類 div/span 結構抓不到主內容
- 現象：Threads 找到 7、完成 0；貼文全是 div/span 疊出來的，不在 UNIT_SELECTOR 涵蓋範圍。
- 方向：兩段式分段——標準選擇器命中數過低時啟動備援策略：以「直接文字節點豐富」的葉層 div 為單位（文字密度啟發式），或優先對 article、[role=article] 容器切段。
- 驗收：Threads 搜尋頁的英文貼文出現雙語；`node scripts/verify.mjs <threads url>` 的 xyiCount ≥ 20。
- 備註（Batch 1 的 codex review 抓到、當時刻意不修）：`collectUnits()` 用 `root.querySelectorAll()`
  只找子孫、不含 root 自身，所以 MutationObserver 收到「新增的節點本身就是翻譯單位」時
  （SPA 直接 append 一個 `<p>`，Threads 與無限捲動都是這個形狀）完全不會被收集。
  修法兩行——root 若自身 match `UNIT_SELECTOR` 就一起納入候選（記得去重）：
  ```ts
  const self = root instanceof HTMLElement && root.matches(UNIT_SELECTOR) ? [root] : [];
  const candidates = [...self, ...root.querySelectorAll<HTMLElement>(UNIT_SELECTOR)];
  ```
  **這一項當 Batch 2 的第一個 commit 修**：修正要跟能驗證它的測試一起進，
  而 Threads（#2）與捲動續翻（#4）正是能證明它的兩個場景。

## #3 [P1] Zenn 日文頁零譯文（已定位：見 #7）
- 現象：整頁無譯文。
- 複測統計（2026-08-30，Zenn 文章頁）：找到 67、完成 2、失敗 0、跳過中文 7、跳過語言包 11、備援語言判斷生效（detectorBroken=true）。
- 定位：`跳過:中文=7` 證實 `looksChinese` 把日文漢字段落誤判為中文 → 轉為 #7 修。
  `跳過:語言包=11` 則是另一條線：ja→zh-Hant 的 availability 不是 `available`，但目前統計看不出到底是 `downloadable`（沒下載）還是 `downloading`（下載中），無法判斷該叫使用者去 popup 啟用、還是等下載完。
- 子任務（本項）：stats 增記每個語言對實際看到的 availability 值
  （形如 `{ 'ja→zh-Hant': 'downloadable', 'en→zh-Hant': 'available' }`），並顯示在 popup 統計列，
  讓下次能直接判斷 ja 是 downloadable 還是 downloading。
- 驗收：Zenn 文章正文段落出現 ja→zh-Hant 雙語；popup 統計列顯示每個語言對的 availability 值。

## #4 [P1] 捲動續翻驗證
- 現象：Reddit 找到 49、完成 6，其餘在可視區外未排入，屬可視優先的預期行為；需確認捲動時佇列持續消化、譯文陸續出現。
- 驗收：`node scripts/verify.mjs https://www.reddit.com/ --scroll` 的 xyiCount 相對不捲動明顯上升，且過程無報錯。

## #5 [P2] code 樣式 token 不翻
- 現象：駝峰式 API 名稱被單獨翻譯（MDN 側欄）。#1 的 nav 排除會蓋掉大半；殘餘情況是正文中的單一駝峰或無空白長 token 單位。
- 方向：單位文字若為單一 code-like token（駝峰、含底線、無空白且長）則跳過。
- 驗收：MDN 正文中的 API 名稱不再單獨成譯。

## #6 [P2] 統計列文案轉正
- 現象：「語言偵測器在此環境不可用」是除錯語氣；偵測器不可用已是常態事實。
- 方向：文案改中性（例：語言判斷：備援規則），stats 欄位保留。
- 驗收：popup 統計列讀起來不像錯誤訊息。

## #7 [P0] 日文被誤判為中文而跳過
- 現象：Zenn 實測 `跳過:中文=7`。`looksChinese` 只看 U+4E00–9FFF（統一漢字）佔比 > 0.3，
  日文段落的漢字（和製漢字與中日共用漢字同碼位）直接把門檻頂過去，整段被當成中文跳過。
- 修法：文字含假名（平假名／片假名 U+3040–30FF）一律不視為中文，
  在算 cjkRatio 之前先短路（`looksChinese` 回 false），交給 `guessSource` 判成 ja。
- 驗收：Zenn 統計「跳過:中文」趨近 0，正文出現 ja→zh-Hant 雙語。

## #8 [P1] ja 語言包每個 browser session 需暖機
- 現象：`Translator.availability()` 在每個新 browser session 對 ja 會先回 `downloadable`，
  要 `create()` 過一次、約 5 秒後才轉 `available`（是暖機，不是重新下載——磁碟上已經有模型）。
  後果有兩個：popup 因 `allReady === false` 卡在「啟用本地翻譯」畫面，翻譯鈕根本不出現；
  content script 的 `avail !== 'available'` 把 ja 單位全部跳掉。
  這就是 #3 裡「跳過:語言包=11」的根因。
- 方向（做的時候再定案）：
  - popup 的啟用鈕每個 session 皆可安全暖機——它在使用者手勢內，`create()` 合鐵律 5，重複點無害。
  - 評估 content script 對「`downloadable` 但模型其實已在磁碟」的情況能否直接 `create()`；
    若不行（會觸發下載＝違反鐵律 5），改成在 popup 顯示提示引導使用者點一次。
- 驗收：重啟 Chrome 後第一次翻日文頁不再出現「跳過：語言包」，popup 不再卡在啟用畫面。
