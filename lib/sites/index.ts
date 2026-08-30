// 站點模組註冊表。新增站點只動這個檔案與 lib/sites/ 底下的模組，
// 通用管線（segmenter / scheduler / renderer）不該因為多一個站而改一行。

import type { SiteModule } from './types';
import { YouTubeCaptions } from './youtube';

const MODULES: readonly (() => SiteModule)[] = [
  () => new YouTubeCaptions(),
];

/** 找出負責這個網址的站點模組；沒有就回 null（絕大多數頁面都是 null） */
export function pickSite(url: string): SiteModule | null {
  for (const make of MODULES) {
    const m = make();
    if (m.appliesTo(url)) return m;
  }
  return null;
}

export type { SiteHost, SiteModule, SiteStats } from './types';
export { emptySiteStats } from './types';
