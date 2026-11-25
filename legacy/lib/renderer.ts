// 渲染器：把譯文以 <x-yi> 自訂元素塞進翻譯單位的尾端。
// 鐵律 4：只加節點，不改原節點、不搬原文字。

import { DONE_ATTR } from './segmenter';

const STYLE_ID = 'yi-style';

export function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    x-yi {
      display: block;
      font: inherit;
      color: inherit;
      opacity: 0.92;
      margin-top: 0.35em;
      padding-left: 0.6em;
      border-left: 2px solid color-mix(in srgb, currentColor 30%, transparent);
      white-space: normal;
    }
    x-yi[data-state='loading'] { opacity: 0.45; }
  `;
  doc.documentElement.appendChild(style);
}

/** 佔位（半透明），翻譯回來後填字 */
export function mountPlaceholder(unit: HTMLElement): HTMLElement {
  const node = unit.ownerDocument.createElement('x-yi');
  node.dataset.state = 'loading';
  node.textContent = '…';
  unit.appendChild(node);
  unit.setAttribute(DONE_ATTR, '1');
  return node;
}

export function fill(node: HTMLElement, translation: string) {
  node.textContent = translation;
  delete node.dataset.state;
}

export function fail(node: HTMLElement) {
  node.remove(); // 失敗就安靜移除，不留殘骸
}

/** 關閉雙語：移除所有譯文節點與標記 */
export function unmountAll(doc: Document) {
  doc.querySelectorAll('x-yi').forEach((n) => n.remove());
  doc.querySelectorAll(`[${DONE_ATTR}]`).forEach((n) => n.removeAttribute(DONE_ATTR));
}
