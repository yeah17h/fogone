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
import { toTextItems, type PageText } from './items';

export type { TextItem, PageText } from './items';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
function isPrivateIPv4(host: string): boolean {
  return host === '0.0.0.0'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * IPv6 字面量裡藏的 IPv4。**非查不可**：`http://[::ffff:127.0.0.1]/` 會被
 * URL 正規化成 `[::ffff:7f00:1]`——長得完全不像 127.0.0.1，卻連到同一個地方。
 * 只比對 `::1` 的話這條路是敞開的。
 * 回傳點分十進位，認不出來就回 null。
 */
function embeddedIPv4(host: string): string | null {
  // `::ffff:127.0.0.1`（IPv4-mapped）與 `::127.0.0.1`（已廢棄的 IPv4-compatible）
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return dotted[1];
  // 正規化後的十六進位形式：`::ffff:7f00:1`／`::7f00:1`
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/**
 * 私網／本機位址。
 *
 * 已知且無法在這一層解決的限制：**這裡看的是主機名字，不是它解析到哪裡**。
 * 一個公開網域大可指向 127.0.0.1，DNS 查詢在瀏覽器內部完成，我們看不到結果。
 * 要真的防住得在請求送出前攔截（`declarativeNetRequest`／`webRequest`），
 * 而本擴充刻意不要任何 `chrome.*` 權限。這條防線擋的是「照著網址就能做到」的那一類。
 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isPrivateIPv4(host)) return true;
  if (!host.includes(':')) return false;          // 剩下的判斷只對 IPv6 字面量有意義
  if (host === '::' || host === '::1') return true;
  const v4 = embeddedIPv4(host);
  if (v4 && isPrivateIPv4(v4)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;    // ULA fc00::/7
  // link-local 是 fe80::/10，涵蓋 fe80~febf——只比對 `fe80:` 會漏掉 fe90::、feaf:: 之類
  return /^fe[89ab][0-9a-f]:/.test(host);
}

export function assertSafePdfUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('網址格式不正確。'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`只接受 http/https 的 PDF 網址（收到 ${u.protocol}）。`);
  }
  if (isPrivateHost(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) {
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
 * fetch 丟 `TypeError: Failed to fetch` 時的說明。
 *
 * **照抄那句話等於把使用者丟在原地。** 這裡最常見的原因不是網路壞掉，
 * 而是擴充的「網站存取權」被使用者（或安裝時的預設）設成「點按時」——
 * 那之後檢視器頁面就沒有該來源的權限，fetch 一定失敗，而瀏覽器只給得出那一句話。
 * 訊息要直接說明是哪個設定、在哪裡改。
 */
const FETCH_FAILED_HINT =
  '抓不到這個網址的檔案。最常見的原因是擴充的「網站存取權」被設成「點按時」或'
  + '「在特定網站上」：請開啟 chrome://extensions →「幾個譯思 Fogone」→「詳細資料」'
  + '→「網站存取權」，改成「在所有網站上」，再重新開啟這份 PDF。'
  + '（若設定本來就是「在所有網站上」，那就是這個網址連不上或伺服器拒絕跨來源存取。）';

/**
 * 抓取遠端 PDF。**由檢視器頁面自己 fetch，不靠 PDF.js 內建的網路層**——
 * 這樣所有對外請求都看得見、都在我們的控制下，也才對得起「不新增對外連線」的條件。
 */
export async function fetchPdf(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const safe = assertSafePdfUrl(url);
  let res: Response;
  try {
    res = await fetch(safe.href, { signal, credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    if (signal?.aborted) throw e;  // 是我們自己取消的，不要把它講成權限問題
    // 整台機器離線時把原因講成權限設定是誤導——那會讓使用者去改一個沒問題的設定。
    if (navigator.onLine === false) throw new Error('目前沒有網路連線，無法抓取這個網址的 PDF。');
    throw new Error(FETCH_FAILED_HINT);
  }
  // **重新導向之後要再驗一次**：assertSafePdfUrl() 只看得到最初的網址，
  // 而 redirect: 'follow' 會乖乖跟著 30x 走——一個公開網址可以把我們導到
  // 127.0.0.1 或區網位址，私網防線等於形同虛設。
  // 已知殘留風險：這裡擋得住「把內網內容讀進來顯示」，但擋不住請求本身已經送出。
  // 要在送出前就擋，得用 declarativeNetRequest／webRequest 這類權限，
  // 而本擴充刻意不要任何 chrome.* 權限（見 wxt.config.ts），所以停在這一層。
  if (res.url && res.url !== safe.href) assertSafePdfUrl(res.url);
  if (!res.ok) throw new Error(`抓取失敗：伺服器回應 HTTP ${res.status}。`);
  // 先看 Content-Length：能擋掉的話就不要先整包下載再說
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) {
    throw new Error(`檔案過大（${(declared / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
  }
  const type = res.headers.get('content-type') ?? '';
  // fetch() 收到 headers 就 resolve 了，**檔案還沒下載完**。中途斷線會在這裡丟出
  // 原始的英文 TypeError，不接住的話使用者又會看到 "Failed to fetch" 那種話。
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('下載到一半中斷了，請再試一次。');
  }
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(`檔案過大（${(buf.byteLength / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
  }
  // 只信任內容本身：有些站台送 application/octet-stream，也有些送 text/html 的錯誤頁
  if (!looksLikePdf(buf)) {
    throw new Error(`這不是 PDF（content-type: ${type || '未提供'}）。`);
  }
  return buf;
}

/**
 * PDF.js 解析失敗的訊息。原文是英文而且對一般使用者沒有意義
 * （"Invalid PDF structure."、"No password given"），照抄等於沒說明。
 * 以 `name` 分辨而不是比對訊息字串：訊息會隨版本改，例外類別名不會。
 */
function parseErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  const raw = e instanceof Error ? e.message : String(e);
  if (name === 'PasswordException') return '這份 PDF 有密碼保護，檢視器無法開啟。';
  if (name === 'InvalidPDFException') return `這個檔案的 PDF 結構已損毀，無法解析（${raw}）。`;
  return `無法解析這份 PDF：${raw}`;
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
  } catch (e) {
    if (signal?.aborted) throw e;
    // 解析失敗時 task 還握著 worker／transport，呼叫端拿不到 OpenedPdf 也就沒機會收，
    // 連續丟幾份損毀檔進來就會一直累積。
    void task.destroy().catch(() => {});
    throw new Error(parseErrorMessage(e));
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
        const items = toTextItems(content.items);
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
