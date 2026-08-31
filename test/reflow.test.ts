// 5b 驗收：段落重建。
// 每個 describe 對應 BACKLOG #15 的一條驗收標準，數據來源見
// docs/research/pdf-text-layer.md。fixture 由 scripts/make-pdf-fixtures.ts 產生。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectGutters, lineEndStats, reflow } from '@/lib/pdf/reflow';
import type { PageText } from '@/lib/pdf/items';

const load = (name: string): PageText[] =>
  JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')).pages;

const arxiv = load('arxiv-2col');
const gov = load('gov-han');
const whitepaper = load('whitepaper');

// 合成輸入的建構子：真實 fixture 證明整體結果，合成輸入證明個別規則的邊界。
const item = (o: Partial<PageText['items'][0]>) =>
  ({ str: 'x', x: 0, y: 0, width: 10, height: 10, rotated: false, ...o });
const page = (o: Partial<PageText>): PageText =>
  ({ pageNumber: 1, width: 612, height: 792, items: [], ...o });

describe('雙欄中縫偵測', () => {
  it('雙欄論文每一頁都偵測得到中縫', () => {
    // 這份 fixture（CC BY 4.0）通篇雙欄，沒有跨欄表格頁，所以標準是全中。
    // 「跨欄頁不可誤判」的覆蓋改由下面的合成測試負責——那個性質不該綁在
    // 某一篇論文剛好有沒有寬表格上。
    const gutters = detectGutters(arxiv);
    expect(gutters.filter((g) => g !== null).length).toBe(arxiv.length);
  });

  it('偵測到的中縫落在頁面中線附近（雙欄版面的實際位置）', () => {
    detectGutters(arxiv).forEach((g, i) => {
      if (g === null) return;
      expect(g).toBeGreaterThan(arxiv[i].width * 0.35);
      expect(g).toBeLessThan(arxiv[i].width * 0.65);
    });
  });

  it('單欄文件不應該被誤判成雙欄', () => {
    // 公文與白皮書都是單欄。偽陽性比偽陰性糟：誤分欄會把整頁順序打亂。
    expect(detectGutters(gov).filter((g) => g !== null).length).toBe(0);
    expect(detectGutters(whitepaper).filter((g) => g !== null).length).toBe(0);
  });

  it('雙欄頁不會出現左右欄互相插入的句子', () => {
    // 天真做法（依 y 分行、不分欄）會把同一個 y 的左右欄併成一句。
    // 用合成頁直接驗：左欄五行、右欄五行，共用同一組 y。
    // 30 行不是隨便挑的：分帶偵測要求每條帶至少 8 個 item 才願意投票，
    // 頁面太小湊不出證據就會回 null（那是刻意的保守，不是 bug）。
    const rows = 30;
    const pages = [page({ items: [
      ...Array.from({ length: rows }, (_, i) =>
        item({ x: 60, y: 700 - i * 12, width: 200, str: `left${i} sentence continues` })),
      ...Array.from({ length: rows }, (_, i) =>
        item({ x: 330, y: 700 - i * 12, width: 200, str: `right${i} sentence continues` })),
    ] })];
    const text = reflow(pages).map((p) => p.text).join('\n');
    expect(text, '左右欄被交錯併行').not.toMatch(/left\d[^\n]*right\d/);
    expect(text).toContain('left0');
    expect(text).toContain('right0');
  });

  it('整頁寬的表格頁不會被套上文件中縫', () => {
    // 文件層級共識會把中縫補給偵測不到的頁；跨欄的頁必須擋下來，
    // 否則整頁寬的表格列會被從中間切開、順序也跟著亂掉。
    const twoCol = (n: number) => page({ pageNumber: n, items: [
      ...Array.from({ length: 30 }, (_, i) =>
        item({ x: 60, y: 700 - i * 12, width: 200, str: `left ${i}` })),
      ...Array.from({ length: 30 }, (_, i) =>
        item({ x: 330, y: 700 - i * 12, width: 200, str: `right ${i}` })),
    ] });
    // 第三頁是跨欄的：每一行都是一整條橫跨中線的文字
    const fullWidth = page({ pageNumber: 3, items: Array.from({ length: 30 }, (_, i) =>
      item({ x: 60, y: 700 - i * 12, width: 470, str: `full width row ${i}` })) });
    const gutters = detectGutters([twoCol(1), twoCol(2), fullWidth]);
    expect(gutters[0]).not.toBeNull();
    expect(gutters[1]).not.toBeNull();
    expect(gutters[2], '跨欄頁被硬套上中縫').toBeNull();
  });
});

