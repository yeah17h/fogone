# PDF 文字層雙語：偵察報告（M3 / Batch 5）

實測日期：2026-08-31。環境：macOS，正式版 Chrome 152，`pdfjs-dist` 6.3.289。
本文只記錄可重現的量測結果與由此推出的取捨，不含產品或商業決策。

範圍：**有文字層的 PDF**。掃描檔 OCR 不在範圍內。

## 測試材料

| 代號 | 來源 | 特性 |
|---|---|---|
| `arxiv-2col` | [arXiv 1512.03385](https://arxiv.org/pdf/1512.03385)（ResNet） | 12 頁，雙欄，含跨欄表格與圖 |
| `gov-han` | [國家發展委員會來函（國家檔案管理局公開附件）](https://www.archives.gov.tw/wSite/public/Attachment/0/f1716447937805.pdf) | 5 頁，中文公文，含直排裝訂線 |
| `whitepaper` | [Bitcoin whitepaper](https://bitcoin.org/bitcoin.pdf) | 9 頁，單欄，含流程圖文字標籤 |

三份都有可用文字層（`getTextContent()` 回傳非空 `str`）。

---

## 一、瀏覽器環境

### 1.1 Chrome 內建 PDF 檢視器：content script 進得去，但看不到內容

導覽到 `https://bitcoin.org/bitcoin.pdf` 後於該分頁量測：

```json
{
  "contentType": "application/pdf",
  "bodyChildCount": 0,
  "innerTextLen": 0,
  "hasEmbed": false,
  "contentScriptRan": true
}
```

content script **有**被注入（收到我們自己的 `[譯]` console 輸出，測試觸發器也回應），
但文件本身是空殼：`document.body` 沒有任何子節點，也沒有 `<embed>`。
PDF 內容在外掛的封閉環境裡，DOM 完全取不到。

**結論**：要在網頁環境做 PDF 雙語，只能走自家檢視器頁面。這與既有認知一致，
但更精確的說法是「注入得進去、但無內容可讀」，而不是「注入不進去」。

### 1.2 `document.contentType` 是零成本的 PDF 偵測訊號

同一組量測中，PDF 分頁的 `document.contentType` 為 `application/pdf`，
一般網頁為 `text/html`。這個屬性 content script 直接可讀，不需要任何額外權限，
也不需要 `webRequest` / `webNavigation` / `declarativeNetRequest`。

### 1.3 權限：`content_scripts` 的 `<all_urls>` 已等同全站主機權限

於擴充頁面量測：

```json
// manifest 宣告
{ "permissions": [], "host_permissions": null,
  "content_scripts.matches": [["<all_urls>"]] }

// Chrome 實際授予
chrome.permissions.getAll() → { "origins": ["<all_urls>"], "permissions": [] }
```

`permissions: []` 指的是不要任何 `chrome.*` API；主機存取權是另一回事，
而且**已經是全站**。安裝警告也已反映這件事。

### 1.4 跨網域抓 PDF：現況即可行，含無 CORS 標頭的伺服器

自擴充頁面 `fetch()`：

| 目標 | `Access-Control-Allow-Origin` | 結果 |
|---|---|---|
| `bitcoin.org/bitcoin.pdf` | 無 | 200，184,292 bytes |
| `archives.gov.tw/…pdf` | 無 | 200，221,354 bytes |
| `arxiv.org/pdf/1512.03385` | `*` | 200，819,383 bytes |

無 CORS 標頭的政府網站也取得完整位元組，因為主機權限已涵蓋（見 1.3），
不受 CORS 限制。**抓取遠端 PDF 不需要新增任何權限。**

### 1.5 `file://`：取決於使用者手動開關，manifest 無法要求

`chrome.extension.isAllowedFileSchemeAccess()` 在本專案的開發 profile 回傳 `true`，
`fetch('file://…pdf')` 成功。但這個開關預設為關，位置在
`chrome://extensions` 的「允許存取檔案網址」，**無法透過 manifest 要求**。

未在全新安裝的 profile 上驗證過預設值（正式版 Chrome 已無 `--load-extension`，
無法自動化安裝到乾淨 profile）。設計上不應假設它是開的。

**規避方式**：檢視器頁提供拖放與檔案選擇器，經由 `File` 物件讀取本機 PDF，
完全不經過 `file://`，因此不受此開關影響。

---

## 二、文字層品質

### 2.1 總量

| | `arxiv-2col` | `gov-han` | `whitepaper` |
|---|---|---|---|
| 分析頁數 | 6 | 5 | 6 |
| text item 數 | 1859（空白 449） | 314（空白 136） | 522（空白 133） |
| 平均字元／item | 19.2 | 10.1 | 40.7 |
| CJK item 占比 | 0% | 75% | 0% |
| 旋轉 item | 3（圖軸、arXiv 側標） | 有（直排裝訂線） | 4（流程圖標籤） |

### 2.2 斷行是常態，不是例外

以行尾型態分類（行尾無終結標點即視為「需接續」）：

| | 需接續 | 連字號斷字 | 句末 | 需接續比例 |
|---|---|---|---|---|
| `arxiv-2col` | 441 | 84 | 80 | **73%** |
| `gov-han` | 71 | 0 | 28 | **72%** |
| `whitepaper` | 186 | 3 | 47 | **79%** |

接續規則中英不同：中日文直接相接（不補空格），英文補一個空格，
行尾連字號要吃掉後再相接。

### 2.3 雙欄：最大的坑，而且天真做法會沉默地產生錯誤內容

雙欄版面中左右欄共用同一組 y 座標，**依 y 分行會把兩欄併成一行**。
`arxiv-2col` p3 的天真重建輸出：

```
"way networks have not demonstrated accuracy gains with
 ReLU [29] and the biases are omitted for simplifying no-
 extremely increased depth (e.g., over 100 layers)…"
```

粗體處是右欄內容插進左欄句子中間。這種錯誤不會拋例外，會直接變成送去翻譯的文字。

**必須先分欄再分行。** 中縫偵測法比較（`arxiv-2col` 全 12 頁）：

| 做法 | 成功頁數 |
|---|---|
| 整頁：把所有 item 的 x 區間塗成覆蓋直方圖，找中央的零覆蓋帶 | **1 / 12** |
| 分帶：先濾成主文字級 item，頁面切 6 條水平帶各自偵測，取多數共識 | **10 / 12** |

整頁法幾乎全滅，因為任何跨欄元素（`arxiv-2col` p3 的 Table 1、跨欄圖）
都會把中縫填平。分帶法失敗的 2 頁是圖表密集頁。

單欄文件應偵測不到中縫：`gov-han` 0/5 頁、`whitepaper` 1/9 頁
（該 1 頁是稀疏的參考文獻頁，屬偽陽性，寬度 399pt 明顯不合理，可用寬度上限排除）。

### 2.4 中文公文：兩個幾何判斷解不掉的問題

**行距寬**。眾數字高 14pt、眾數行距 21pt。用「間距 > 字高 × 1.8」判斷斷段會把
**每一行都切成獨立段落**。改用「該頁眾數行距 × 1.5」後才正確接續。

**編號條目**。改對之後又過頭：`(五)` 與 `(六)` 兩個條目行距與內文完全相同，
被黏成同一段。純幾何判斷不可能分開，必須辨識 `一、` `(五)` `1.` 這類編號前綴
作為段落起點。

### 2.5 流程圖標籤會變成垃圾翻譯單元

`whitepaper` p2 的重建輸出包含：

```
"TransactionTransactionTransaction Owner 1'sOwner 2'sOwner 3's Public KeyPublic KeyPublic Key"
"HashHashHash VerifyVerify"
"SignSign Owner 1'sOwner 2'sOwner 3's Private KeyPrivate KeyPrivate Key"
```

這些是流程圖中三個並排方塊的標籤，被依 y 併成一行。若不過濾會被送進翻譯引擎，
浪費呼叫也產生無意義譯文。

### 2.6 頁首頁尾雜訊

把數字正規化為 `#` 後統計跨頁重複的首行／末行：

- `arxiv-2col`：末行 6/6 頁為 `"#"`（純頁碼）
- `whitepaper`：末行 6/6 頁為 `"#"`
- `gov-han`：`"第 # 頁，共 # 頁線上簽核公文列印-第# 頁/共## 頁"`

跨頁重複比例達半數以上即可判定為頁首頁尾並剔除。

---

## 三、雙語呈現的兩種版面

### 3.1 原版式旁註在 1:1 比例下物理上不成立

| | 眾數字高 | 眾數行距 | 行間淨空隙 | 插入同級譯文需要 |
|---|---|---|---|---|
| `arxiv-2col` | 10pt | 12pt | **2pt** | 10pt |
| `gov-han` | 14pt | 21pt | **7pt** | 14pt |
| `whitepaper` | 10pt | 12pt | **2pt** | 10pt |

行間插入一律放不下。頁邊也不夠：外側頁邊約 50pt（`arxiv-2col`）、
57pt（`gov-han`）、108pt（`whitepaper`），換算同字級中文分別只有
**5 / 4 / 10 字一行**。

可行的變體只有三個：大幅縮小譯文字級（中文可讀性差）、改成 hover 浮出
（那是查詢，不是對照）、或**把畫布加寬、在渲染頁面旁邊另闢一欄**。

### 3.2 兩案取捨

| | 原版式（頁面旁加一欄） | 重排閱讀模式 |
|---|---|---|
| 版式保真 | 完整，圖表公式位置不變 | 全失，圖表需另外處理或省略 |
| 對照精度 | 需把譯文對齊來源段落 y 座標，雙欄還要對到正確欄 | 天然對齊 |
| 與現有架構距離 | 遠，需要新的定位層 | 近，段落重建後即為文字串，可沿用既有渲染思路 |
| 段落重建出錯時 | 譯文貼錯位置，錯誤刺眼 | 讀起來怪但不錯位 |
| 窄視窗 | 差 | 好 |

因 2.3–2.5 顯示段落重建必然存在誤差，**重排模式對重建誤差的容忍度較高**。

---

## 四、PDF.js 體積

| 檔案 | 大小 |
|---|---|
| `build/pdf.min.mjs` | 448K |
| `build/pdf.worker.min.mjs` | 1.2M |
| `cmaps/`（CJK PDF 需要） | 1.6M |
| `standard_fonts/` | 816K |

對照：目前擴充建置產物 236K。核心＋worker＋cmaps 約 3.2M。
重排模式不渲染頁面，`standard_fonts/` 是否可省需實測確認。

---

## 五、由本報告推出的方案結論

- 入口採**手動**：content script 以 `document.contentType` 偵測 PDF 分頁並回報 popup，
  由 popup 提供進入自家檢視器的入口。自動接管技術上可行且同樣零新權限
  （content script 內 `location.replace()`），但整頁替換與「只加不改」的
  零破壞原則有張力，且會造成重複下載，故列為日後預設關閉的選項。
- 本機 PDF 走檢視器的拖放／檔案選擇器，不依賴 `file://` 權限。
- 呈現先做**重排閱讀模式**，原版式旁欄列為第二階段。

## 重現方式

偵察腳本未進版本庫（一次性探測，非專案工具）。量測方法已完整記述於本文各節：
以 `pdfjs-dist` 的 `getDocument().getPage().getTextContent()` 取得 item，
由 `transform[4]`／`transform[5]` 取 x／y，`width`／`height` 取尺寸，
`transform[1]`／`transform[2]` 非零判定旋轉。
