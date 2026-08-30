// YouTube CC 字幕軌雙語（M2）。零框架純 DOM（鐵律 3），只加自己的節點（鐵律 4）。
//
// 為什麼觀察 DOM 而不是抓 timedtext 之類的內部端點：
//   1. 內部端點是未公開介面，YouTube 想改就改，維護成本沒有底；
//   2. 走 DOM 等於「看螢幕上已經有的東西」，不新增任何網路行為（鐵律 1、2 的精神）；
//   3. 本地引擎是 ms 級，觀察到再翻完全來得及。
//
// ── 實測到的字幕行為（2026-08-31，Chrome 152）──────────────────────────────
// 結構：.ytp-caption-window-container > .caption-window > .captions-text
//         > .caption-visual-line > .ytp-caption-segment
// 容器掛在 #movie_player 裡，**全螢幕時是同一個節點**，所以譯文掛在裡面就會跟著進全螢幕。
//
// 人工字幕：整句替換，約 0.2 次/秒。
// 自動生成 CC：**滾動視窗**，逐字往後長、前面被截掉，約 2.7 次/秒
//   （間隔 min 17ms / p50 237ms / p90 600ms / max 3589ms）。
//   例：「hello everyone uh thanks」→「…thanks for」→「…for coming」→ 前面被切掉。
//   所以沒有乾淨的 cue 邊界，不能「每次變動就翻」——那是每秒三次引擎呼叫。
//
// 因此穩定判定用兩個訊號，兩者互補：
//   A. 靜止：文字連續 STABLE_MS 沒變 → 這句講完了（說話有停頓時觸發）
//   B. 非追加變動：新文字不是舊文字的延伸（被截斷或整段換掉）→ 舊的那份已經定稿
//      （連續講話沒有停頓時，靠這個觸發）
// 只有 A 會漏掉連續講話的情況，只有 B 會漏掉最後一句，兩個都要。

import { looksChinese } from '../segmenter';
import type { SiteHost, SiteModule } from './types';

const CONTAINER = '.ytp-caption-window-container';
const PLAYER = '#movie_player';
const VISUAL_LINE = '.caption-visual-line';
const SEGMENT = '.ytp-caption-segment';

/** 靜止多久算「這句講完了」。實測 p90 間隔 600ms，取 700ms 剛好落在說話停頓上。 */
const STABLE_MS = 700;
/**
 * 最長等待。靜止計時每次字幕變動都會重設，講者一直講不停頓就永遠不會觸發，
 * 那段時間一個字都翻不出來。這個上限不會被重設，時間到就先送出目前這份。
 */
const MAX_PENDING_MS = 2500;
/** 太短的片段不翻：滾動視窗中途的兩三個字翻出來是雜訊，而且會洗掉上一句 */
const MIN_CHARS = 12;
/** 譯文顯示上限，避免超長字串把畫面撐爆 */
const MAX_CHARS = 600;

const STYLE_ID = 'yi-yt-style';
const OVERLAY_ATTR = 'data-yi-captions';

/**
 * 讀出目前的字幕文字。
 * 一定要用空格接 visual line：直接串 textContent 會黏成「coming tothe」「itpacked」
 * （實測，兩個 segment 之間沒有空白節點）。
 */
