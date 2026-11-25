// 排程器：可視優先（IntersectionObserver）＋動態頁面監聽（MutationObserver）。
// PRD §6 效能鐵律的實作核心：先翻看得到的，看不到的等捲到再翻。

import { LocalEngine, SUPPORTED_SOURCES, TARGET } from './engine';
import {
  collectDenseUnits, collectStandardUnits, KANA, looksChinese,
  SEGMENT_TUNING, unitText, type SegmentMode,
} from './segmenter';
import { ensureStyle, fail, fill, mountPlaceholder } from './renderer';
import { cacheKey, translationCache } from './cache';
import { emptySiteStats, pickSite, type SiteHost, type SiteModule, type SiteStats } from './sites';

const CONCURRENCY = 3;

export interface SessionStats {
  found: number;
  queued: number;
  done: number;
  failed: number;
  skippedChinese: number;
  skippedDetect: number;
  skippedPack: number;
  detectorBroken: boolean;
  /**
   * 每個語言對最後一次實際看到的 availability 值（#3），例如
   * `{ 'ja→zh-Hant': 'downloadable', 'en→zh-Hant': 'available' }`。
   * 光看 skippedPack 的數字分不出「還沒下載」和「下載中」，得記下實際值才知道
   * 該引導使用者去 popup 啟用、還是叫他等一下。純字串物件，可結構化複製傳給 popup。
   */
  availability: Record<string, string>;
  /**
   * 這次 session 用的分段策略（#2）：'standard' = 標準選擇器夠用；
   * 'dense' = 標準選擇器命中太少，已啟動文字密度備援。
   * 零遙測產品沒有遠端 log，診斷只能做在使用者自己看得到的地方（popup 統計列）。
   */
  mode: SegmentMode;
  /** 密度備援比標準選擇器多撈到幾個單位（mode === 'standard' 時恆為 0） */
  fallbackFound: number;
  /** 實際打進引擎的翻譯呼叫數（#10）。快取命中不算在內。 */
  engineCalls: number;
  /**
   * 快取命中數（#10）。
   * 不變式：**全部工作結束、且 failed === 0、且 session 沒被中途停掉**時，
   * `done === engineCalls + cacheHits`。
   *
   * 三種會讓它不成立的情況（都不是 bug，是計數點的位置造成的）：
   * 失敗時 engineCalls 已經加一但 done 不會加；
   * **在 `await engine.translate()` 期間 stop()** 的那一筆，engineCalls 已經加一、
   * 譯文也會寫進快取，但因為 stopped 而不加 done（先前這裡寫「兩邊都不加」，那是錯的）；
   * 以及 done++ 之前的 DOM 操作若拋錯。
   * 所以別把這條當成隨時成立的恆等式。
   */
  cacheHits: number;
  /** 快取目前存了幾筆（跨 Session，關掉再打開不會歸零） */
  cacheSize: number;
  /** 站點模組的統計（M2）。沒有模組時 id 為 null，其餘欄位維持 0。 */
  site: SiteStats;
}

/** 備援語言判斷：偵測器不可用時的粗規則（有假名→ja；拉丁字母為主→en） */
function guessSource(text: string): string | null {
  // 與 looksChinese 共用同一份假名定義：兩邊各寫一份遲早會不一致（#7 就是這樣來的）
  if (KANA.test(text)) return 'ja';
  const letters = text.match(/\p{Letter}/gu) ?? [];
  const latin = text.match(/[A-Za-z]/g) ?? [];
  if (letters.length > 0 && latin.length / letters.length > 0.7) return 'en';
  return null;
}

export class Session {
  private engine = new LocalEngine();
  private io: IntersectionObserver;
  private mo: MutationObserver;
  private queue: HTMLElement[] = [];
  private running = 0;
  private detector: Promise<YiLanguageDetector> | null = null;
  private stopped = false;
  private site: SiteModule | null = null;

