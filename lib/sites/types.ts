// 站點模組的最小介面（M2）。
//
// 目的是把站點專屬的知識關在 lib/sites/ 裡：通用管線（segmenter / scheduler / renderer）
// 不准出現任何站名判斷。之後的「站點規則」都長這個形狀。
//
// 模組只跟 Session 要兩樣東西：一個「把這段文字翻好」的函式，和一個放自己統計的地方。
// 它不碰引擎、不碰語言包、不碰快取——那些都在 Session 那一側，站點模組換一百個也不會動到。

/** 站點模組看得到的 Session 能力面 */
export interface SiteHost {
  readonly doc: Document;
  /**
   * 走完整管線（中文判斷 → 語言偵測 → 快取 → 語言包 → 引擎）把一段文字翻成繁中。
   * 回 `null` 代表「這段不該翻」——已經是中文、非支援語言、或語言包還沒就緒。
   * 呼叫端拿到 null 就什麼都別顯示。
   */
  translate(text: string): Promise<string | null>;
  /** 模組自己的計數器，會被塞進 stats 一起傳給 popup */
  readonly siteStats: SiteStats;
}

export interface SiteModule {
  readonly id: string;
  /** 這個網址歸不歸我管 */
  appliesTo(url: string): boolean;
  start(host: SiteHost): void;
  stop(): void;
}

/** 站點模組的統計。欄位刻意通用，字幕類模組共用同一組。 */
export interface SiteStats {
  /** 哪個模組在跑；null = 這一頁沒有站點模組 */
  id: string | null;
  /** 觀察到幾則「內容有變化」的字幕快照 */
  cueSeen: number;
  /** 判定穩定、實際產生譯文的 cue 數 */
  cueTranslated: number;
  /** 判定不穩定／太短／重複而丟棄的 cue 數 */
  cueDropped: number;
  /** 整段已是中文所以完全不顯示的 cue 數 */
  cueSkippedChinese: number;
  /**
   * 字幕造成的引擎呼叫數與快取命中數。
   * 不能直接看全域的 engineCalls——那一份把通用管線翻影片標題／說明／留言的呼叫也算進去，
   * 拿它跟 cueTranslated 比會得到「引擎呼叫比翻譯數還多」的假象。
   */
  cueEngineCalls: number;
  cueCacheHits: number;
}

export function emptySiteStats(): SiteStats {
  return {
    id: null, cueSeen: 0, cueTranslated: 0, cueDropped: 0, cueSkippedChinese: 0,
    cueEngineCalls: 0, cueCacheHits: 0,
  };
}
