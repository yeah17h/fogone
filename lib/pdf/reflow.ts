// lib/pdf/reflow.ts — 把 PDF 文字層還原成可翻譯的段落。
//
// 為什麼這一步值得一個獨立批次：抽字很容易，**還原段落很難**，而且錯法很安靜。
// 每個規則底下的註解都對應 docs/research/pdf-text-layer.md 的一項實測，
// 想改門檻請先去看那份數據，不要憑感覺調。
import type { PageText, TextItem } from './items';

export type Paragraph = {
  /** 來源頁碼（1 起算）。同一段不會跨頁——跨頁接續留到之後再說。 */
  page: number;
  text: string;
};

/** 眾數：拿來估「主文字級」與「常態行距」，比平均數耐得住標題與圖說的干擾。 */
function modal(values: readonly number[], bucket = 0.5): number {
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  let best = 0, bestN = 0;
  for (const v of values) {
    const k = Math.round(v / bucket) * bucket;
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

/**
 * 在一組 item 裡找垂直空白帶（中縫）。
 * 回傳中縫中心的 x，找不到回 null。
 */
function gutterIn(items: readonly TextItem[], pageWidth: number): number | null {
  // 頁寬異常（NaN／Infinity／負數）會讓 new Array() 直接拋 RangeError。
  // 壞掉的 PDF 不該讓整份文件開不起來，回 null 讓它當單欄處理就好。
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return null;
  const BIN = 3;
  const bins = new Array(Math.ceil(pageWidth / BIN)).fill(0);
  for (const it of items) {
    const a = Math.max(0, Math.floor(it.x / BIN));
    const b = Math.min(bins.length - 1, Math.ceil((it.x + it.width) / BIN));
    for (let k = a; k <= b; k++) bins[k]++;
  }
  let best: { mid: number; width: number } | null = null;
  let run = 0;
  for (let k = 0; k <= bins.length; k++) {
    if (k < bins.length && bins[k] === 0) { run++; continue; }
    if (run * BIN >= 15) {
      const end = k * BIN;
      const mid = end - (run * BIN) / 2;
      // 只認**接近中線**的空白帶。窗口從 0.3~0.7 收到 0.4~0.6 是實測逼出來的：
      // 前者會把跨欄表格頁的 x≈204（0.33）與稀疏參考文獻頁的 x≈414（0.68）
      // 誤判成中縫。學術雙欄的中縫本來就幾乎正中（實測 x≈300 / 612 = 0.49）。
      if (mid > pageWidth * 0.4 && mid < pageWidth * 0.6
          && (!best || run * BIN > best.width)) best = { mid, width: run * BIN };
    }
    run = 0;
  }
  return best?.mid ?? null;
}

/**
 * 分帶偵測中縫。
 *
 * **不能整頁一次算**：任何跨欄元素（實測是 ResNet 論文 p3 的 Table 1、跨欄圖）
 * 都會把中縫填平，整頁法在 12 頁裡只成功 1 頁。把頁面切成水平帶各自偵測、
 * 取多數共識，同一份文件成功 10 頁。
 */
function detectGutterOnPage(page: PageText): number | null {
  const body = bodyItems(page);
  if (body.length < 12) return null;

  const ys = body.map((i) => i.y);
  const top = Math.max(...ys), bottom = Math.min(...ys);
  // 內容只佔一兩行高時，六條帶會切出完全相同的範圍，同一批 item 被重複投票六次，
  // 於是「六帶共識」根本不是共識。這種頁沒有足夠證據談分欄，直接回 null。
  const unit = modal(body.map((i) => i.height)) || 10;
  if (top - bottom < unit * 3) return null;
  const BANDS = 6;
  const found: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const hi = top - ((top - bottom) * b) / BANDS;
    const lo = top - ((top - bottom) * (b + 1)) / BANDS;
    const seg = body.filter((i) => i.y <= hi && i.y >= lo);
    if (seg.length < 8) continue;
    const g = gutterIn(seg, page.width);
    if (g !== null) found.push(g);
  }
  if (found.length < 2) return null;
  const consensus = modal(found, 6);
  const agree = found.filter((v) => Math.abs(v - consensus) <= 8).length;
  return agree >= 2 ? consensus : null;
}

/**
 * 文件層級的中縫。
 *
 * **中縫是整份文件的版面性質，不是單頁的**：學術雙欄論文每頁欄寬都一樣。
 * 單頁偵測會在圖表密集頁失手——實測 ResNet p5／p11 的六條水平帶裡有三、四條
 * 幾乎沒有正文，湊不出兩帶共識。這種頁不是「不分欄」，只是「證據不足」。
 * 所以先由偵測得到的頁湊出全文共識，再回頭補給證據不足的頁。
 *
 * 補之前一定要驗一次：若該頁有相當比例的 item **橫跨**那條線，
 * 代表它真的是跨欄版面（例如整頁寬的表格），硬套會把它的行切壞。
 */
export function detectGutters(pages: readonly PageText[]): (number | null)[] {
  const own = pages.map(detectGutterOnPage);
  const ratios = own
    .map((g, i) => (g === null ? null : g / pages[i].width))
    .filter((r): r is number => r !== null && Number.isFinite(r));
  if (ratios.length < 2) return own;
  // 共識存**比例**不存絕對座標：同一份文件可能混有不同尺寸的頁（橫向插圖頁之類），
  // 直接共用絕對 x 會把中縫放到錯的地方。
  const ratio = modal(ratios, 0.01);

  return own.map((g, i) => {
    if (g !== null) return g;
    const page = pages[i];
    const docGutter = ratio * page.width;
    const body = bodyItems(page);
    if (body.length < 12) return null;
    // 逐 item 判斷「有沒有橫跨中縫」擋不住跨欄文字——PDF.js 常把一條跨欄標題
    // 拆成好幾個 item，每個都不跨線，整行卻是跨的。所以改在**行**的層級判斷：
    // 把同一行的 item 依 x 排好，看中縫落在哪裡。落在某個 item 身上、
    // 或落在一道窄得不像欄距的縫裡，就算跨欄。
    const lines = groupByBaseline(body);
    if (lines.length === 0) return null;
    const crossing = lines.filter((line) => crossesAt(line, docGutter)).length;
    return crossing / lines.length > 0.05 ? null : docGutter;
  });
}

/** 中縫落在這一行的文字上（而不是落在欄與欄之間的空隙）＝這行是跨欄的。 */
function crossesAt(line: readonly TextItem[], gutter: number): boolean {
  const sorted = [...line].sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    if (it.x <= gutter && it.x + it.width >= gutter) return true;   // 直接壓在中縫上
    const next = sorted[i + 1];
    if (!next) break;
    const gapStart = it.x + it.width;
    if (gapStart <= gutter && next.x >= gutter) {
      // 中縫落在兩個 item 之間：夠寬才算欄距，窄縫代表文字其實是連續的
      return next.x - gapStart < 12;
    }
  }
  return false;
}

