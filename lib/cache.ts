// 翻譯快取（#10）：同一段文字在同一個分頁裡，第二次之後就不再送進引擎。
//
// 「第二次之後」是精確的講法，不是「只送一次」：排程器同時跑三個工作者，
// 三個若同時撞到同一段「還沒進過快取」的新文字，會各自 miss 再各自呼叫一次引擎。
// 沒有做 in-flight 去重（那要在快取裡存 Promise、還要處理 reject 的清理），
// 因為實際頁面上相同文字多半是先後出現而不是同時出現——BBC 實測單次執行內命中 9 次，
// 都是先後命中。若之後 BYOK 的成本數字顯示這個窗口值得堵，再補。
//
// 為什麼需要：虛擬化的站（Threads 實測）會把貼文連同 <x-yi> 一起卸載，捲回時節點是
// 重建的、data-yi-done 也跟著沒了，於是同一段文字被重翻——實測捲回一趟就多打了 28 次。
// 本地引擎重翻只是浪費電，BYOK 引擎重翻是真金白銀。
//
// 生命週期是「分頁」而不是「Session 物件」：使用者關掉雙語再重新打開會建立新的 Session，
// 但那顯然該吃到快取，所以這裡是 module 單例，跟著 content script 實例活著。
// 分頁一關就整個消失——這是記憶體快取，持久化（IndexedDB）是後續的事。

/**
 * 兩道上限，兩道都會觸發淘汰（從最久沒用到的開始丟）。
 * 只用筆數不是真的上限——原文與譯文長度沒有上界，2000 筆若每筆 10KB 就是 80MB。
 * 所以另外壓一個字元預算，那才是真正跟記憶體掛鉤的量。
 * 200 萬字元 ≈ 4MB（UTF-16），加上 Map 與字串額外開銷抓 5~6MB。
 */
const MAX_ENTRIES = 2000;
const MAX_CHARS = 2_000_000;

/**
 * key 用「引擎 id ＋ 語言對 ＋ 原文」直接串成字串，不做 hash。
 *
 * 刻意不 hash：非密碼學雜湊會碰撞，而這裡碰撞的後果是「在使用者的頁面上顯示另一段文字的
 * 譯文」——一個安靜且很難查的正確性 bug。以 32-bit 雜湊、2000 筆計，碰撞機率約萬分之五，
 * 不算低。原文本來就要留著當 key 的一部分才能保證正確，hash 省下的那點記憶體不值得。
 *
 * 引擎 id 一定要進 key：之後 BYOK 上線，切換引擎後不能拿到上一個引擎的譯文。
 * 語言對也要進：同一段文字翻成不同目標語言是不同結果。
 */
/** 分隔符用單元分隔符（U+001F）：引擎 id、語言代碼與網頁文字都不可能含有它，
 *  所以 key 不會有「'a b' + 'c'」和「'a' + 'b c'」撞在一起的歧義。
 *  寫成跳脫序列而不是字面字元，原始碼才維持純文字（字面控制字元會讓 git 把整個檔當 binary）。 */
const KEY_SEP = '\u001f';

export function cacheKey(engineId: string, source: string, target: string, text: string): string {
  return [engineId, source, target, text].join(KEY_SEP);
}

export class TranslationCache {
  /** Map 保證插入順序，拿它當 LRU 用：最舊的永遠在最前面 */
  private entries = new Map<string, string>();
  private hitCount = 0;
  private missCount = 0;
  private evictCount = 0;
  /** 目前佔用的字元數（key + value），增量維護，不用每次重算 */
  private chars = 0;

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    // 命中就搬到最後面，這樣「最久沒用到的」始終在最前面
    this.entries.delete(key);
    this.entries.set(key, value);
    this.hitCount++;
    return value;
  }

  set(key: string, value: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.chars -= key.length + existing.length;
    }
    this.entries.set(key, value);
    this.chars += key.length + value.length;

    // 筆數與字元數任一超標都淘汰。size > 0 是防呆：單一超大條目也不該把自己丟掉，
    // 否則 set 完立刻被淘汰，等於快取靜默失效。
    while ((this.entries.size > MAX_ENTRIES || this.chars > MAX_CHARS) && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.chars -= oldest.length + (dropped?.length ?? 0);
      this.evictCount++;
    }
  }

  get size(): number { return this.entries.size; }
  get charCount(): number { return this.chars; }
  get hits(): number { return this.hitCount; }
  get misses(): number { return this.missCount; }
  get evictions(): number { return this.evictCount; }
}

/** 分頁層級的單例：跨 Session 存活，讓「關掉再打開」也吃得到快取 */
export const translationCache = new TranslationCache();
