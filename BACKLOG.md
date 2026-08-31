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
- 驗收（2026-08-30 修訂並採用）：`node scripts/verify.mjs '<threads 搜尋頁>' --scroll`
  1. 數量：**`stats.done` ≥ 20**。
  2. 品質（不變）：貼文正文出現雙語，且不得出現帳號名／時間戳被翻譯。

  `xyiCount` 與 `xyiPeak` 仍會列在回報裡當參考值，但**不作為驗收依據**——
  它們量的是量測當下 DOM 裡還掛著幾個節點，理由見下方虛擬化那條。
- 已完成（Batch 2）。採方案 C：兩段式＝觸發門檻 ＋ 文字密度啟發式 ＋ 品質閘門。
  實測（未登入，`--scroll`）：mode=dense、found 40、fallbackFound 39、**done 28**、failed 0、
  擴充錯誤 0；參考值 xyiPeak 18、xyiCount 結束時 13。截圖確認帳號名
  （javascript_concepts_daily、saas_addy）與時間戳（2026-8-20）皆未被翻譯。
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

## #8 [P1] ja 語言包每個 browser session 需暖機（已結案：症狀不再重現，改為修 UX 阻擋）
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
- **複測結果（2026-08-30，Batch 3）：原症狀不再重現。** 連續三次全新 Chrome，
  完全不呼叫 `create()` 直接讀 availability，`ja→zh-Hant` 三次都是 `available`
  （同批對照組 `ko→zh-Hant` 是 `downloadable`，證明 availability 確實會回報未下載）。
  重測 Zenn：`skippedPack: 0`、`availability: {"ja→zh-Hant":"available"}`、done 7。
  → 原本觀察到的 `downloadable` 是**語言包當時還沒真的裝完**，那 5 秒的 `create()`
  不是「暖機」而是補完下載的最後一段。一旦裝完就穩定回 `available`，不需要每個 session 暖機。
  結論：不實作自動暖機——沒有東西要暖。
- **但底下有個真的 bug，本項一併修掉**：popup 用 `pairs.every(available)` 當閘門，
  只要有任何一個語言對沒好，翻譯鈕整個不出現。使用者的 en 明明可用，卻連英文頁都翻不了，
  而且畫面上完全看不出原因——這正是「靜默跳過」。
  改法：只要**有任一對**可用就給翻譯鈕；沒好的那幾對改用一行提示點名（含實際 availability 值，
  區分 `downloadable` 與 `downloading`），啟用鈕仍在、文案改為「啟用其餘語言包」。
  鐵律 5 完全不動：`create()` 依舊只發生在啟用鈕的點擊處理器裡。
  四種狀態實測：都可用→只有翻譯鈕；en 可用 ja 未下載→翻譯鈕＋「尚未啟用：ja→繁中（downloadable）」；
  都未下載→維持原首次使用流程；ja 下載中→「（downloading）」。

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

## #10 [P1] session 級記憶體翻譯快取
- 動機：Threads 這類虛擬化站會把貼文連同 `<x-yi>` 一起卸載，捲回時節點是重建的，
  `data-yi-done` 很可能隨之消失——那等於同一段文字被重翻。
  本地引擎重翻只是浪費電，但 BYOK 引擎重翻就是真金白銀；而且快取本來就在 M1 範圍內。
- **前提已實測成立**（2026-08-30，Threads 搜尋頁 `--scroll`）：
  `stats.done` 捲動前 3 → 捲到底 36 → **捲回頂端 64**。捲回時沒有任何新內容，
  卻多了 28 次完成＝28 次重翻。同時追蹤三段原文，捲到底時 `inDom: false`（確實被卸載），
  捲回後節點重建、又重新掛上 `x-yi`。結論：卸載時 `data-yi-done` 隨節點一起消失，
  重建後的節點被當成全新單位重新收集、重新送進引擎。
- 前提只決定「Threads 捲回」那條副驗收成不成立；**本項動機獨立於此前提**——
  BYOK 引擎重翻是真金白銀，且快取本來就在 M1 原定範圍內，照做。
- 方向：`Map<hash(原文 ＋ 引擎 id ＋ 語言對) → 譯文>`，命中就直接渲染、不進引擎。
  key 要含引擎 id 與語言對，否則之後 BYOK 切換引擎會拿到上一個引擎的譯文。
  這是 M1 原定 IndexedDB 持久快取的第一階段，持久化留待後續。