  readonly stats: SessionStats = {
    found: 0, queued: 0, done: 0, failed: 0,
    skippedChinese: 0, skippedDetect: 0, skippedPack: 0,
    detectorBroken: false,
    availability: {},
    mode: 'standard',
    fallbackFound: 0,
    engineCalls: 0,
    cacheHits: 0,
    cacheSize: 0,
    site: emptySiteStats(),
  };

  constructor(private doc: Document) {
    // 快取是跨 Session 的單例，新 Session 一開始就該回報它真實的大小，
    // 否則「關掉再打開」後統計列會顯示存 0 筆，看起來像快取沒生效。
    this.stats.cacheSize = translationCache.size;
    ensureStyle(doc);
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          this.io.unobserve(e.target);
          this.enqueue(e.target as HTMLElement);
        }
      }
    }, { rootMargin: '200px 0px' }); // 提前 200px 開始翻，捲動時無縫

    this.mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLElement && !node.closest('x-yi')) {
            this.observe(node);
          }
        }
      }
    });
  }

  start(): number {
    // 分段策略只在這裡決定一次，整個 session 沿用（#2）。
    // 不能交給每次 mutation 各自判斷：單一新增節點的標準命中數本來就趨近 0，
    // 那樣每個 mutation 都會誤觸備援，等於備援永遠開著。
    const probe = collectStandardUnits(this.doc.body);
    if (probe.length <= SEGMENT_TUNING.TRIGGER_MAX_STANDARD_UNITS) {
      this.stats.mode = 'dense';
    }

    // 策略定了才正式收。standard 模式下這裡會重跑一次剛才的掃描，
    // 但只在啟動時發生一次，換來 start 與 observe 共用同一條收集路徑。
    const initial = this.observe(this.doc.body);
    this.mo.observe(this.doc.body, { childList: true, subtree: true });

    // 站點模組（M2）：有就掛上，沒有就算了。通用管線照跑，不因為有模組而改變行為。
    this.site = pickSite(this.doc.defaultView?.location.href ?? '');
    this.site?.start(this.siteHost());

    return initial;
  }

  stop() {
    this.stopped = true;
    this.site?.stop();
    this.site = null;
    this.io.disconnect();
    this.mo.disconnect();
    this.queue.length = 0;
  }

  /** 交給站點模組的能力面：只有「翻這段文字」和一個放統計的地方 */
  private siteHost(): SiteHost {
    return {
      doc: this.doc,
      siteStats: this.stats.site,
      translate: async (text: string) => {
        const r = await this.translateText(text);
        // 分開記，才分得出「字幕打了幾次引擎」與「整頁打了幾次」。
        // 失敗（reason === 'error'）也是打過引擎的，成本上要算，不然統計會少報。
        if (r.ok) {
          if (r.fromCache) this.stats.site.cueCacheHits++;
          else this.stats.site.cueEngineCalls++;
        } else if (r.reason === 'error') {
          this.stats.site.cueEngineCalls++;
        }
        return r.ok ? r.text : null;
      },
    };
  }

  /** 收集 root 下的翻譯單位，交給 IntersectionObserver 盯；回傳找到幾個 */
  private observe(root: ParentNode): number {
    const units = collectStandardUnits(root);
    if (this.stats.mode === 'dense') {
      // 累加而不是覆寫：捲動時每批新內容都會再走一次備援，統計要反映總量
      const dense = collectDenseUnits(root);
      this.stats.fallbackFound += dense.length;
      units.push(...dense);
    }
    return this.track(units);
  }

  /** 把已收集好的單位交給 IntersectionObserver 盯；回傳幾個 */
  private track(units: HTMLElement[]): number {
    for (const unit of units) {
      this.io.observe(unit);
    }
    this.stats.found += units.length;
    return units.length;
  }

  private enqueue(unit: HTMLElement) {
    this.stats.queued++;
    this.queue.push(unit);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.running < CONCURRENCY && this.queue.length > 0) {
      const unit = this.queue.shift()!;
      this.running++;
      this.translateUnit(unit).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private getDetector(): Promise<YiLanguageDetector> {
    if (!this.detector) this.detector = LanguageDetector.create();
    return this.detector;
  }

  private async detectSource(text: string): Promise<string | null> {
    if (typeof LanguageDetector === 'undefined') {
      this.stats.detectorBroken = true;
    }
    if (!this.stats.detectorBroken) {
      try {
        const det = await this.getDetector();
        const [top] = await det.detect(text.slice(0, 200));
        if (!top) return null;
        const lang = top.detectedLanguage.split('-')[0];
        return (SUPPORTED_SOURCES as readonly string[]).includes(lang) ? lang : null;
      } catch {
        // 偵測器在這個環境掛了：記下來，之後全部改走備援
        this.stats.detectorBroken = true;
      }
    }
    return guessSource(text);
  }

  /**
   * 文字層級的翻譯管線：中文判斷 → 語言偵測 → 快取 → 語言包 → 引擎。
   * DOM 單位（translateUnit）與站點模組（字幕）共用這一條，
   * 所以快取、統計、鐵律 5 的語言包檢查只有一份實作。
   *
   * onEngineStart 在「確定要打引擎、而且不是快取命中」的那一刻呼叫，
   * 讓呼叫端有機會先掛上載入中的佔位符；快取命中不會呼叫它（沒有等待可言）。
   */
  private async translateText(
    text: string,
    onEngineStart?: () => void,
  ): Promise<{ ok: true; text: string; fromCache: boolean } | { ok: false; reason: string }> {
    if (!text || looksChinese(text)) { this.stats.skippedChinese++; return { ok: false, reason: 'chinese' }; }

    const source = await this.detectSource(text);
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (!source) { this.stats.skippedDetect++; return { ok: false, reason: 'detect' }; }

    // 快取查詢排在語言包檢查「之前」（#10）：手上已經有譯文就根本不需要引擎。
    const key = cacheKey(this.engine.id, source, TARGET, text);
    const cached = translationCache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      this.stats.cacheSize = translationCache.size;
      return { ok: true, text: cached, fromCache: true };
    }

    // 鐵律 5：content script 不觸發下載。語言包還沒好就跳過，由 popup 引導使用者啟用。
    // availability() 本身也可能丟例外，那要記成 'error' 而不是留白——留白會看起來像沒查過。
    let avail: string;
    try {
      avail = await this.engine.availability(source, TARGET);
    } catch {
      avail = 'error';
    }
    this.stats.availability[`${source}→${TARGET}`] = avail;
    if (this.stopped) return { ok: false, reason: 'stopped' };
    if (avail !== 'available') { this.stats.skippedPack++; return { ok: false, reason: 'pack' }; }

    onEngineStart?.();
    try {
      this.stats.engineCalls++;
      const translation = await this.engine.translate({
        text,
        sourceLanguage: source,
        targetLanguage: TARGET,
      });
      translationCache.set(key, translation);
      this.stats.cacheSize = translationCache.size;
      if (this.stopped) return { ok: false, reason: 'stopped' };
      return { ok: true, text: translation, fromCache: false };
    } catch {
      this.stats.failed++;
      return { ok: false, reason: 'error' };
    }
  }

  private async translateUnit(unit: HTMLElement) {
    const text = unitText(unit);
    // 用物件裝而不是區域變數：TypeScript 的控制流分析會假設 callback 不執行，
    // 把區域變數收窄成 never，之後就不能再當節點用了。
    const held: { node: HTMLElement | null } = { node: null };

    const r = await this.translateText(text, () => { held.node = mountPlaceholder(unit); });
    if (!r.ok) { if (held.node) fail(held.node); return; }
    if (this.stopped) { held.node?.remove(); return; }

    // 快取命中時上面不會掛佔位符，這裡補掛再同步填字，畫面不會閃
    const node = held.node ?? mountPlaceholder(unit);
    fill(node, r.text);
    this.stats.done++;
  }
}
