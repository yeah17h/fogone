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
          sendResponse({ ok: true, active: session !== null });
          return;
        }
      }
    });
  },
});
