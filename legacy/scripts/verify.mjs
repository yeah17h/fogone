// scripts/verify.mjs — 建置後驗證腳本（固化的測試流程）
// 用法：node scripts/verify.mjs <url> [--scroll]
//
// Chrome 的啟動與 CDP 附加見 scripts/chrome.mjs（含一次性前置設定）。
import path from 'node:path';
import { ROOT, launchChrome, warnIfNoExtension } from './chrome.mjs';

const url = process.argv[2] ?? 'https://www.bbc.com/news';
const doScroll = process.argv.includes('--scroll');

const { ctx, close } = await launchChrome();
try {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const yiLogs = [];
  // 錯誤只收「跟我們有關的」：第三方頁面的廣告／CSP 錯誤每頁都有一堆，全收等於沒收。
  // #4 的驗收「過程無報錯」指的是擴充自己不出錯。
  const yiErrors = [];
  let pageErrorCount = 0;
  // 只看訊息字串會漏：content script 丟出的 `ReferenceError: Node is not defined`
  // 訊息裡沒有任何我們的關鍵字，識別資訊在 stack／location 的 chrome-extension:// URL 裡。
  const mine = (...parts) => /\[譯\]|x-yi|chrome-extension:\/\//.test(parts.filter(Boolean).join('\n'));
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[譯]')) { console.log('console>', t); yiLogs.push(t); }
    if (m.type() === 'error' && mine(t, m.location()?.url)) yiErrors.push(t.slice(0, 160));
  });
  page.on('pageerror', (e) => {
    pageErrorCount++;
    if (mine(String(e), e?.stack)) yiErrors.push(String(e).slice(0, 160));
  });

  // 有些站（Threads 未登入）會彈登入牆 dialog，並把 document.scrollHeight 壓成視窗高度，
  // 於是捲動完全無效、頁面內容也進不了 DOM。按一次 Escape 關掉——這是通用的 modal
  // 關閉手勢，不是針對單一站的 hack。實測 Threads：docH 900 → 10976。
  // 記下有沒有真的關掉東西：關 dialog 會改變站點狀態（同意視窗、年齡確認也可能是 dialog），
  // 量測結果不能假裝那一步不存在。
  let dialogsDismissed = 0;
  const dismissDialog = async () => {
    if (await page.locator('[role=dialog]').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      dialogsDismissed++;
    }
  };

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500); // 等登入牆之類的 dialog 冒出來再關，不然關了個寂寞
  await dismissDialog();

  // 觸發 build:test 產物裡的測試觸發器
  await page.evaluate(() => window.postMessage({ yi: 'translate' }, '*'));
  await page.waitForTimeout(2500);

  // 捲動過程中同時取樣「當下掛著幾個譯文」。虛擬化的站（Threads 實測貼文容器
  // 固定只有 5~6 個在 DOM 裡）離開視窗的內容會被整個卸載，連同我們的 <x-yi> 一起消失，
  // 所以「跑完當下的 xyiCount」量到的是視窗容量、不是翻譯成效。峰值才有意義。
  let xyiPeak = await page.locator('x-yi').count();
  if (doScroll) {
    await dismissDialog();
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(800);
      xyiPeak = Math.max(xyiPeak, await page.locator('x-yi').count());
    }
    await page.waitForTimeout(1500);
    xyiPeak = Math.max(xyiPeak, await page.locator('x-yi').count());
  }

  // 統計（來自 build:test 觸發器）
  const stats = await page.evaluate(() => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    window.addEventListener('message', function onMsg(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (d?.yi === 'stats:result') {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d.stats);
      }
    });
    window.postMessage({ yi: 'stats' }, '*');
  }));

  // 分項：譯文落在頁面外框（nav/header/footer/aside）還是正文
  // ——#1 的驗收要「外框零譯文、正文不低於現況八成」，總數看不出來，一定要分開數。
  const breakdown = await page.evaluate(() => {
    const CHROME_SEL = 'nav,[role=navigation],[role=menubar],[role=tablist],[role=banner],'
      + '[role=contentinfo],aside,[role=complementary],header,footer';
    const MAIN_SEL = 'main,[role=main],article,[role=article]';
    let inChrome = 0, inBody = 0;
    const chromeSamples = [];
    for (const n of document.querySelectorAll('x-yi')) {
      const unit = n.parentElement;
      if (!unit) continue;
      const box = unit.closest(CHROME_SEL);
      // <header>/<footer> 也用在 article/main 內部當內文標題區，那算正文
      const isChrome = !!box
        && !(box.matches('header,footer') && box.closest(MAIN_SEL));
      if (isChrome) {
        inChrome++;
        if (chromeSamples.length < 6) {
          chromeSamples.push(`${box.tagName.toLowerCase()}: ${(unit.textContent ?? '').trim().slice(0, 30)}`);
        }
      } else inBody++;
    }
    return { inChrome, inBody, chromeSamples };
  });

  const xyiCount = await page.locator('x-yi').count();
  const sample = (await page.locator('x-yi').first().textContent().catch(() => '')) ?? '';
  console.log(JSON.stringify({
    url, scrolled: doScroll,
    xyiCount,
    xyiPeak,                           // 捲動過程中「同時掛著」的最大值＝DOM 占用量，不是覆蓋率；
                                       // 覆蓋率看 stats.done（累計完成數）
    dialogsDismissed,                  // 按了幾次 Escape 關 dialog（0 = 沒動過站點狀態）
    xyiInChrome: breakdown.inChrome,   // 導覽/頁首/頁尾/側欄裡的譯文——#1 要求趨近 0
    xyiInBody: breakdown.inBody,       // 正文譯文——#1 要求不低於基準八成
    chromeSamples: breakdown.chromeSamples,
    sample: sample.slice(0, 60),
    yiErrors,          // 擴充自己的錯誤——#4 要求為空
    pageErrorCount,    // 頁面總未捕捉錯誤數（第三方居多，僅供參考）
    stats,
  }, null, 2));

  warnIfNoExtension(yiLogs);

  const shot = path.join(ROOT, 'reports/verify.png');
  await page.screenshot({ path: shot });
  console.log('screenshot → reports/verify.png');

  await page.close();
} finally {
  await close();
}
