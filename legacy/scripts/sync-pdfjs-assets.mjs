// scripts/sync-pdfjs-assets.mjs — 把 PDF.js 的 cmaps 複製進 public/，讓建置一起打包
//
// 為什麼要有這一步：cmaps 是 1.6M 的第三方靜態資料。放進版本庫等於把別人的套件內容
// 複製一份進來，之後升版還要手動同步；改成建置前從 node_modules 複製，
// node_modules 就是唯一來源，版本由 package.json 鎖定。
// public/pdfjs/ 因此列入 .gitignore。
//
// 為什麼需要 cmaps：CJK PDF 若使用預先定義的 CMap（UniGB-UCS2-H 之類）而沒有內嵌
// ToUnicode 表，少了 cmaps 就抽不出正確的字。
//
// 為什麼**不**複製 standard_fonts：那是給「渲染頁面」用的字型。重排閱讀模式只抽文字、
// 不畫頁面，不需要它——省下 816K。若之後做原版式旁欄（會真的渲染頁面），要重新評估。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'node_modules/pdfjs-dist/cmaps');
const DST = path.join(ROOT, 'public/pdfjs/cmaps');

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}——先跑 npm install`);
  process.exit(1);
}

// 用「版本戳記」判斷是否已同步，**不要用檔案數**：升版後檔名或內容全變、
// 數量卻碰巧相同的話，比檔案數會靜默沿用舊 cmaps，症狀是某些 CJK PDF 抽字錯誤，
// 而且建置完全不報錯。版本一致才跳過。
const version = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'),
).version;
const stamp = path.join(DST, '.pdfjs-version');
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) {
  console.log(`pdfjs cmaps 已同步（${version}）`);
  process.exit(0);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
fs.cpSync(SRC, DST, { recursive: true });
fs.writeFileSync(stamp, `${version}\n`);
console.log(`pdfjs cmaps → public/pdfjs/cmaps（${version}，${fs.readdirSync(DST).length - 1} 個檔案）`);
