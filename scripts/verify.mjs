// scripts/verify.mjs — 建置後驗證腳本（固化的測試流程）
// 用法：node scripts/verify.mjs <url> [--scroll]
//
// 為什麼是這個做法：正式版 Chrome 已移除 --load-extension，Playwright 也不再能靠
// --disable-extensions-except 注入擴充。改成「持久 profile ＋ 手動載入一次 ＋ CDP 附加」：
// unpacked 擴充手動裝進 .pw-profile 之後就留在該 profile，Chrome 啟動時從磁碟重讀
// .output/chrome-mv3——所以 rebuild 後直接重跑 verify 即生效，不需要任何注入旗標。
// 前提是啟動的必須是「新的」Chrome 實例，所以下面會先清掉佔用同 profile 的舊行程。
//
// 前置：
//   1. npm i -D playwright
//   2. npm run build:test
//   3. 一次性：跑本腳本會啟動 Chrome；在 chrome://extensions 開「開發人員模式」→
//      「載入未封裝」→ 選 .output/chrome-mv3 → 再點擴充圖示「啟用本地翻譯」下載語言包。
//      之後這個 profile 就記住了（要測需登入的站，也在這個 profile 登入一次即可）。
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const url = process.argv[2] ?? 'https://www.bbc.com/news';
const doScroll = process.argv.includes('--scroll');

const ROOT = path.resolve(import.meta.dirname, '..');
const ext = path.join(ROOT, '.output/chrome-mv3');
const profile = path.join(ROOT, '.pw-profile'); // 固定 profile：擴充、語言包與登入態只設定一次
const PORT = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(ext)) {
  console.error('找不到 .output/chrome-mv3，先跑 npm run build:test');
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}`);
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });

// ── 先清掉佔用同一個 profile 的舊 Chrome ────────────────────────────────────
// 非做不可：同 profile 已有實例時，新的 Chrome 只會把網址轉交給舊實例然後自己退出，
// 於是我們其實是在測「舊實例載入的舊擴充產物」——rebuild 完全不會生效，且無聲無息。
function profileChromePids() {
  try {
    return execSync(`pgrep -f "user-data-dir=${profile}" || true`, { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function killProfileChrome() {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    const pids = profileChromePids();
    if (pids.length === 0) return;
    for (const pid of pids) { try { process.kill(Number(pid), sig); } catch {} }
    const deadline = Date.now() + (sig === 'SIGTERM' ? 5000 : 3000);
    while (Date.now() < deadline && profileChromePids().length > 0) {
      try { execSync('sleep 0.2'); } catch {}
    }
  }
}

const stale = profileChromePids();
if (stale.length > 0) {
  console.log(`清掉 ${stale.length} 個佔用 .pw-profile 的舊 Chrome 行程…`);
  killProfileChrome();
}

// ── 啟動真 Chrome（帶 CDP 埠），不是 Playwright 自己管的瀏覽器 ──────────────
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=TranslateUI', // 關掉 Chrome 內建翻譯提示，避免干擾截圖
  'about:blank',
], { stdio: 'ignore', detached: false });

let closed = false;
const killChrome = () => {
  if (closed) return;
  closed = true;
  try { chrome.kill('SIGTERM'); } catch {}
  killProfileChrome(); // 連同 Chrome 自己 fork 出去、不歸 spawn 管的主行程一起收乾淨
};
process.on('exit', killChrome);
process.on('SIGINT', () => { killChrome(); process.exit(130); });

// ── 等 CDP 端點就緒 ────────────────────────────────────────────────────────
async function waitForCDP(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP 端點在 ${timeoutMs}ms 內沒有就緒（port ${PORT}）`);
}

let browser;
try {
  await waitForCDP();
  browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);

  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('connectOverCDP 沒有回傳任何 context');

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

  if (yiLogs.length === 0) {
    console.warn(
      '\n⚠️  沒有收到任何 [譯] console 輸出——擴充可能還沒裝進這個 profile。\n' +
      '   一次性設定：chrome://extensions → 開發人員模式 → 載入未封裝 → 選 .output/chrome-mv3\n' +
      '   → 再點擴充圖示「啟用本地翻譯」下載語言包。\n',
    );
  }

  const shot = path.join(ROOT, 'reports/verify.png');
  await page.screenshot({ path: shot });
  console.log('screenshot → reports/verify.png');

  await page.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  killChrome();
}