- 驗收：
  - 主（不依賴前提）：同一頁「關閉此頁翻譯」→ 再次「雙語翻譯此頁」，第二輪引擎呼叫數為 0。
  - 副（前提成立才適用）：Threads 捲下再捲回，重掛貼文即時出現譯文、引擎呼叫數不增。
- **已完成（Batch 3）。** 實作為 `lib/cache.ts` 的 module 單例 `translationCache`：
  Map 當 LRU（命中就搬到尾端）、上限 2000 筆、超過從最舊的丟。
  生命週期跟著**分頁**而不是 Session 物件——關掉雙語再打開會建新 Session，那顯然該吃到快取。
  快取查詢排在語言包檢查之前：手上已有譯文就不需要引擎，語言包在不在都無所謂。
  - key 用「引擎 id ＋ 語言對 ＋ 原文」直接串字串，**沒有 hash**。非密碼學雜湊會碰撞，
    而碰撞的後果是「在使用者頁面上顯示另一段文字的譯文」——安靜又難查的正確性 bug。
    以 32-bit 雜湊、2000 筆計碰撞機率約萬分之五，省下的 1~2MB 不值得換這個風險。
  - 上限有兩道：筆數 2000 **與**字元數 200 萬（約 4MB UTF-16）。只壓筆數不是真的上限——
    原文與譯文長度沒有上界，2000 筆若每筆 10KB 就是 80MB。
  - **沒有做 in-flight 去重**：三個並行工作者同時撞到同一段全新文字時，會各自呼叫一次引擎。
    實際頁面上重複文字多半先後出現（BBC 單次執行內命中 9 次都是先後命中），
    所以先不堵這個窗口；之後若 BYOK 成本數字顯示值得，再在快取裡存 Promise 做去重。
  - 實測（主驗收，BBC）：第 1 輪 done 12／engineCalls 12／cacheHits 0；關閉後 x-yi 歸 0；
    **第 2 輪 engineCalls 0／cacheHits 11**，cacheSize 維持 12（跨 Session 存活）。
  - 實測（副驗收，Threads `--scroll`）：翻完 engineCalls 4 → 捲到底 46 → **捲回頂端仍是 46**
    （+0），同時 cacheHits +30。對照步驟 0 未加快取時「捲回 done 從 36 跳到 64」的 28 次重翻。
  - 回歸：BBC/MDN/Zenn/Threads 全部 `done == engineCalls + cacheHits` 自洽，
    外框譯文 0、擴充錯誤 0。BBC `--scroll` 單次執行內就命中 9 次（頁面本身有重複文字）。

## #11 [已關閉] YouTube 譯文位置：規格讓步，現行為即為正解
- 現象：規格要求譯文疊在原文字幕下方，但 YouTube 預設字幕位置貼底，
  字幕視窗底部距容器底只有約 10px，而一行譯文約 40px——**下方根本放不下**。
  （先前量到的 80px 空間是控制列顯示時的暫態，控制列一收起就沒了。）
- 目前行為（M2 已實作）：下方塞得下就放下方，塞不下就放上方。
  兩種情況都不遮住原文、都不吃掉點擊（`pointer-events: none`）、全螢幕都正常。
  實測在預設狀態下幾乎都會落在上方。
- **裁決（2026-08-31）：規格讓步，選項 2 否決，本項關閉。**
  - 新規格：「譯文與原文同時可見、不遮擋、不攔截點擊；空間足夠置於下方、不足自動置上。」
    **現行為即符合，不需再改程式。**
  - 否決選項 2（注入 CSS 把 `.caption-window` 往上推）的理由：
    YouTube 的字幕位置是**使用者可感知、而且可以自己拖曳調整**的原生呈現。
    注入 CSS 改動它違反鐵律 4 的精神——「只加不改」涵蓋的不只是節點本身，
    也包含原內容的視覺位置。**規格可以為鐵律讓步，反過來不行。**
  - 被否決的另外兩個選項留檔：選項 1 是現行為；選項 3（一律置上）位置最穩定但
    在空間足夠時無謂地放棄了較好的閱讀順序。
- 同批 codex review 指出、暫不處理的相關項：滾動視窗的「非追加變動即定稿」判定偏寬，
  前緣截斷會讓相鄰兩份高度重疊的文字各被送翻一次，產生重複內容的譯文。
  實測 cueTranslated 68／cueEngineCalls 54／cueDropped 9，重複程度還在可接受範圍，
  真要解得計算重疊區並只送不重疊的部分。