/** 座標含 NaN／Infinity 的 item 會汙染排序、分組與所有門檻計算，一律剔除。 */
function finite(i: TextItem): boolean {
  return Number.isFinite(i.x) && Number.isFinite(i.y)
    && Number.isFinite(i.width) && Number.isFinite(i.height);
}

/** 主文字級的 item：剔除旋轉文字，並只留字高接近眾數的那些。 */
function bodyItems(page: PageText): TextItem[] {
  // 旋轉文字＝公文的直排裝訂線、圖軸標籤。它們的座標軸跟正文不同，
  // 混進來會同時汙染中縫偵測與行分組。
  const upright = page.items.filter((i) => !i.rotated && i.str.trim() && finite(i));
  const h = modal(upright.map((i) => i.height));
  return upright.filter((i) => Math.abs(i.height - h) <= h * 0.25);
}

type Line = {
  y: number;
  text: string;
  /** 行內相鄰 item 之間最大的水平空隙。並排標籤會很大，正常行文只有字距。 */
  gapMax: number;
};

/**
 * 把 item 依基線併成行。
 *
 * **不能用 Math.round(y) 當 key**：那等於在整數邊界上切，同一行的兩個片段
 * （y=100.49 與 y=100.51）會被拆成兩行，最後接成 "trans lation"；
 * 反過來兩條真的很近的基線又會被硬併。改成依字高比例的容差群聚。
 */
