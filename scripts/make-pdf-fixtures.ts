// scripts/make-pdf-fixtures.ts — 產生 5b 的測試 fixture
// 用法：node scripts/make-pdf-fixtures.ts
//
// fixture 存的是**文字層 JSON**，不是 PDF 本身。理由有三：
//   1. 測試要跑得快、跑得穩——不必在 CI 裡跑 PDF.js，也不會因為網路而失敗
//   2. 不必把第三方 PDF（論文、政府公文）複製進版本庫再散布出去
//   3. 檔案小得多
// 代價是「重新產生」需要原始 PDF；本腳本會自己下載到 .pdf-fixtures/（已 gitignore）。
//
// 轉換邏輯與檢視器共用 lib/pdf/items.ts 的 toTextItems()——各寫一份的話，
// fixture 遲早與正式路徑不一致，測試就會開始保護錯的東西。
import fs from 'node:fs';
import path from 'node:path';
import { toTextItems, type PageText } from '../lib/pdf/items.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, '.pdf-fixtures');
const OUT = path.join(ROOT, 'test/fixtures');

/** 三份測試文件。挑選理由見 docs/research/pdf-text-layer.md。 */
const SOURCES = [
  { name: 'arxiv-2col', url: 'https://arxiv.org/pdf/1512.03385',
    note: 'ResNet 論文：雙欄，含跨欄表格與圖' },
  { name: 'gov-han', url: 'https://www.archives.gov.tw/wSite/public/Attachment/0/f1716447937805.pdf',
    note: '中文公文：直排裝訂線、條目編號、寬行距' },
  { name: 'whitepaper', url: 'https://bitcoin.org/bitcoin.pdf',
    note: '技術白皮書：單欄，含流程圖並排標籤' },
];

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

for (const src of SOURCES) {
  const file = path.join(CACHE, `${src.name}.pdf`);
  if (!fs.existsSync(file)) {
    process.stdout.write(`下載 ${src.name}… `);
    const res = await fetch(src.url);
    if (!res.ok) { console.error(`失敗 HTTP ${res.status}`); process.exit(1); }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('完成');
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  const pages: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      pageNumber: p,
      // 座標留兩位小數就夠比對版面了，全精度只是讓 fixture 變大
      width: round(viewport.width),
      height: round(viewport.height),
      items: toTextItems(content.items).map((i) => ({
        ...i, x: round(i.x), y: round(i.y), width: round(i.width), height: round(i.height),
      })),
    });
    page.cleanup();
  }

  const target = path.join(OUT, `${src.name}.json`);
  fs.writeFileSync(target, `${JSON.stringify({ source: src.url, note: src.note, pages })}\n`);
  const kb = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`${src.name}: ${doc.numPages} 頁、${pages.reduce((a, p) => a + p.items.length, 0)} 個片段 → ${kb} KB`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
