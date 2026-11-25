// Chrome 內建 AI API 的最小型別宣告（TypeScript 官方 DOM 型別尚未收錄）
// 只宣告我們用到的部分。

type YiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface YiDownloadMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (e: { loaded?: number }) => void,
  ): void;
}

interface YiTranslator {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface YiTranslatorStatic {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<YiAvailability>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: YiDownloadMonitor) => void;
  }): Promise<YiTranslator>;
}

interface YiDetection {
  detectedLanguage: string;
  confidence: number;
}

interface YiLanguageDetector {
  detect(text: string): Promise<YiDetection[]>;
}

interface YiLanguageDetectorStatic {
  create(): Promise<YiLanguageDetector>;
}

declare const Translator: YiTranslatorStatic;
declare const LanguageDetector: YiLanguageDetectorStatic;
declare const __YI_TESTING__: boolean;