function groupByBaseline(items: readonly TextItem[]): TextItem[][] {
  if (items.length === 0) return [];
  const unit = modal(items.map((i) => i.height)) || 10;
  const tolerance = Math.max(unit * 0.3, 0.5);
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const groups: TextItem[][] = [];
  let current: TextItem[] = [sorted[0]];
  let reference = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    if (reference - sorted[i].y <= tolerance) current.push(sorted[i]);
    else { groups.push(current); current = [sorted[i]]; reference = sorted[i].y; }
  }
  groups.push(current);
  return groups;
}

/** 把 item 併成行；同一行內依 x 排序後直接相接。 */
function toLines(items: readonly TextItem[]): Line[] {
  const lines: Line[] = [];
  for (const group of groupByBaseline(items)) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    const text = sorted.map((i) => i.str).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let gapMax = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      gapMax = Math.max(gapMax, sorted[i + 1].x - (sorted[i].x + sorted[i].width));
    }
    lines.push({ y: sorted[0].y, text, gapMax });
  }
  return lines;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * 中文公文的條目編號。
 *
 * **非要有這條不可**：實測 `(五)` 與 `(六)` 兩個條目的行距與內文完全相同，
 * 純幾何判斷不可能把它們分開，只能認前綴。
 */
// 阿拉伯數字那一段刻意收緊到「1~2 位數且點後不接數字」：原本的 `\d+[、．.)]`
// 會把正文裡的 "2024. Results improved…" 與 "3.14 is approximately pi"
// 當成新條目而強制斷段。條目編號不會有四位數，小數點後一定接數字。
const NUMBER_PREFIX = /^\s*(?:[（(][一二三四五六七八九十百]+[）)]|[一二三四五六七八九十百]+[、．.]|\d{1,2}[、．)]|\d{1,2}\.(?!\d)|[（(]\d{1,2}[）)]|[①-⑳])/;

/**
 * 行尾連字號。**不能一律吃掉**：
 *   "well-" + "Known behavior"  → 吃掉會變成 "wellKnown"，那是錯的
 *   "See Figure 1 -" + "Introduction" → 那是破折號，不是斷字
 * 只有「字母 ＋ 連字號」而且下一行以小寫字母開頭時，才是真的英文斷字。
 */
const HYPHEN_END = /[-‐‑]$/;
const WORD_HYPHEN_END = /[A-Za-z][-‐‑]$/;

/**
 * 流程圖之類的並排標籤被依 y 併成一行後會變成垃圾單元，實測長這樣：
 *   "TransactionTransactionTransaction Owner 1'sOwner 2'sOwner 3's Public KeyPublic KeyPublic Key"
 *   "HashHashHash VerifyVerify"
 * 特徵是同一個詞在同一行連續重複——那是三個並排方塊，不是句子。
 * 只認「緊鄰重複」，避免誤殺正常行文裡分散出現的重複詞。
 */
