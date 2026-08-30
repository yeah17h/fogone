// 排程器：可視優先（IntersectionObserver）＋動態頁面監聽（MutationObserver）。
// PRD §6 效能鐵律的實作核心：先翻看得到的，看不到的等捲到再翻。

import { LocalEngine, SUPPORTED_SOURCES, TARGET } from './engine';
import {
  collectDenseUnits, collectStandardUnits, KANA, looksChinese,
  SEGMENT_TUNING, unitText, type SegmentMode,
} from './segmenter';
import { ensureStyle, fail, fill, mountPlaceholder } from './renderer';

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

  readonly stats: SessionStats = {
    found: 0, queued: 0, done: 0, failed: 0,
    skippedChinese: 0, skippedDetect: 0, skippedPack: 0,
    detectorBroken: false,
    availability: {},
    mode: 'standard',
    fallbackFound: 0,
  };

  constructor(private doc: Document) {
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
    return initial;
  }

  stop() {
    this.stopped = true;
    this.io.disconnect();
    this.mo.disconnect();
    this.queue.length = 0;
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

  private async translateUnit(unit: HTMLElement) {
    const text = unitText(unit);
    if (!text || looksChinese(text)) { this.stats.skippedChinese++; return; }

    const source = await this.detectSource(text);
    if (!source) { this.stats.skippedDetect++; return; } // 非 en/ja：MVP 先跳過

    // 鐵律 7：content script 不觸發下載。語言包還沒好就跳過，由 popup 引導使用者啟用。
    // availability() 本身也可能丟例外，那要記成 'error' 而不是留白——留白會看起來像沒查過。
    let avail: string;
    try {
      avail = await this.engine.availability(source, TARGET);
    } catch {
      avail = 'error';
    }
    this.stats.availability[`${source}→${TARGET}`] = avail;
    if (avail !== 'available') { this.stats.skippedPack++; return; }

    const node = mountPlaceholder(unit);
    try {
      const translation = await this.engine.translate({
        text,
        sourceLanguage: source,
        targetLanguage: TARGET,
      });
      if (this.stopped) { node.remove(); return; }
      fill(node, translation);
      this.stats.done++;
    } catch {
      fail(node);
      this.stats.failed++;
    }
  }
}
