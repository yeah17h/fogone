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
  const linkText = Array.from(el.querySelectorAll('a'), (a) => a.textContent ?? '').join('').trim();
  if (!linkText) return false;
  if (linkText.length / text.length < 0.9) return false;
  return wordCount(text) <= 2;
}

/**
 * 收集 root 底下的翻譯單位（含 root 自身）。
 * 規則：符合 UNIT_SELECTOR、不在 SKIP_CLOSEST 裡、還沒翻過、
 * 且自身不包含其他翻譯單位（避免外層 <li> 和內層 <p> 重複翻）、
 * 不在頁面外框裡、不是純連結短標籤。
 *
 * root 自身一定要納入：MutationObserver 是把「新增的那個節點」直接傳進來的，
 * 而 querySelectorAll 只找子孫。SPA 直接 append 一個 <p>（Threads 貼文、無限捲動
 * 都是這個形狀）時，那個 <p> 永遠不會被收集——只有外面多包一層容器才會中。
 */
export function collectUnits(root: ParentNode): HTMLElement[] {
  const self = root instanceof HTMLElement && root.matches(UNIT_SELECTOR) ? [root] : [];
  const candidates = [...self, ...root.querySelectorAll<HTMLElement>(UNIT_SELECTOR)];
  const units: HTMLElement[] = [];
  for (const el of candidates) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.hasAttribute(DONE_ATTR)) continue;
    if (el.querySelector(UNIT_SELECTOR)) continue; // 讓最內層的單位去翻
    if (!hasEnoughText(el)) continue;
    if (inPageChrome(el)) continue;
    if (isLinkLabel(el)) continue;
    units.push(el);
  }
  return units;
}

/** 取要送翻的文字（MVP：純文字。行內格式的保留是之後 LLM 引擎的事） */
export function unitText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