function readCaption(doc: Document): string {
  const lines = doc.querySelectorAll(VISUAL_LINE);
  const parts = lines.length > 0
    ? Array.from(lines, (l) => l.textContent ?? '')
    : Array.from(doc.querySelectorAll(SEGMENT), (s) => s.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export class YouTubeCaptions implements SiteModule {
  readonly id = 'youtube';

  private host: SiteHost | null = null;
  private mo: MutationObserver | null = null;
  private bodyMo: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private container: Element | null = null;
  private overlay: HTMLElement | null = null;

  /** 目前累積中的字幕文字 */
  private pending = '';
  /** 這份 pending 是什麼時候開始累積的，用來套用 MAX_PENDING_MS */
  private pendingSince = 0;
  /** 已經送去翻過的文字，避免同一句被兩個訊號各觸發一次 */
  private lastFinalized = '';
  /** 譯文請求的世代編號：換影片或關閉後，舊的非同步結果不准再上畫面 */
  private generation = 0;
  /** 請求序號與「已經顯示到第幾號」：擋掉亂序回來的舊譯文 */
  private requestSeq = 0;
  private renderedSeq = 0;
  private stopped = false;

  private onReposition = () => { if (!this.stopped) this.position(); };

  private onNavigate = () => {
    // 站內換影片：舊容器會被換掉，重新找一次；離開影片頁就清乾淨
    this.generation++;
    this.renderedSeq = this.requestSeq;
    this.pending = '';
    this.lastFinalized = '';
    this.detachContainer();
    this.tryAttach();
  };

  appliesTo(url: string): boolean {
    try {
      const u = new URL(url);
      return /(^|\.)youtube\.com$/.test(u.hostname);
    } catch { return false; }
  }

  start(host: SiteHost): void {
    this.host = host;
    this.stopped = false;
    host.siteStats.id = this.id;
    this.ensureStyle();

    // 實測會依序觸發 yt-navigate-start → yt-page-type-changed → yt-page-data-updated
    // → yt-navigate-finish。只聽 finish 就夠，但播放器有時比事件晚出現，
    // 所以另外用 body observer 補一手（不依賴 YouTube 的私有事件名稱活著）。
    host.doc.addEventListener('yt-navigate-finish', this.onNavigate);
    host.doc.defaultView?.addEventListener('popstate', this.onNavigate);
    // 進出全螢幕與視窗縮放都會搬動字幕視窗，譯文得跟著重新定位
    host.doc.addEventListener('fullscreenchange', this.onReposition);
    host.doc.defaultView?.addEventListener('resize', this.onReposition);

    this.bodyMo = new MutationObserver(() => {
      if (this.stopped) return;
      const c = host.doc.querySelector(CONTAINER);
      if (c !== this.container) this.onNavigate();
    });
    this.bodyMo.observe(host.doc.body, { childList: true, subtree: true });

    this.tryAttach();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    const doc = this.host?.doc;
    doc?.removeEventListener('yt-navigate-finish', this.onNavigate);
    doc?.defaultView?.removeEventListener('popstate', this.onNavigate);
    doc?.removeEventListener('fullscreenchange', this.onReposition);
    doc?.defaultView?.removeEventListener('resize', this.onReposition);
    this.bodyMo?.disconnect();
    this.bodyMo = null;
    this.detachContainer();
    doc?.getElementById(STYLE_ID)?.remove();
    this.host = null;
  }

  // ── 掛載／卸載 ────────────────────────────────────────────────────────────

  private tryAttach(): void {
    const doc = this.host?.doc;
    if (!doc || this.stopped) return;
    const c = doc.querySelector(CONTAINER);
    if (!c || c === this.container) return;

    this.container = c;
    this.mo = new MutationObserver(() => this.onCaptionChanged());
    // characterData：自動 CC 有時只改文字節點內容，不動子節點。
    // attributes：字幕視窗的位置是寫在 style 上的——播放器控制列一出現，YouTube 就把字幕
    // 往上抬（實測讓出 80px），控制列收起又貼回底部（距底約 10px）。不看 attribute 的話，
    // 譯文會留在舊位置，看起來就跑到原文上面去了。
    this.mo.observe(c, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['style'],
    });
    this.onCaptionChanged();
  }

  private detachContainer(): void {
    this.mo?.disconnect();
    this.mo = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.overlay?.remove();
    this.overlay = null;
    this.container = null;
  }

  // ── 穩定判定 ──────────────────────────────────────────────────────────────

  private onCaptionChanged(): void {
    if (this.stopped || !this.host) return;
    // 定位一定要在「文字沒變就 return」之前做：字幕視窗的移動是 style 變動、文字不會變，
    // 放在 return 之後等於這種情況完全不重新定位——先前譯文跑到原文上面就是這樣來的。
    this.position();

    const text = readCaption(this.host.doc);
    if (text === this.pending) return;

    this.host.siteStats.cueSeen++;
    const previous = this.pending;
    this.pending = text;

    // 訊號 B：不是「舊文字 + 新的字」＝舊那份已經定稿，趁它還在手上先送去翻
    const isAppend = previous !== '' && text.startsWith(previous);
    if (previous !== '' && !isAppend) this.finalize(previous);

    // 訊號 C：講不停時，等太久就先送出目前這份（這個上限不受下面的重設影響）
    const now = Date.now();
    if (previous === '' || text === '') this.pendingSince = now;
    else if (now - this.pendingSince >= MAX_PENDING_MS) {
      this.pendingSince = now;
      this.finalize(text);
    }

    // 訊號 A：重新起算靜止計時
    if (this.timer) clearTimeout(this.timer);
    if (text !== '') {
      this.timer = setTimeout(() => { this.timer = null; this.finalize(this.pending); }, STABLE_MS);
    }
  }

  private finalize(text: string): void {
    if (this.stopped || !this.host) return;
    const stats = this.host.siteStats;

    if (text.length < MIN_CHARS) { if (text) stats.cueDropped++; return; }
    if (text === this.lastFinalized) { stats.cueDropped++; return; }
    // 已經是中文的字幕整段跳過，連節點都不掛
    if (looksChinese(text)) { stats.cueSkippedChinese++; this.lastFinalized = text; return; }

    this.lastFinalized = text;
    const gen = this.generation;
    const seq = ++this.requestSeq;
    const source = text.slice(0, MAX_CHARS);

    const settle = (ok: boolean) => {
      // 序號在「任何一種結束」都要推進，成功、跳過、失敗都算。
      // 只在成功時推進的話，較新的請求若回 null，較舊、較慢的那個回來時
      // 仍會通過檢查並把過期譯文貼上畫面。
      if (seq > this.renderedSeq) this.renderedSeq = seq;
      if (!ok && this.lastFinalized === text) {
        // 這次沒翻成（語言包沒好、引擎出錯）。放行讓同一句之後還有機會再翻，
        // 否則一次暫時性失敗會讓這句在這支影片裡永遠不再出現譯文。
        this.lastFinalized = '';
      }
    };

    void this.host.translate(source).then((translated) => {
      if (this.stopped || gen !== this.generation) { settle(true); return; }
      if (!translated) { stats.cueDropped++; settle(false); return; }
      // 兩段譯文同時在路上時，先送的可能後回來；序號比較新的才准上畫面
      if (seq <= this.renderedSeq) { stats.cueDropped++; return; }
      this.renderedSeq = seq;
      this.render(translated);
      stats.cueTranslated++;
    }).catch(() => { stats.cueDropped++; settle(false); });
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  private ensureStyle(): void {
    const doc = this.host?.doc;
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    // pointer-events:none 是硬性要求：譯文疊在播放器上，不能吃掉任何點擊（鐵律 4）
    style.textContent = `
      x-yi[${OVERLAY_ATTR}] {
        position: absolute;
        left: 0;
        right: 0;
        z-index: 30;
        display: block;
        margin: 0;
        padding: 0.15em 0;
        border: 0;
        text-align: center;
        pointer-events: none;
        font: 500 clamp(13px, 1.9vw, 26px)/1.35 system-ui, sans-serif;
        color: #fff;
        text-shadow: 0 0 4px #000, 0 0 8px #000;
        white-space: pre-wrap;
        opacity: 0.95;
      }
    `;
    doc.documentElement.appendChild(style);
  }

  private render(translated: string): void {
    const doc = this.host?.doc;
    const container = this.container;
    if (!doc || !container) return;

    // 掛在 #movie_player 而不是字幕容器裡。
    // 兩者的矩形實測完全重合（containerTopInPlayer=0、containerH=playerH），座標算法不變，
    // 但字幕容器是 YouTube 自己反覆重建、其程式碼可能假設子節點都是 .caption-window 的地方，
    // 塞外來節點進去是沒必要的破站風險（鐵律 4：弄壞網站是 P0）。
    // 播放器本身是進全螢幕的那個元素，掛在它底下一樣會跟著進全螢幕。
    const player = doc.querySelector(PLAYER) ?? container;
    if (!this.overlay || !this.overlay.isConnected || this.overlay.parentElement !== player) {
      this.overlay?.remove();
      const el = doc.createElement('x-yi');
      el.setAttribute(OVERLAY_ATTR, '1');
      player.appendChild(el);
      this.overlay = el;
    }
    this.overlay.textContent = translated;
    this.position();
  }

  /**
   * 把譯文貼到原文字幕正下方。
   *
   * 必須「每次字幕變動都重算」，不能只在產生新譯文時算一次：
   * 字幕視窗會自己移動——行數從一行變兩行、離開全螢幕後播放器尺寸改變，都會讓它上下跑。
   * 只在渲染時定位的話，譯文會留在舊位置，結果就跑到原文上面去了（實測踩過）。
   */
  private position(): void {
    const container = this.container;
    const overlay = this.overlay;
    if (!container || !overlay || !overlay.isConnected) return;

    const win = container.querySelector('.caption-window') as HTMLElement | null;
    // 座標基準要跟 overlay 的定位父層一致，否則 top 會算在錯的原點上
    const base = overlay.offsetParent ?? overlay.parentElement ?? container;
    const box = base.getBoundingClientRect();
    if (!win || box.height <= 0) {
      overlay.style.top = '';
      overlay.style.bottom = '8%';
      return;
    }
    const w = win.getBoundingClientRect();
    const below = w.bottom - box.top;
    overlay.style.bottom = '';
    // 下方真的塞不下才往上放——那時仍然不遮住原文，只是位置換邊。
    overlay.style.top = below + overlay.offsetHeight > box.height
      ? `${Math.max(0, w.top - box.top - overlay.offsetHeight)}px`
      : `${below}px`;
  }
}