## #12 [P2] 正式 wordmark 與圖示
- 現況：`public/icon/{16,32,48,128}.png` 是**佔位圖示**——深藍（#1B3A6B）圓角方形、
  白色「譯」字，用 Chrome 渲染截圖產生（`scratchpad` 的 make-icons.mjs，未進版本庫）。
  32／48／128 清晰可用，**16px 的「譯」糊掉了**：20 筆劃塞進 16 像素，
  放大檢視只剩一團色塊。這是筆劃密度的物理限制，不是參數調得不夠好。
- 設計備註（給正式版）：
  - **FOGONE 共用的那個 g 是識別核心**：fog + gone 縮合成 Fogone，
    把共用的 g 做雙色或連字處理，讓「兩個字疊成一個字」的梗直接變成視覺識別。
    這比再畫一個翻譯圖示有辨識度得多。
  - **16px 要另外設計，不要縮**。可行方向：只取「譯」的言字旁、或改用純幾何的
    霧散符號、或直接用 Fogone 的連字 g。小尺寸本來就該是獨立的一版而不是等比縮小。
  - 深藍底白字的對比在小尺寸是對的（實測 32px 以上都清楚），配色可沿用。
- 驗收：四個尺寸在 Chrome 工具列與擴充管理頁實際載入後都能辨識，
  16px 不再是色塊；商店頁的 440×280 小型宣傳圖沿用同一套識別。
- **最後一步（不做完本項不算結案）**：正式 wordmark 定稿後，
  1. 把 `scripts/store-assets.mjs` 裡的識別常數（`NAVY`／`ACCENT`／`INK`／`wordmark()`）
     換成正式版；
  2. 跑 `node scripts/store-assets.mjs` **重產全部六張**商店素材；
  3. 更新商店頁上架的圖片，並同步 `store/listing.md`。
  現行素材是**沿用佔位圖示配色與臨時 wordmark** 產生的。漏掉這步的後果是
  商店頁與使用者裝好後看到的擴充圖示長得不一樣——那是信任問題，不是美術問題。

## #13 [P1] 付費雲端進階功能（先摘要，之後字典）
- 商業模式（2026-08-31 定案）：**免費核心＋付費雲端進階功能**。
- **雙鑰匙解鎖**：同一批進階功能有兩種開啟方式，功能完全相同——
  1. **付費代管**：由 Fogone 伺服器轉發，使用者不必自備金鑰；
  2. **BYOK 自帶運算**：使用者自備 API 金鑰，直連自選供應商，**免費使用**。
  這個設計讓「付費」買的是省事，不是買功能本身——技術使用者永遠有免費路徑，
  也讓鐵律 1 的承諾（免費與預設功能不經過自家伺服器）在商業上站得住。
- 鐵律 1 的落地要求（**不可省略**）：走付費代管路徑時，介面與統計列必須明確標示
  **「此功能經由 Fogone 伺服器轉發」**，讓使用者在當下就知道這一次的資料流向；
  且伺服器**永不記錄使用者內容**。
- 首批功能：摘要（spike 3 已確認本地 Summarizer 無法輸出中文，這是它必須上雲或 BYOK 的原因）。
  之後是字典。
- 後端獨立 repo、**可閉源**。擴充端 repo 維持 AGPL-3.0 公開。
- 免費版的呈現：進階功能以**鎖定態＋演示片段**呈現，讓使用者知道它存在、看得到它長什麼樣，
  而不是完全隱藏。不要做成惱人的升級彈窗。
- **不得阻擋內測時程**：內測開門版不含此項，開門後再排。
## #14 [P2] `Translator.availability()` 間歇性偽陰性（#8 那條「未證的尾巴」）
- **現象**：語言包已經裝好、`create()` 立刻就能用，但網頁環境的
  `Translator.availability({ja→zh-Hant})` 回報 `downloadable`。
  content script 的閘門是 `availability === 'available'`（鐵律 5 的落地），
  於是**整站日文被靜默跳過**：實測 `found=405 done=0 skippedPack=31`。
  使用者只看到「這頁沒反應」，popup 也不會示警——因為 popup 在**擴充頁面**環境讀到的是 `available`。
