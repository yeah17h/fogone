# 第三方元件

本擴充的建置產物中包含以下第三方程式碼。全部隨擴充一起打包，
**執行期不從任何遠端載入程式碼，也不因此新增任何對外連線。**

---

## PDF.js（`pdfjs-dist`）

| 項目 | 內容 |
|---|---|
| 版本 | **6.3.289**（`package.json` 以 `--save-exact` 鎖定，不使用範圍指定） |
| 授權 | Apache License 2.0 |
| 著作權 | Copyright Mozilla Foundation and contributors |
| 專案 | https://github.com/mozilla/pdf.js |
| 套件完整性 | `sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==`（記於 `package-lock.json`） |
| 授權全文 | `node_modules/pdfjs-dist/LICENSE` |

用途：解析 PDF 的文字層（`getTextContent()`），供 PDF 雙語閱讀模式使用。

### 打包了什麼、沒打包什麼

| 檔案 | 打包 | 說明 |
|---|---|---|
| `build/pdf.min.mjs`（核心） | ✅ | 經 Vite 打包進檢視器頁面的 chunk |
| `build/pdf.worker.min.mjs`（worker） | ✅ | 以資產形式輸出到 `assets/`，由擴充自身 origin 載入 |
| `cmaps/`（169 個檔案） | ✅ | CJK PDF 若用預先定義的 CMap 而無內嵌 ToUnicode 表，缺了就抽不出正確的字。由 `scripts/sync-pdfjs-assets.mjs` 於建置前從 `node_modules` 複製進 `public/pdfjs/cmaps/` |
| `standard_fonts/` | ❌ | 那是渲染頁面用的字型。重排閱讀模式只抽文字、不畫頁面，實測三份測試 PDF（含中文公文）文字抽取完全正常。省下 816K。日後若做原版式旁欄（會真的渲染頁面）要重新評估 |

### 隔離

PDF.js 只在**檢視器頁面**載入。`lib/pdf/document.ts` 是唯一的接觸點，
其 import 鏈只出現在 `entrypoints/viewer/`。

實測（`npm run build:test`）：加入 PDF.js 後 `content-scripts/content.js`
為 17,371 bytes，其中含 PDF.js 相關符號 **0 處**；
與加入前（17,306 bytes）的差額來自 popup 的 PDF 偵測欄位，與 PDF.js 無關。

### 升版時要一起做的事

1. `npm i --save-exact pdfjs-dist@<新版本>`
2. 更新本檔的版本與完整性雜湊（取自 `package-lock.json`）
3. `npm run build`（`prebuild` 會自動重新同步 cmaps）
4. 重跑 PDF 相關驗證，確認三份測試 PDF 的文字抽取仍正常
