// content script：每個分頁一份。收 popup 的訊息，啟動／關閉雙語 session。

import { Session } from '@/lib/scheduler';
import { unmountAll } from '@/lib/renderer';
import { LocalEngine } from '@/lib/engine';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let session: Session | null = null;

    // 開發模式觸發器：讓自動化工具（Claude in Chrome、之後的 Playwright）
    // 不經 popup 直接觸發。正式建置（production）不包含這段。
    if (__YI_TESTING__) {
      window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        const d = e.data as { yi?: string };
        if (d?.yi === 'translate' && !session && LocalEngine.supported()) {
          session = new Session(document);
          const units = session.start();
          console.info(`[譯][dev] translate triggered, units=${units}`);
        } else if (d?.yi === 'off') {
          session?.stop();
          session = null;
          unmountAll(document);
          console.info('[譯][dev] off');
        } else if (d?.yi === 'stats') {
          // 讓 verify.mjs 讀得到統計，才能對照 BACKLOG 用 stats 表述的驗收標準
          window.postMessage({ yi: 'stats:result', stats: session ? { ...session.stats } : null }, '*');
        }
      });
      console.info('[譯][dev] trigger ready: window.postMessage({yi:"translate"}, "*")');
    }

    browser.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
      switch (msg?.type) {
        case 'yi:translate': {
          if (!LocalEngine.supported()) {
            sendResponse({ ok: false, reason: 'no-api' });
            return;
          }
          if (session) {
            sendResponse({ ok: true, already: true, stats: session.stats });
            return;
          }
          session = new Session(document);
          const units = session.start();
          sendResponse({ ok: true, units });
          return;
        }
        case 'yi:off': {
          session?.stop();
          session = null;
          unmountAll(document);
          sendResponse({ ok: true });
          return;
        }
        case 'yi:ping': {
          // isPdf：Chrome 內建 PDF 檢視器裡 content script 進得去，但 DOM 是空的
          // （實測 body 零子節點），所以無從翻譯。document.contentType 是零成本的
          // 判別訊號，popup 靠它決定要不要顯示「用 Fogone 開啟這份 PDF」。
          // 網址由這裡回報而不是讓 popup 讀 tab.url——少依賴一項權限來源。
          sendResponse({
            ok: true,
            active: session !== null,
            isPdf: document.contentType === 'application/pdf',
            url: location.href,
          });
          return;
        }
      }
    });
  },
});