- **實測（2026-08-31，做商店素材時撞到）**：同一時刻、同一個 profile，
  `create()+translate()` 在每個來源都成功（都翻出「這是一個測試。」），但 availability 回報不一致：

  | 來源 | `ja→zh-Hant` |
  |---|---|
  | 擴充頁面 | `available` |
  | ja.wikipedia.org | `downloadable` |
  | developer.mozilla.org | `downloadable` |
  | zenn.dev / example.com | `available` |

  **而且會跳動**：約一分鐘後重測，ja.wikipedia.org 變 `available`，
  原本正常的 ja.wikinews.org、ja.wikibooks.org 變 `downloadable`。
  擴充頁面 `create()` 只花 **150ms** 就回來，證明語言包確實在磁碟上。
- **這推翻了 #8 的結論範圍**：#8 把 `downloadable` 歸因於「全新安裝的安裝尾巴」，
  但這台機器的語言包早就裝好了，而且症狀會來回跳動。
  #8 的複測（連續三次全新 Chrome 都是 `available`）沒有錯，只是沒涵蓋這個情境。
- **已知重現嘗試**：
  - 用 popup 的啟用鈕重裝 → 當下 popup 讀到的已是 `available`，按鈕根本不出現，等於無從補救。
  - 在擴充頁面強制 `create()` 一次（150ms 成功）→ **網頁環境仍持續回報 `downloadable` 超過 27 秒**，
    不是「create 一次就好」那種暖機。
  - 什麼都不做等一分鐘 → 有時自己恢復。**目前沒有可靠的重現步驟**，這是本項最大的障礙。
- **觸發條件假設（都未證）**：(a) 全新安裝的安裝尾巴（#8 的原假設）；
  (b) 語言包被系統清除後的重建期（見 beta-kit 觀察第 10 點）；
  (c) 每個 browser session／每個來源各自初始化。
  跳動的觀察對 (c) 較有利，但**不足以定論**。
- **觀測方式**：統計列的語言包欄位（`availability` 與 `skippedPack`）。
  這正是 #8 的防線留下來的價值——症狀出現時使用者看得到是哪一對卡住、卡在什麼狀態。
  內測回報「日文頁沒翻」時，第一件事就是看統計列截圖的這兩個欄位。
- **不擋任何批次**：防線（#8 已實作的逐對顯示）已在，最壞情況是使用者困惑而不是資料出錯。
  修法方向牽涉鐵律 5 的邊界（content script 能不能在 `downloadable` 時直接 `create()`），
  要動之前先把重現條件釘死，否則改了也不知道有沒有修好。
- 相關：#8（原假設與已實作的防線）、beta-kit 觀察第 6 點（新安裝族群最可能復現）與第 10 點（語言包被清除）。

## #15 [P1] M3 PDF 文字層雙語（5a 已完成）
偵察報告：`docs/research/pdf-text-layer.md`。方案定案：手動入口＋重排閱讀模式。

- **5a 檢視器殼**：✅ 已完成（commit `ed5cb74`）。
- **5b 段落重建**：分帶中縫偵測、行尾接續（中英規則）、連字號、頁首頁尾去重、
  旋轉文字剔除、公文編號前綴斷段、流程圖垃圾段落過濾。三份 PDF 建 fixture 進 Vitest。
  驗收：雙欄中縫 ≥ 10/12 頁、公文 `(五)(六)` 正確分段、白皮書零垃圾段落進引擎、輸出接續率量測。
- **5c 雙語渲染**：重排頁面走現有 scheduler／engine／cache，統計列增 PDF 欄位。
  驗收：三份 PDF 雙語可讀、`done == engineCalls + cacheHits`。
- **5d 收尾**：大檔效能（arXiv 12 頁流暢）、錯誤處理、`scripts/verify-pdf.mjs`。
  - **錯誤訊息必須點名「網站存取權」設定**：使用者可在擴充選單把存取權改成
    「點按時」或「特定網站」（chrome://extensions 詳細頁的三選一，實測文字為
    「點按時／特定網站／所有網站」）。改成「點按時」之後檢視器抓 PDF 會失敗，
    而瀏覽器只給得出 `TypeError: Failed to fetch` ——照抄那句話等於把使用者丟在原地。
    訊息要直接說明是哪個設定、在哪裡改。
- **自動接管（B 案）**：日後做成**預設關閉**的選項，不在本批。