describe('中文公文', () => {
  const paras = reflow(gov);
  const text = paras.map((p) => p.text);

  it('(五) 與 (六) 是兩個獨立段落', () => {
    // 兩者行距與內文完全相同，只能靠編號前綴分開（純幾何判斷做不到）
    const five = text.filter((t) => t.includes('(五)') || t.includes('（五）'));
    const six = text.filter((t) => t.includes('(六)') || t.includes('（六）'));
    expect(five.length).toBeGreaterThan(0);
    expect(six.length).toBeGreaterThan(0);
    // 不可以出現「一段裡同時含 (五) 和 (六)」
    expect(text.filter((t) => /[（(]五[）)]/.test(t) && /[（(]六[）)]/.test(t))).toEqual([]);
  });

  it('條目內文有被接續，不是每行一段', () => {
    // 用字高當門檻會把 18 行切成 13 段。正確接續後，(五) 那條應該是完整長句。
    const five = text.find((t) => /[（(]五[）)]/.test(t));
    expect(five).toBeDefined();
    expect(five!.length).toBeGreaterThan(60);
    expect(five!).toContain('檢討編列');
  });

  it('直排裝訂線不會混進段落', () => {
    // 「裝」「訂」「線」是旋轉文字；混進來會變成 "文稿頁面裝言丁線…" 這種噪音
    expect(text.filter((t) => t.includes('裝訂線') || /裝\s*言\s*丁\s*線/.test(t))).toEqual([]);
  });

  it('頁尾的公文列印資訊被剔除', () => {
    expect(text.filter((t) => t.includes('線上簽核公文列印'))).toEqual([]);
  });
});

describe('技術白皮書', () => {
  const paras = reflow(whitepaper);
  const text = paras.map((p) => p.text);

  it('流程圖的並排標籤不會變成翻譯單元', () => {
    // 用**實際觀察到的**垃圾字串當判準，不要用泛用正則——泛用正則既會漏
    // （"ItemItem...":省略號讓它看起來像句子）也會誤傷正常段落。
    // 兩種形態都要列：PDF 若不輸出空白字元就是黏在一起的樣子，
    // 我們依間距補上空白之後就變成有空白的樣子。只擋一種等於沒擋。
    const known = ['TransactionTransaction', 'Hash0Hash1', 'Tx0Tx1',
                   'IdentitiesTransactions', 'ItemItem', 'TxTx',
                   'Transaction Transaction', 'Owner 1\'s Owner 2\'s',
                   'Prev Hash Nonce Prev Hash Nonce', 'Tx Tx ... Tx Tx'];
    for (const k of known) {
      expect(text.filter((t) => t.includes(k)), `殘留垃圾段落：${k}`).toEqual([]);
    }
  });

  it('正文段落有被完整接起來', () => {
    const opening = text.find((t) => t.startsWith('We define an electronic coin'));
    expect(opening).toBeDefined();
    expect(opening!).toContain('chain of digital signatures');
    // 跨了好幾行，接對了才會有這個長度
    expect(opening!.length).toBeGreaterThan(200);
  });

  it('頁碼頁尾被剔除', () => {
    expect(text.filter((t) => /^\d+$/.test(t.trim()))).toEqual([]);
  });
});

describe('垃圾過濾不得誤傷正文', () => {
  // 迴歸測試：門檻設成「2 字元以上的詞重複」時，"COCO" 會被判成「CO 重複」，
  // 這三行正文因此被整行刪掉。任何調整垃圾規則的人都會先撞到這裡。
  it('字內含重複音節的正文不被當成重複標籤刪掉', () => {
    // "COCO" 是 "CO" 重複兩次。重複規則的單位門檻若放到 2 個字元，
    // 整行正文會被當標籤刪掉（實測在舊 fixture 上誤刪 3 行）。
    const pages = [page({ items: [
      item({ x: 60, y: 700, width: 300, str: 'improvement on the COCO object detection dataset' }),
    ] })];
    expect(reflow(pages).map((p) => p.text))
      .toEqual(['improvement on the COCO object detection dataset']);
  });

  it('座標軸刻度之類的純數字行不進引擎', () => {
    const all = reflow(arxiv).map((p) => p.text);
    expect(all.filter((t) => /^[\d\s.,%-]+$/.test(t))).toEqual([]);
  });
});

describe('英文斷字與接續', () => {
  it('行尾連字號被接回成完整單字', () => {
    // 這份 fixture 裡 "relation-" / "distinguish-" / "discrimina-" 都跨行斷字。
    const all = reflow(arxiv).map((p) => p.text).join('\n');
    for (const word of ['relationships', 'distinguishing', 'discriminative']) {
      expect(all, `斷字沒有接回：${word}`).toContain(word);
    }
  });

  it('懸空連字號（pose- and skeleton-based）不會被吃掉', () => {
    // 這是正確的英文，不是斷字。一律吃掉連字號會把它變成 "poseand"。
    const all = reflow(arxiv).map((p) => p.text).join('\n');
    expect(all).toContain('pose- and skeleton-based');
  });

  it('中日文接續不補空格', () => {
    const paras = reflow(gov).map((p) => p.text);
    expect(paras.filter((t) => /[一-鿿]\s[一-鿿]/.test(t))).toEqual([]);
  });
});

