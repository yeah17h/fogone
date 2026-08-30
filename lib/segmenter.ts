// 分段器：把頁面切成「翻譯單位」＝含有可讀文字的塊級元素。
// 全專案最值得寫測試的模組（之後用真實網頁 HTML 當 fixture 進 Vitest）。

const UNIT_SELECTOR = [
  'p', 'li', 'dd', 'dt', 'blockquote', 'figcaption', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'pre + p',
].join(',');

/** 這些容器裡的內容一律不翻（鐵律 4：不碰輸入、不碰程式碼） */
const SKIP_CLOSEST = [
  'pre', 'code', 'kbd', 'samp', 'script', 'style', 'noscript',
  'textarea', 'input', 'select', '[contenteditable]', 'x-yi',
  '[data-yi-skip]',
].join(',');

/**
 * 頁面外框（#1）：導覽、頁首、頁尾、側欄。裡面是 UI 標籤不是內文，
 * 翻了既沒用又會把導覽列撐開換行（版面破壞＝鐵律 4 的 P0）。
 */
const PAGE_CHROME = [
  'nav', '[role=navigation]', '[role=menubar]', '[role=tablist]',
  '[role=banner]', '[role=contentinfo]',
  'aside', '[role=complementary]',
  'header', 'footer',
].join(',');

/** 內文容器：<header>/<footer> 落在這裡面時是文章自己的標題區／註腳，算內文 */
const MAIN_CONTENT = 'main,[role=main],article,[role=article]';

/**
 * 密度備援掃描的候選標籤（#2）。Threads 這類站把貼文全用 div/span 疊出來，
 * 標準選擇器一個都抓不到，只能從這些泛用容器裡挑出「自己就是一塊文字」的葉層。
 */
const DENSE_CANDIDATE = 'div,span,article,section';

/** 分段策略：standard = 標準選擇器；dense = 加上文字密度備援（#2 的兩段式） */
export type SegmentMode = 'standard' | 'dense';

/**
 * 兩段式分段的四個門檻（#2）。這些是經驗值不是原理值，改之前先重跑
 * Threads 搜尋頁與 BBC／MDN／Zenn，確認「該啟動的啟動、不該啟動的不啟動」。
 *
 * 實測依據（2026-08-30，未登入）：
 *
 *   站          標準選擇器命中   密度命中(葉層)   有無 <article>
 *   BBC             93              —              1
 *   MDN             63              —              0（但 main 齊全）
 *   Zenn            35              —              2
 *   Threads 搜尋     6              23              0
 *   Threads 首頁     5              63              0
 *
 * TRIGGER_MAX_STANDARD_UNITS = 12：取在 Threads(5~6) 與 Zenn(35) 中間，
 *   離兩邊都有兩三倍餘裕。這道閘門同時是 #1 的保險——BBC/MDN 永遠走不到備援路徑，
 *   外框排除不可能被新策略破壞。
 *
 * MIN_DIRECT_TEXT_LENGTH = 12 與 MIN_WORDS = 2 是互補的兩道閘門，各殺一種雜訊：
 *   長度殺時間戳（「6小時」「12小時」長度 ≤ 3）；
 *   詞數殺帳號名與標籤（「scimath_77」「hrswatigupta_official」「github」都是單一 token）。
 *   實測長度門檻單獨用要拉到 20 才乾淨（搜尋頁只剩 8 個），
 *   但配上詞數閘門後 12 就夠乾淨，且保住 17 個候選——召回率高一倍。
 *
 * MIN_DIRECT_TEXT_RATIO = 0.5：確認這一層真的是「文字葉」而不是把文字放在子孫的容器。
 */
export const SEGMENT_TUNING = {
  /** 標準選擇器命中數 ≤ 此值才啟動密度備援 */
  TRIGGER_MAX_STANDARD_UNITS: 12,
  /** 備援單位「自己的」文字最小長度 */
  MIN_DIRECT_TEXT_LENGTH: 12,
  /** 備援單位最少詞數（CJK 一字一詞，見 wordCount） */
  MIN_WORDS: 2,
  /** 自身直接文字佔全部文字的比例下限 */
  MIN_DIRECT_TEXT_RATIO: 0.5,
} as const;

export const DONE_ATTR = 'data-yi-done';

/**
 * 假名。用 Unicode script 屬性而不是碼位區間，一次涵蓋半形片假名（U+FF66–FF9D，
 * 日文網站真的會用，例：東京ﾀﾜｰ）與 Kana Supplement。
 * 附帶好處：U+30FB「・」與 U+30FC「ー」的 script 是 Common 不是 Katakana，會自動排除——
 * 「・」本來就不能當日文證據（中文譯名如「李奧納多・狄卡皮歐」也用它）。
 */
