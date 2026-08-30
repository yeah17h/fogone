// 引擎層（PRD §5）：所有翻譯引擎都實作同一個介面。
// L0 = Chrome 本地 Translator API（預設）。L1 BYOK 之後照這個介面補。

export interface TranslateRequest {
  text: string;
  sourceLanguage: string; // BCP-47，如 'en'、'ja'
  targetLanguage: string; // 如 'zh-Hant'
}

export interface Engine {
  id: string;
  /** 回報這個語言對目前能不能用（unavailable / downloadable / downloading / available） */
  availability(source: string, target: string): Promise<string>;
  translate(req: TranslateRequest): Promise<string>;
}

/** L0：本地引擎。translator 實例依語言對快取，避免重複建立。 */
export class LocalEngine implements Engine {
  id = 'local';
  private translators = new Map<string, Promise<YiTranslator>>();

  static supported(): boolean {
    return typeof Translator !== 'undefined';
  }

  availability(source: string, target: string): Promise<string> {
    return Translator.availability({ sourceLanguage: source, targetLanguage: target });
  }

  /**
   * 注意（鐵律 5）：語言包尚未下載時，create() 需要使用者手勢。
   * 骨架的設計是：下載只發生在 popup 的「啟用」按鈕（有手勢），
   * content script 只在 availability === 'available' 時才呼叫這裡。
   */
  private getTranslator(source: string, target: string): Promise<YiTranslator> {
    const key = `${source}→${target}`;
    let t = this.translators.get(key);
    if (!t) {
      t = Translator.create({ sourceLanguage: source, targetLanguage: target });
      this.translators.set(key, t);
    }
    return t;
  }

  async translate(req: TranslateRequest): Promise<string> {
    const t = await this.getTranslator(req.sourceLanguage, req.targetLanguage);
    return t.translate(req.text);
  }
}

/** 目前產品保證品質的來源語言（PRD §5）。其他語言 best effort，骨架先跳過。 */
export const SUPPORTED_SOURCES = ['en', 'ja'] as const;
export const TARGET = 'zh-Hant';