function isRepeatedLabels(line: Line, unit: number): boolean {
  const text = line.text;
  // 完全沒有文字的行（座標軸刻度 "0123456"、"2020"）沒有東西可翻，
  // 送進引擎純粹浪費。用 \p{L} 而不是 [a-z]：後者會把韓文、希臘文、
  // 西里爾文整行判成「沒有字母」而刪掉。
  if (!/\p{L}/u.test(text)) return true;
  if (CJK.test(text)) return false;              // 中日文沒有這種等寬並排標籤形狀
  // 「有句末標點就當它是句子」不能只看有沒有點：實測 "ItemItem...ItemItem..."
  // 與 "TxTx...TxTx..." 都是流程圖標籤，卻因為省略號裡的點而被整條規則短路放行。
  // 改成認真正的句末形狀——兩個字母＋標點＋空白或結尾。
  if (/[a-z]{2}[.!?](\s|$)/.test(text)) return false;
  // 同一個 4 字元以上的詞緊接著自己重複 ≥1 次（AA、AAA…）。
  // **4 而不是 2**：門檻放到 2 會把 "COCO" 判成「CO 重複」，於是
  // "improvement on the COCO object detection dataset." 這種正文被當垃圾刪掉
  // （實測誤刪 3 行正文）。短標籤（"TxTx..."）交給下面的黏連規則接手。
  if (/\b(\w{4,}(?:\s\w+)?)\1/.test(text)) return true;
  // 「黏連點」：小寫或數字後面直接接大寫，代表本該有空白的地方沒有空白，
  // 例如 "Hash0Hash1Hash2Hash3"、"IdentitiesTransactionsPublic"。
  //
  // **但光看黏連點會誤殺正常文字**："macOS supports iOS through watchOS"
  // 有三個黏連點卻是正常句子。所以要再加一個**結構**條件：
  // 這一行的 item 之間有大到不可能是字距的空隙——那是三個並排方塊
  // 被依 y 併成一行的痕跡。正常行文的 item 是相鄰的。
  const glue = text.match(/[a-z0-9]['\u2019]?[A-Z]/g)?.length ?? 0;
  return glue >= 2 && line.gapMax > unit * 1.5;
}

/** 比對頁首頁尾用的正規化：頁碼會變動，數字一律換成 #。 */
const normKey = (s: string) => s.replace(/\d+/g, '#').replace(/\s+/g, '').trim();

/**
 * 跨頁重複的首尾行＝頁首頁尾。頁碼會變動，正規化成 # 之後才比得出來。
 * 實測：兩份英文文件的末行 6/6 頁都是純頁碼；公文是
 * 「第 # 頁，共 # 頁線上簽核公文列印-第# 頁/共## 頁」。
 */
function chromeLines(pages: readonly PageText[]): Set<string> {
  const counts = new Map<string, number>();
  let sampled = 0;
  for (const page of pages) {
    const lines = toLines(bodyItems(page));
    if (lines.length < 3) continue;
    sampled++;
    // 每頁先去重再計數：同一頁的首行與尾行若正規化後相同（例如兩端都印章節名），
    // 逐次累加會讓它一頁就達到「至少兩頁」的門檻，於是全文的同字串行被誤刪。
    const onThisPage = new Set<string>();
    for (const l of [lines[0], lines[lines.length - 1]]) {
      const k = normKey(l.text);
      if (k) onThisPage.add(k);
    }
    for (const k of onThisPage) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // 門檻不能用「過半數」：公文的頁尾只出現在 5 頁中的 2 頁，而且兩頁的文字
  // 正規化後還不完全相同（實測其中一頁把「1」印成「l」，數字正規化救不了）。
  // 改成「至少兩頁」＋「必須夠短」——重複出現又位在頁首頁尾、而且短，
  // 三個條件疊起來已經足以認定它不是正文。
  const threshold = Math.max(2, Math.ceil(sampled * 0.4));
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= threshold && k.length <= 80) out.add(k);
  return out;
}

/** 依中縫把行分成左右欄，各自由上而下；沒有中縫就整頁由上而下。 */
function orderedLines(page: PageText, gutter: number | null): Line[] {
  // finite() 這裡也要過：只在 bodyItems() 過濾的話，座標壞掉的片段仍會從
  // 這條路徑混進行組裝（實測會把 NaN 那一項黏到正文最前面）。
  const items = page.items.filter((i) => !i.rotated && i.str.trim() && finite(i));
  if (gutter === null) return toLines(items);
  // 依 item 中心點歸欄，再各欄獨立分行——**先分欄再分行**是關鍵：
  // 雙欄版面左右欄共用同一組 y，先分行會把兩欄併成一句（實測會產生
  // "…accuracy gains with" + "ReLU [29] and the biases…" 這種跨欄亂接）。
  const left = items.filter((i) => i.x + i.width / 2 < gutter);
  const right = items.filter((i) => i.x + i.width / 2 >= gutter);
  return [...toLines(left), ...toLines(right)];
}

/** 把下一行接到目前這段後面，依語言決定要不要補空格。 */
function joinInto(current: string, next: string): string {
  if (WORD_HYPHEN_END.test(current) && /^[a-z]/.test(next)) {
    return current.slice(0, -1) + next;                              // 真的斷字：吃掉連字號
  }
  if (HYPHEN_END.test(current)) return `${current} ${next}`;         // 破折號或專名：原樣保留
  if (CJK.test(current.slice(-1)) || CJK.test(next[0] ?? '')) return current + next; // 中日文不補空格
  return `${current} ${next}`;
}

/**
 * 主流程：一疊 PageText → 一串段落。
 */
export function reflow(pages: readonly PageText[]): Paragraph[] {
  const chrome = chromeLines(pages);

  const gutters = detectGutters(pages);
  const out: Paragraph[] = [];
  for (const [index, page] of pages.entries()) {
    const gutter = gutters[index];
    const unit = modal(bodyItems(page).map((i) => i.height)) || 10;
    const lines = orderedLines(page, gutter)
      .filter((l) => !chrome.has(normKey(l.text)))
      .filter((l) => !isRepeatedLabels(l, unit));
    if (lines.length === 0) continue;

    // 斷段門檻用**眾數行距**，不用字高：中文公文行距 21pt、字高 14pt，
    // 用「字高 × 1.8」會把每一行都切成獨立段落（實測 18 行 → 13 段）。
    const gaps: number[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const d = lines[i].y - lines[i + 1].y;
      if (d > 0 && d < 100) gaps.push(d);
    }
    const threshold = (modal(gaps, 0.5) || 12) * 1.5;

    let current = '';
    const flush = () => {
      const t = current.trim();
      if (t.length > 1) out.push({ page: page.pageNumber, text: t });
      current = '';
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      current = current ? joinInto(current, line.text) : line.text;

      const gapBreak = !next || (line.y - next.y) > threshold;
      // 欄與欄之間 y 會突然跳回頁面上方，那不是段落間距，是換欄——一律斷段
      const columnBreak = !!next && next.y > line.y;
      // 條目編號自成一段（見 NUMBER_PREFIX 的說明）
      const numberBreak = !!next && NUMBER_PREFIX.test(next.text);
      if (gapBreak || columnBreak || numberBreak) flush();
    }
    flush();
  }
  return out;
}

/**
 * 診斷用：量「行尾需要接續」的比例。
 * 這個數字是判斷分段器好壞的主要指標之一——實測三份測試文件都在 72~79%，
 * 也就是說斷行是常態，接續規則錯了就會有七成以上的句子被切碎。
 */
export function lineEndStats(pages: readonly PageText[]): {
  needJoin: number; hyphen: number; terminal: number; needJoinRatio: number;
} {
  let needJoin = 0, hyphen = 0, terminal = 0;
  const gutters = detectGutters(pages);
  for (const [index, page] of pages.entries()) {
    const lines = orderedLines(page, gutters[index]);
    for (let i = 0; i < lines.length - 1; i++) {
      const t = lines[i].text.trimEnd();
      if (HYPHEN_END.test(t)) hyphen++;
      else if (/[.!?。！？：:；;」』）)]$/.test(t)) terminal++;
      else needJoin++;
    }
  }
  const total = needJoin + hyphen + terminal;
  return { needJoin, hyphen, terminal, needJoinRatio: total ? needJoin / total : 0 };
}