export const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** CJK 表意文字與假名、諺文——這些語言不用空白斷詞，算詞數時一字一詞 */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function hasEnoughText(el: Element): boolean {
  const text = (el.textContent ?? '').trim();
  if (text.length < 3) return false;
  // 至少要有一個字母系字元（拉丁、假名、諺文…），純數字/符號跳過
  return /[\p{L}]/u.test(text);
}

function cjkRatio(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  const cjk = chars.filter((c) => /\p{Script=Han}/u.test(c)).length;
  return cjk / chars.length;
}

/**
 * 已經大半是中文的段落不需要翻。
 * #7：含假名一律不算中文——日文漢字與中文漢字同碼位（U+4E00–9FFF），
 * 只看漢字佔比會把日文正文整段誤判成中文跳掉（Zenn 實測 skippedChinese=6）。
 */
export function looksChinese(text: string): boolean {
  if (KANA.test(text)) return false;
  return cjkRatio(text) > 0.3;
}

/** 詞數：CJK／假名／諺文一字算一詞，其餘按空白切（中日文沒空白，不能只 split） */
function wordCount(text: string): number {
  const cjk = text.match(CJK_CHAR)?.length ?? 0;
  const rest = text.replace(CJK_CHAR, ' ').trim();
  return cjk + (rest ? rest.split(/\s+/).length : 0);
}

/**
 * 這一層 <header>/<footer> 是不是「內文自己的標題區」而不是頁面外框。
 * 判準：往上找最近的「外框或內文容器」，先遇到內文容器才算內文。
 * 只問「有沒有 main/article 祖先」會漏——<main><aside><header> 這種側欄標題也有 main 祖先。
 */
function isContentHeader(box: Element): boolean {
  if (!box.matches('header,footer')) return false;
  const outer = box.parentElement?.closest(`${PAGE_CHROME},${MAIN_CONTENT}`);
  return !!outer && !outer.matches(PAGE_CHROME);
}

/** 這個單位是不是在頁面外框裡（#1） */
function inPageChrome(el: Element): boolean {
  // 逐層往上檢查每一個外框祖先：內文標題區可以放行，但要繼續往上看有沒有真的外框。
  // 只看最近一層會漏 <aside><article><header> 這種側欄相關文章卡——最近一層是內文標題區，
  // 但它整個包在 <aside> 裡，還是側欄。
  let box = el.closest(PAGE_CHROME);
  while (box) {
    if (!isContentHeader(box)) return true;
    box = box.parentElement?.closest(PAGE_CHROME) ?? null;
  }
  return false;
}

/**
 * 純連結的短標籤（Home、Sport、See all…）：是 UI 不是內文（#1）。
 * 門檻取「連結文字佔比 ≥ 0.9 且 ≤2 詞」——正文段落常夾一兩個連結但佔比遠低於 0.9，
 * 而新聞標題雖然整條是連結、詞數卻遠超過 2，兩者都不會被誤殺。
 */
function isLinkLabel(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').trim();
  if (!text) return false;

  // 單位「自己就在 <a> 裡面」時整塊都是連結文字，不必再算佔比。
  // Threads 搜尋頁的關鍵字是 <a><h1>javascript</h1></a>，只看子孫連結會漏掉它（翻成「爪哇」）。
  // 但這條只在單位不在內文容器裡時才成立——<article><a><h1>War ends</h1></a></article>
  // 這種「整條包在連結裡的短標題」是真內文，光憑「在連結裡＋≤2 詞」不足以判它是 UI。
  const wholeUnitIsLink = !!el.closest('a') && !el.closest(MAIN_CONTENT);
  if (!wholeUnitIsLink) {
    const linkText = Array.from(el.querySelectorAll('a'), (a) => a.textContent ?? '').join('').trim();
    if (!linkText) return false;
    if (linkText.length / text.length < 0.9) return false;
  }
  // 詞數閘門仍是最後一道：整條包在 <a> 裡的新聞標題詞數遠超過 2，不會被誤殺
  return wordCount(text) <= 2;
}

/**
 * root 自身 ＋ 子孫中符合 selector 的元素。
 * root 自身一定要納入：MutationObserver 是把「新增的那個節點」直接傳進來的，
 * 而 querySelectorAll 只找子孫。SPA 直接 append 一個 <p>（Threads 貼文、無限捲動
 * 都是這個形狀）時，那個節點永遠不會被收集——只有外面多包一層容器才會中。
 */
