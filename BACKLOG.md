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
- 驗收（2026-08-30 修訂）：`node scripts/verify.mjs '<threads 搜尋頁>' --scroll`，
  貼文正文出現雙語，且不得出現帳號名／時間戳被翻譯。
  **數量指標改看 `stats.done` 與 `xyiPeak`，不看結束時的 `xyiCount`**——理由見下方虛擬化那條。
- 已完成（Batch 2）。採方案 C：兩段式＝觸發門檻 ＋ 文字密度啟發式 ＋ 品質閘門。
  實測（未登入，`--scroll`）：mode=dense、found 44、fallbackFound 43、done 27、failed 0、
  xyiPeak 14~19（每次略有浮動）、xyiCount 結束時 12。截圖確認帳號名
  （javascript_concepts_daily、lihazadnan.ai）與時間戳（2026-8-21）皆未被翻譯。
- **Threads 會虛擬化列表**：貼文容器（`[data-pressable-container]`）不論捲到哪裡都固定只有
  5~6 個在 DOM 裡，離開視窗的貼文被整個卸載，連同我們的 `<x-yi>` 一起消失
  （實測 xyi 與 done 每次取樣都相等，代表節點不是被 React 清掉，是連同貼文一起卸載）。
  所以在這類站上，「跑完當下的 xyiCount」量到的是視窗容量而不是翻譯成效，
  `xyiCount ≥ 20` 結構上不可能達成。
- 已知限制二（codex review 指出，目標站未實際發生，暫不處理）：密度單位送翻的是整個
  子樹文字，所以「自身直接文字達標、但底下還掛著中繼資料子節點」的容器會把它們一起翻進去：
  ```html
  <div>這是真正的貼文內文，直接文字夠長。<span>@alice</span><span>2 hours ago</span></div>
  ```
  0.5 的比例閘門只保證被吞的部分不超過一半，擋不住這種短中繼資料。
  這是密度啟發式的固有性質（不是「留最外層」造成的——上例的兩個 span 根本沒過門檻、
  不是命中項）。Threads 實測未出現此形狀（截圖確認帳號名與時間戳皆未被翻）。
  真要解得改成「只送直接文字」，但那會丟掉貼文內文裡的行內連結，得先量再決定。
- 已知限制（Batch 2 的 codex review 指出，暫不處理）：分段策略在 `start()` 決定後
  整個 session 不再改變。若 SPA 在使用者按下翻譯時還是空殼，會誤選 dense；
  反之若空殼裡剛好有 13 個以上的行銷用 `<p>`，會誤選 standard，之後真正的 div/span
  貼文串就一個都翻不到。目前實務上不會踩到（使用者是在頁面載入後才點翻譯），
  真要修的方向是「延後決定或允許有限次重新評估」，但那會引入新的失敗模式，先記著。
- 探勘留參（不做）：方案 B'——用 Threads 實際存在的 `[data-pressable-container]`
  當貼文錨點（首頁 15 個、搜尋頁 4 個）。不採用的理由：那是 Meta 內部屬性、隨時改名，
  且命中數遠低於實際貼文數。若日後真的需要，正確做法是「站點規則（資料驅動的例外清單）」
  ——把站點特例放進可更新的資料檔而不是寫死在分段器裡。**列為未來可能功能，現在不做。**
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
- 驗收（2026-08-30 修訂）：Reddit 首頁被反機器人擋（見 CLAUDE.md），改用 `r/programming`。
- 已完成（Batch 2）。捲動續翻機制本身確認正常，`yiErrors` 全部為空：

  | 站 | 不捲動 xyiCount | --scroll xyiCount | found | queued | done | failed |
  |---|---|---|---|---|---|---|
  | BBC | 12 | **93** | 93 | 93 | 93 | 0 |
  | MDN | 8 | **37** | 63 | 37 | 37 | 0 |
  | Threads | 4 | 12（peak 14~19） | 44 | 33 | 27 | 0 |

  BBC 是最乾淨的證明：捲完之後 found/queued/done 三個數字收斂到同一個 93，
  代表可視優先佇列把整頁單位全部消化完、沒有卡住也沒有漏。
- **`r/programming` 幾乎翻不到東西（found 16、done 2），但不是捲動的問題**，根因見 #9。

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

## #9 [P2] Reddit 貼文標題是裸 <a>，任何策略都收不到
- 現象：`r/programming` 實測 found 16、done 2，捲動前後 xyiCount 都是 2。
- 根因（Batch 2 驗 #4 時發現，非捲動問題）：
  1. 貼文標題是 `<a id="post-title-…">`，**不在 UNIT_SELECTOR 裡**（`a` 不是塊級單位），
     密度備援也收不到——文字在 `<a>` 內部，父層 div 的直接文字為空。
  2. 標準命中 16 > 觸發門檻 12，所以密度備援根本不會啟動；就算啟動也沒用（見上）。
  3. 該 profile 的 Reddit UI 是 `lang="zh-TW"`，側欄與選單本來就是中文，
     被 `looksChinese` 正確跳過（skippedChinese 10）——這部分是對的，不是 bug。
  4. 82 個標準單位中有 66 個在 `<aside>`（社群規則側欄），被 #1 正確排除。
- 方向（做的時候再定案）：評估把「夠長、夠多詞、不在外框裡」的 `<a>` 納入單位候選。
  風險是導覽連結全部湧入，得靠 #1 的外框排除與詞數閘門擋住——先量再改。
- 驗收：`node scripts/verify.mjs https://www.reddit.com/r/programming/ --scroll`
  貼文標題出現雙語，且導覽與側欄仍零譯文。
