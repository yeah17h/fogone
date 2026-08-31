// lib/pdf/document.ts — PDF.js 的唯一接觸點（**只准由檢視器頁面 import**）
//
// 鐵律 3 的延伸：注入網頁的程式一律零框架純 DOM，也不該因為 PDF 功能而變胖。
// PDF.js 有 1.6M，content script 一個位元組都不該碰到它。
// 這個模組的 import 鏈只出現在 entrypoints/viewer/，違反時會在建置產物的
// content-scripts 體積上直接看出來（5a 驗收有量）。
//
// 全部本機打包：worker 用 Vite 的 ?url 產生擴充內的資產網址，cmaps 由
// scripts/sync-pdfjs-assets.mjs 複製進 public/。不從 CDN 載入任何東西，
// 也不新增任何對外連線。
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 一個文字片段，座標已轉成「左上原點、y 向下」的頁面座標系。 */
export type TextItem = {
  str: string;
  /** 左緣 */
  x: number;
  /** 基線 y（PDF 原生是左下原點，這裡沿用，換算交給取用端） */
  y: number;
  width: number;
  height: number;
  /** 旋轉文字（直排裝訂線、圖軸標籤）——重排模式要剔除 */
  rotated: boolean;
};

export type PageText = {
  pageNumber: number;
  width: number;
  height: number;
  items: TextItem[];
};

export type OpenedPdf = {
  numPages: number;
  /** PDF 內嵌的標題，沒有就是 null */
  title: string | null;
  getPageText(pageNumber: number): Promise<PageText>;
  destroy(): Promise<void>;
};

export type PdfSource =
  | { kind: 'url'; url: string }
  | { kind: 'data'; data: ArrayBuffer };

/** 單一 PDF 的位元組上限。超過就拒絕，而不是讓分頁 OOM。 */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * `?url=` 的把關。
 *
 * 這道檢查非做不可：擴充握有全站主機存取權（見 docs/research/pdf-text-layer.md §1.3），
 * 若照單全收地 fetch 任何網址，檢視器就成了一支「替人取用內網資源」的代理——
 * 使用者被誘導開一次 `viewer.html?url=http://127.0.0.1:8080/…`，
 * 我們就替對方探測了普通網頁碰不到的 localhost 與區網設備。
 * 成功／失敗與載入時間本身就是可觀測的訊號，不必真的把內容回傳給攻擊者才算外洩。
 */
export function assertSafePdfUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('網址格式不正確。'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`只接受 http/https 的 PDF 網址（收到 ${u.protocol}）。`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host === '::1' || host === '0.0.0.0'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(fc|fd)[0-9a-f]{2}:/.test(host)   // ULA
    || /^fe80:/.test(host);                // link-local
  if (isPrivate) {
    throw new Error(`基於安全考量，不從本機或區網位址載入 PDF（${u.hostname}）。`);
  }
  return u;
}

/**
 * 確認位元組真的是 PDF。
 *
 * 不能只看 offset 0 的 5 bytes：合法 PDF 允許 `%PDF-` 前面有 BOM 或少量位元組，
 * PDF.js 自己也接受。反過來只比對 `%PDF` 又會放行 `%PDFxxx`。
 * 折衷是在前 1024 bytes 內找 `%PDF-`。
 */
function looksLikePdf(buf: ArrayBuffer): boolean {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 1024)));
  return head.includes('%PDF-');
}

/**
 * 抓取遠端 PDF。**由檢視器頁面自己 fetch，不靠 PDF.js 內建的網路層**——
 * 這樣所有對外請求都看得見、都在我們的控制下，也才對得起「不新增對外連線」的條件。
 */
export async function fetchPdf(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const safe = assertSafePdfUrl(url);
  const res = await fetch(safe.href, { signal, credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error(`抓取失敗：HTTP ${res.status}`);
  // 先看 Content-Length：能擋掉的話就不要先整包下載再說
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
    throw new Error(`檔案過大（${(declared / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
  }
  const type = res.headers.get('content-type') ?? '';
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(`檔案過大（${(buf.byteLength / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
  }
  // 只信任內容本身：有些站台送 application/octet-stream，也有些送 text/html 的錯誤頁
  if (!looksLikePdf(buf)) {
    throw new Error(`這不是 PDF（content-type: ${type || '未提供'}）。`);
  }
  return buf;
}

export async function openPdf(source: PdfSource, signal?: AbortSignal): Promise<OpenedPdf> {
  signal?.throwIfAborted();
  const data = source.kind === 'data' ? source.data : await fetchPdf(source.url, signal);
  // 本機檔案走的是同一條檢查：拖放沒有 accept 過濾，選檔的 accept 也只是提示，
  // 兩邊規則不一致就會出現「網址擋得住、拖進來擋不住」的破口
  if (source.kind === 'data') {
    if (data.byteLength > MAX_PDF_BYTES) {
      throw new Error(`檔案過大（${(data.byteLength / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
    }
    if (!looksLikePdf(data)) throw new Error('這個檔案不是 PDF。');
  }
  signal?.throwIfAborted();

  const task = pdfjs.getDocument({
    // PDF.js 會 detach 傳入的 ArrayBuffer；給它自己的一份，呼叫端還留著原本那份可重試
    data: new Uint8Array(data.slice(0)),
    // 用 location.origin 組，不用 runtime.getURL()：後者的型別只列得出 public/ 裡的
    // 「檔案」，給不出「目錄」路徑，而 PDF.js 要的正是目錄。這個模組只在擴充頁面執行，
    // location.origin 就是擴充自己的 origin，結果完全等價。
    cMapUrl: new URL('/pdfjs/cmaps/', location.origin).href,
    cMapPacked: true,
    // 不渲染頁面就不需要標準字型（見 sync-pdfjs-assets.mjs 的說明）
  });
  // 解析本身沒有 signal 參數，只能在旁邊等：abort 時直接把 task 拆掉，
  // 否則「載入中換一份檔案」會讓舊文件在背景整份解析完才罷休。
  const onAbort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) {
    await task.destroy().catch(() => {});
    signal.throwIfAborted();
  }

  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: unknown } | undefined)?.Title;
    title = typeof t === 'string' && t.trim() ? t.trim() : null;
  } catch { /* metadata 不是必要的，取不到就算了 */ }

  return {
    numPages: doc.numPages,
    title,
    async getPageText(pageNumber) {
      const page = await doc.getPage(pageNumber);
      // finally：getTextContent() 在損壞的 PDF 上會丟錯，走成功路徑釋放的話
      // 那一頁的資源就永遠留在 worker 裡
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: TextItem[] = [];
        for (const raw of content.items) {
          if (!('str' in raw)) continue; // TextMarkedContent，不是文字
          const t = raw.transform as number[];
          if (!raw.str) continue;
          items.push({
            str: raw.str,
            x: t[4],
            y: t[5],
            width: raw.width,
            // height 偶爾是 0（某些字型），用 transform 的縱向縮放當備援
            height: raw.height || Math.abs(t[3]) || 0,
            rotated: Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01,
          });
        }
        return { pageNumber, width: viewport.width, height: viewport.height, items };
      } finally {
        page.cleanup();
      }
    },
    async destroy() {
      await task.destroy();
    },
  };
}
