# repo 公開前檢查清單

公開是**單向動作**：一旦推上去，git 歷史裡的東西就不再收得回來
（即使之後刪檔，歷史仍在別人的 clone 裡）。所以這份清單的重點不是「目前的檔案乾不乾淨」，
而是**「曾經進過版本庫的東西乾不乾淨」**。

每次要公開或大幅改動可見範圍之前重跑一次，把結果貼在對應的 commit 或 issue 裡。

---

## 檢查項目與指令

### 1. 祕密與金鑰

```bash
git ls-files -z | xargs -0 grep -nIE \
  "sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}"
```

### 2. 個資與本機路徑（**要查歷史，不只查現況**）

```bash
git ls-files -z | xargs -0 grep -nIE "yeah17h|/Users/"        # 目前的檔案
git log --pretty=format: --name-only --diff-filter=A | sort -u # 曾經加入過的每一個檔案
git log --format='%an <%ae>' | sort -u                         # commit 作者資訊也會公開
```

commit 的作者 email 同樣是公開資訊。用 GitHub 的 `@users.noreply.github.com`
才不會把真實信箱印在每一個 commit 上。

### 3. 不該進版本庫的東西

`.gitignore` 至少要涵蓋：`node_modules/`、`.output/`、`.wxt/`、`.pw-profile/`、
`reports/`、`.pdf-fixtures/`、`public/pdfjs/`、`.claude/settings.local.json`。

**`.pw-profile/` 特別重要**：那是一個真的 Chrome profile，會有 cookie 與登入態。
本專案刻意不在該 profile 登入任何網站——**少一個要保護的祕密就少一個外洩面**。

專案根目錄若出現非程式檔（營運文件、試算表之類），一律視為未追蹤：不 stage、不 commit。
（實績：曾用 `git add -A` 把使用者的營運文件掃進 docs commit，其中二進位檔到退檔為止
都沒被開啟過。所以本專案禁用 `git add -A` 與 `git add .`。）

### 4. 隨 repo 散布的第三方內容，授權要成立

**fixture 與商店素材都會跟著 repo 散布出去**，不是只有程式碼。

- `test/fixtures/*.json`：第三方 PDF 的**文字層**，不是 PDF 本身
- `store/assets/*.png`：商店截圖，含第三方網頁畫面

每一項都要能講出授權依據（見下方結果表）。**授權會變、網站會關，每次重驗。**

### 5. 對外承諾與程式碼一致

`PRIVACY.md`、`README.md`、`store/listing.md` 講的話要能被程式碼驗證：

```bash
grep -rn "fetch(" entrypoints lib types
grep -rniE "chrome\.storage|localStorage|indexedDB|document\.cookie|analytics|telemetry|sendBeacon" entrypoints lib types
find .output/chrome-mv3 -name "*.js" -o -name "*.mjs" | xargs grep -hoE "https?://[a-zA-Z0-9./_-]+" | sort -u
```

### 6. 正式建置沒有測試痕跡

```bash
npm run build && grep -rl "__YI_TESTING__\|__yiViewer\|yi:.*dev" .output/chrome-mv3/ ; echo "（無輸出＝乾淨）"
```

### 7. 版本一致

`package.json` 的版本、建置產物 `manifest.json` 的版本、README 裡寫的版本要對得起來。

---

## 執行結果（2026-09-10 初次；歷史項於 2026-09-12 補正，v0.2.0）

| # | 項目 | 結果 |
|---|---|---|
| 1 | 祕密與金鑰 | ✅ 追蹤中的檔案零命中 |
| 2 | 個資與本機路徑（現況） | ✅ 追蹤中的檔案零命中 |
| 2 | commit 作者 | ✅ 全部是 `57469517+yeah17h@users.noreply.github.com`，無真實信箱 |
| 2 | **歷史** | ✅ 已於公開前重寫移除，見下方 |
| 3 | `.gitignore` 涵蓋 | ✅ 七項全部涵蓋；`.pw-profile/` 未追蹤且無登入 cookie |
| 3 | 根目錄非程式檔 | ✅ 無 |
| 3 | 歷史中的意外檔案 | ✅ 曾加入過的 51 個檔案全部是程式、文件或刻意納入的素材，無試算表／營運文件 |
| 4 | fixture 授權 | ✅ 三份都成立（見下表） |
| 4 | 商店素材授權 | ✅ 公有領域或 CC BY（無 SA），見 `store/listing.md` |
| 5 | 對外承諾 vs 程式碼 | ✅ 唯一的 `fetch(` 是 PDF 檢視器抓使用者指定的 PDF；無 storage／cookie／遙測；建置產物裡的 URL 全部是 XML namespace、授權網址與 React 錯誤說明，沒有任何端點 |
| 6 | 正式建置測試痕跡 | ✅ `__YI_TESTING__`／`__yiViewer` 零命中 |
| 7 | 版本一致 | ✅ package.json / manifest.json / README 皆為 0.2.0 |

### git 歷史裡的真實信箱 — 已於公開前移除（裁決：重寫歷史）

**問題**：早期的 `skeleton v0.0.4` commit 含 `.claude/settings.local.json`，
其中一行工具設定帶有開發者的真實信箱。該檔稍後已從索引移除並加入 `.gitignore`，
**但歷史仍在**——公開後任何人都讀得到。