function selfAndDescendants(root: ParentNode, selector: string): HTMLElement[] {
  const self = root instanceof HTMLElement && root.matches(selector) ? [root] : [];
  return [...self, ...root.querySelectorAll<HTMLElement>(selector)];
}

/** 這一層「自己的」文字：只算直接子文字節點，不含子孫。密度啟發式的核心量測。 */
function directText(el: Element): string {
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) s += n.nodeValue ?? '';
  }
  return s;
}

/** 標準選擇器的單位 */
export function collectStandardUnits(root: ParentNode): HTMLElement[] {
  const units: HTMLElement[] = [];
  for (const el of selfAndDescendants(root, UNIT_SELECTOR)) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.hasAttribute(DONE_ATTR)) continue;
    // 子孫裡已經有譯文＝這塊翻過了。不擋的話 textContent 會把譯文一起算進去，
    // 於是「翻譯的譯文」會被當成原文再翻一次（SPA 把已翻節點搬到新容器下就會發生）。
    if (el.querySelector('x-yi')) continue;
    if (el.querySelector(UNIT_SELECTOR)) continue; // 讓最內層的單位去翻
    if (!hasEnoughText(el)) continue;
    if (inPageChrome(el)) continue;
    if (isLinkLabel(el)) continue;
    units.push(el);
  }
  return units;
}

/**
 * 密度備援（#2）：從 div/span 裡挑出「自己就是一塊文字」的葉層當單位。
 * 只在標準選擇器抓不到東西時才會被呼叫（見 SEGMENT_TUNING 的觸發門檻）。
 */
export function collectDenseUnits(root: ParentNode): HTMLElement[] {
  const hits: HTMLElement[] = [];
  for (const el of selfAndDescendants(root, DENSE_CANDIDATE)) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.hasAttribute(DONE_ATTR)) continue;
    if (el.querySelector('x-yi')) continue;        // 同標準路徑：已翻過的不再收
    if (el.querySelector(UNIT_SELECTOR)) continue; // 裡面有標準單位，讓標準單位去翻
    // 祖先是標準單位時也不能收：<p>文字<span>更多文字</span></p> 會讓 p 與 span
    // 各自成為單位，兩邊都掛譯文＝同一段翻兩次、還互相巢狀。
    if (el.closest(UNIT_SELECTOR)) continue;
    if (inPageChrome(el)) continue;

    const direct = directText(el).trim();
    if (direct.length < SEGMENT_TUNING.MIN_DIRECT_TEXT_LENGTH) continue; // 殺時間戳
    if (wordCount(direct) < SEGMENT_TUNING.MIN_WORDS) continue;          // 殺帳號名／標籤
    if (!/[\p{L}]/u.test(direct)) continue;

    const total = (el.textContent ?? '').trim().length;
    if (direct.length / Math.max(total, 1) < SEGMENT_TUNING.MIN_DIRECT_TEXT_RATIO) continue;

    hits.push(el);
  }
  // 父子都命中時只留最外層。
  // 留最內層會弄丟祖先「自己的」那段文字——<div>祖先的句子<span>子層句子</span></div>
  // 兩層都可能過門檻，丟掉 div 就等於丟掉「祖先的句子」，那段永遠不會被翻。
  // 留最外層則不會遺漏：祖先的 textContent 本來就涵蓋子層，一次翻完整塊。
  // 用 Set ＋ 往上走訪而不是兩兩 contains()：後者是 O(n²)，
  // 密度備援只在「沒有語意標記」的頁面啟動，那種頁面命中數可能上千。
  const hitSet = new Set(hits);
  return hits.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (hitSet.has(p)) return false; // 有祖先也命中，交給祖先代表這一塊
    }
    return true;
  });
}

/**
 * 取要送翻的文字（MVP：純文字。行內格式的保留是之後 LLM 引擎的事）。
 *
 * 不能直接用 textContent：收集時擋掉「已含譯文」的候選只在那一刻有效，
 * 單位排進佇列後、真正輪到它翻譯之前，SPA 仍可能在它底下插入新節點並先被翻掉。
 * 那時 textContent 會把譯文一起帶進來，等於拿譯文當原文再翻一次。
 * 所以這裡自己走訪文字節點，跳過整個 <x-yi> 子樹。
 */
export function unitText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue ?? '';
      else if (child instanceof Element && child.tagName !== 'X-YI') walk(child);
    }
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}