describe('行尾接續率（診斷指標，不是門檻）', () => {
  it.each([
    ['arxiv-2col', arxiv],
    ['gov-han', gov],
    ['whitepaper', whitepaper],
  ])('%s 的接續率落在偵察量到的範圍', (_name, pages) => {
    const s = lineEndStats(pages);
    // 偵察實測 72~79%。落在 0.5~0.95 之外代表分行或排序壞了，值得停下來看。
    expect(s.needJoinRatio).toBeGreaterThan(0.5);
    expect(s.needJoinRatio).toBeLessThan(0.95);
  });
});

// ── 合成輸入的迴歸測試 ────────────────────────────────────────────────
// 真實 PDF 的 fixture 證明「整體結果對」，但證不了個別規則的邊界；
// 而且「斷言某個壞字串不存在」在規則寫錯的方向上會假性通過。
// 以下每一則都對應一個具體的錯誤輸入。

describe('邊界輸入', () => {
  it('壞掉的頁面尺寸不會讓整份文件開不起來', () => {
    for (const width of [NaN, Infinity, -1, 0]) {
      const pages = [page({ width, items: Array.from({ length: 20 },
        (_, i) => item({ x: i * 20, y: 700 - i * 12, str: `w${i}` })) })];
      expect(() => reflow(pages)).not.toThrow();
      expect(detectGutters(pages)).toEqual([null]);
    }
  });

  it('座標是 NaN 的片段被剔除，不會汙染排序', () => {
    const pages = [page({ items: [
      item({ y: NaN, str: '壞' }), item({ y: 700, str: '好的內容' }),
    ] })];
    expect(reflow(pages).map((p) => p.text)).toEqual(['好的內容']);
  });

  it('只有一兩行的頁面不會被判成雙欄', () => {
    // 六條帶會切出同一個範圍，同一批 item 被重複投票六次——那不是共識。
    const pages = [page({ items: [
      ...Array.from({ length: 8 }, (_, i) => item({ x: 20 + i * 25, y: 100 })),
      ...Array.from({ length: 8 }, (_, i) => item({ x: 400 + i * 20, y: 100 })),
    ] })];
    expect(detectGutters(pages)).toEqual([null]);
  });

  it('同一基線的片段不會因為捨入邊界被拆開', () => {
    const pages = [page({ items: [
      item({ y: 100.49, x: 0, width: 25, str: 'trans' }),
      item({ y: 100.51, x: 25, width: 30, str: 'lation' }),
    ] })];
    expect(reflow(pages).map((p) => p.text)).toEqual(['translation']);
  });
});

describe('接續與斷段的細節', () => {
  const twoLines = (a: string, b: string) => reflow([page({ items: [
    item({ y: 700, str: a }), item({ y: 688, str: b }),
  ] })]).map((p) => p.text);

  it('真正的英文斷字才吃掉連字號', () => {
    expect(twoLines('im-', 'provement follows')).toEqual(['improvement follows']);
  });

  it('專有名詞後的連字號不會被吃掉', () => {
    // "well-" + "Known" 若一律吃掉會變成 "wellKnown"
    expect(twoLines('well-', 'Known behavior')).toEqual(['well- Known behavior']);
  });

  it('正文裡的年份或小數不會被當成條目編號而斷段', () => {
    expect(twoLines('published in', '2024. Results improved')).toEqual(
      ['published in 2024. Results improved']);
    expect(twoLines('the value', '3.14 is approximately pi')).toEqual(
      ['the value 3.14 is approximately pi']);
  });

  it('中文條目編號仍然斷段', () => {
    expect(twoLines('前一條的結尾。', '(六)本案未來之計畫推動')).toHaveLength(2);
  });
});

describe('不得誤刪非拉丁文字', () => {
  it('韓文不會因為「沒有字母」而被整行刪除', () => {
    const pages = [page({ items: [item({ str: '안녕하세요 반갑습니다' })] })];
    expect(reflow(pages).map((p) => p.text)).toEqual(['안녕하세요 반갑습니다']);
  });

  it('正常的 camelCase 句子不會被當成流程圖標籤', () => {
    // 黏連點有三個，但 item 是相鄰的——沒有並排方塊的空隙特徵
    const pages = [page({ items: [item({ str: 'macOS supports iOS through watchOS', width: 200 })] })];
    expect(reflow(pages).map((p) => p.text)).toEqual(['macOS supports iOS through watchOS']);
  });
});

describe('頁首頁尾判定', () => {
  it('同一頁首尾相同的行，不會只憑一頁就被當成跨頁頁首頁尾', () => {
    const mk = (n: number, top: string, bottom: string) => page({ pageNumber: n, items: [
      item({ y: 740, str: top }),
      item({ y: 700, str: `第 ${n} 頁的正文內容，這一段應該留下來。` }),
      item({ y: 60, str: bottom }),
    ] });
    // 只有 p1 的首尾都是 Introduction；其他頁沒有。不該因此把它當 chrome。
    const out = reflow([mk(1, 'Introduction', 'Introduction'), mk(2, 'Body', 'Footer text')]);
    expect(out.map((p) => p.text)).toContain('Introduction');
  });
});
