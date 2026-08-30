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

## #3 [P1] Zenn 日文頁零譯文（原因未定）
- 現象：整頁無譯文；當次未留統計行，無法定位是未觸發、分段、語言判斷還是引擎層。
- 第一步：複測拿統計行（找到／完成／失敗／各類跳過），再定位修法。
- 驗收：Zenn 文章正文段落出現 ja→zh-Hant 雙語。

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
