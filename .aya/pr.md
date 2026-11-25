# Commit 訊息

```
docs: 重建基礎研究與第一批決策紀錄

- docs/foundation-research.md：舊專案萃取、28 條踩坑、GitHub 前 5 名比較、
  單字層級互動、資料層與同步、斷詞與首發語言、結論
- docs/decisions/001–006：骨架策略、技術棧、單字層級互動、資料層與同步
  （部分定案）、首發語言（英文）、字典來源（待研究）
- .aya/research.md、.aya/state.md：研究筆記與進度
```

# PR 說明

## 這個 PR 做了什麼
Fogone 重建的第一步：只有研究與決策文件，沒有任何程式碼。

- `docs/foundation-research.md`：七節基礎研究報告（2026-11-25 實查）。
- `docs/decisions/`：Aya 確認過的決策紀錄。
  - 定案：001 不 fork 第三方、以 legacy 核心重建；002 WXT + TypeScript + React 19（僅自有頁面）+ Dexie；003 CSS Custom Highlight API 標生詞、零 DOM 修改取詞；005 第一個語言為英文。
  - 部分定案：004 本機用 IndexedDB；自動跨裝置同步為 MVP 必要功能，同步機制待研究。
  - 待研究：006 字典資料來源。

## 沒有做的事
- 沒有寫程式碼、沒有安裝套件、沒有修改 `legacy/`。

## 下一步
1. 研究同步機制與字典來源（004、006）。
2. 寫 `docs/architecture.md`，拆第一批實作任務。
