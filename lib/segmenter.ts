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

export const DONE_ATTR = 'data-yi-done';

function hasEnoughText(el: Element): boolean {
  const text = (el.textContent ?? '').trim();
  if (text.length < 3) return false;
  // 至少要有一個字母系字元（拉丁、假名、諺文…），純數字/符號跳過
  return /[\p{L}]/u.test(text);
}

function cjkRatio(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  const cjk = chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
  return cjk / chars.length;
}

/** 已經大半是中文的段落不需要翻 */
export function looksChinese(text: string): boolean {
  return cjkRatio(text) > 0.3;
}

/**
 * 收集 root 底下的翻譯單位。
 * 規則：符合 UNIT_SELECTOR、不在 SKIP_CLOSEST 裡、還沒翻過、
 * 且自身不包含其他翻譯單位（避免外層 <li> 和內層 <p> 重複翻）。
 */
export function collectUnits(root: ParentNode): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(UNIT_SELECTOR);
  const units: HTMLElement[] = [];
  for (const el of candidates) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.hasAttribute(DONE_ATTR)) continue;
    if (el.querySelector(UNIT_SELECTOR)) continue; // 讓最內層的單位去翻
    if (!hasEnoughText(el)) continue;
    units.push(el);
  }
  return units;
}

/** 取要送翻的文字（MVP：純文字。行內格式的保留是之後 LLM 引擎的事） */
export function unitText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}