**裁決（2026-09-12）：選項 B，公開前把整條路徑自全部歷史移除。**

理由：這與先前「把 commit 作者身分改成 GitHub noreply」是**同一條隱私決策**。
既然已經為了不外流信箱而改寫過作者欄，留著另一處等於前功盡棄——
防線只有全部成立才有意義。而此時尚未 push、無人 clone，
重寫成本趨近於零，且這是**最後一次**成本這麼低的機會：一旦公開就永遠收不回來。
代價是所有 commit hash 改變，在沒有外部 clone 的前提下沒有影響。

被否決的選項 A（接受曝光）留檔：信箱本來就與該 GitHub 帳號關聯，
多一處曝光的邊際傷害有限——但「邊際傷害有限」不是留著它的理由，
在成本趨零時尤其不是。

**執行方式**：`git filter-repo --invert-paths --path .claude/settings.local.json`，
搭配 `--replace-text` 一併清掉**本檔自己早期版本裡引述的那串字面位址**
（本檔在記錄這個問題時把信箱原文抄了進去，只清設定檔而留著這裡，等於白做）。
執行前先 `git clone --mirror . ../yi-backup.git` 留一份可回復的備份。

#### 執行與驗證（2026-09-12）

工具 `git-filter-repo` 2.47.0（`brew install git-filter-repo`）。
備份：`../yi-backup.git`（mirror，35 commits、兩個 tag 齊全，改壞可回復）。

```
git filter-repo --force \
  --invert-paths --path .claude/settings.local.json \
  --replace-text <(echo 'literal:<位址>==>***REMOVED***')
```

| 驗證項 | 指令要旨 | 結果 |
|---|---|---|
| 全史 blob 不含該位址 | 走訪 `rev-list --objects --all` 的每個 blob 逐一 `cat-file` | **0 個 blob 命中**（改寫前為 2） |
| 全史不含該檔案路徑 | 對每個 commit 跑 `ls-tree -r --name-only` 後彙總 | **0 命中** |
| commit 訊息與作者欄 | `log --all --format='%an %ae%n%B'` | **0 命中** |
| `--replace-text` 確實生效 | 在舊版 blob 裡找 `***REMOVED***` | ✅ 找到（證明零命中不是掃描漏看） |
| 工作目錄內容不變 | 改寫前後各取 `git ls-files` 全檔雜湊再彙總 | **`9f5f4152…` 前後完全相同** |
| commit 序列 | 與備份逐條 diff 主旨 | 舊 35 條完全一致；第 36 條是改寫前補記裁決的那個 commit |
| tag 存續 | `cat-file -t` 與 `rev-parse ^{commit}` | `v0.1.0`、`v0.2.0` 皆仍為 annotated tag，指向改寫後對應的 commit（主旨相同） |
| 程式未受影響 | `npm run compile && npm test && npm run build` | ✅ 型別檢查通過、37 測試全過、正式建置零測試痕跡、manifest 0.2.0 |

**兩個 blob 都清掉了**：一個是設定檔本身，另一個是**本檔早期版本**——
它在描述這個問題時把位址原文抄了進去。只清前者而留著後者，等於沒清。
這件事本身值得記著：**寫「某處有祕密」的文件時，不要把那個祕密再抄一遍。**

改寫後所有 commit hash 均已改變。備份 `../yi-backup.git` 在確認 push 無誤前先留著，
之後再刪。

### fixture 授權依據

| fixture | 來源 | 授權依據 |
|---|---|---|
| `arxiv-2col.json` | arXiv:2608.27879v1 | CC BY 4.0（作者選用，允許轉散布） |
| `gov-han.json` | 行政院公文（院臺科字第 1050000364 號，取自 archives.gov.tw） | 中華民國著作權法第 9 條：**公文不得為著作權之標的** |
| `whitepaper.json` | Bitcoin 白皮書（bitcoin.org） | bitcoin.org 站方聲明內容以 **MIT 授權**釋出（2026-09-10 覆核） |

原始 PDF 本身**不進版本庫**（`.pdf-fixtures/` 已 gitignore），
repo 裡只有抽出來的文字層 JSON，由 `node scripts/make-pdf-fixtures.ts` 重新產生。

---

## 狀態：✅ 可公開（2026-09-12，v0.2.0）

12 項檢查全數通過，git 歷史已完成公開前的最後一次清理。
**尚未 push**——等專案擁有者指示。

push 前最後確認一次：遠端 repo 建立時**不要**勾自動產生 README／LICENSE／.gitignore，
以免與既有歷史衝突；第一次推送要連 tag 一起（`git push -u origin main --tags`）。

### 公開時要一起做的事

- [ ] `store/listing.md` 詳細說明最後的「原始碼：TBD」填入 repo 連結
- [ ] `PRIVACY.md` 需要一個公開網址（Chrome 線上應用程式商店的隱私權政策欄位要填 URL）
- [ ] BACKLOG #12（正式 wordmark 與圖示）完成後重產商店素材——
      現行素材沿用佔位圖示配色，商店頁與使用者裝好後看到的圖示會長得不一樣
- [ ] `.claude/settings.json`（只有一行啟用 ponytail 外掛）決定要不要納入版本庫
