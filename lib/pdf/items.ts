// lib/pdf/items.ts — PDF 文字片段的型別與轉換。**純資料，不碰瀏覽器也不碰 PDF.js 執行期。**
//
// 抽出來的理由：檢視器（lib/pdf/document.ts）與 fixture 產生器
// （scripts/make-pdf-fixtures.ts，在 Node 裡跑）要用同一份轉換，
// 各寫一份遲早會不一致——而測試 fixture 一旦與正式路徑不一致，測試就在保護錯的東西。

/** 一個文字片段。座標沿用 PDF 原生的左下原點，y 越大越靠上。 */
export type TextItem = {
  str: string;
  /** 左緣 */
  x: number;
  /** 基線 y */
  y: number;
  width: number;
  height: number;
  /** 旋轉文字（直排裝訂線、圖軸標籤）——重排模式要剔除 */
  rotated: boolean;
};

export type PageText = {
  pageNumber: number;
  width: number;
  height: number;
  items: TextItem[];
};

/** PDF.js 的 TextItem 只用得到這幾個欄位；宣告成結構型別，兩邊都不必依賴 PDF.js 的型別。 */
type RawTextItem = { str: string; width: number; height: number; transform: number[] };

export function toTextItems(raw: readonly unknown[]): TextItem[] {
  const items: TextItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || !('str' in r)) continue; // TextMarkedContent，不是文字
    const it = r as RawTextItem;
    if (!it.str) continue;
    const t = it.transform;
    items.push({
      str: it.str,
      x: t[4],
      y: t[5],
      width: it.width,
      // height 偶爾是 0（某些字型），用 transform 的縱向縮放當備援
      height: it.height || Math.abs(t[3]) || 0,
      rotated: Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01,
    });
  }
  return items;
}
