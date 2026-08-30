// scripts/verify-yt.mjs — YouTube 字幕雙語驗證（M2）
// 用法：node scripts/verify-yt.mjs [videoId 或 watch 網址] [取樣秒數]
// 預設影片：8aGhZQkoFbQ（Philip Roberts, "What the heck is the event loop anyway?"）
//   選它的理由：技術演講、有「英文 (自動產生)」字幕軌，正是最難的那種逐字滾動 CC。
//
// 前置與 verify.mjs 相同（.pw-profile 需一次性手動安裝擴充＋啟用語言包）。
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const arg = process.argv[2] ?? '8aGhZQkoFbQ';
const videoUrl = arg.startsWith('http') ? arg : `https://www.youtube.com/watch?v=${arg}`;
const SAMPLE_S = Number(process.argv[3] ?? 60);

const ROOT = path.resolve(import.meta.dirname, '..');
const ext = path.join(ROOT, '.output/chrome-mv3');
const profile = path.join(ROOT, '.pw-profile');
const PORT = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(ext)) { console.error('找不到 .output/chrome-mv3，先跑 npm run build:test'); process.exit(1); }
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });

function pids() {
  try {
    return execSync(`pgrep -f "user-data-dir=${profile}" || true`, { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
function killProfileChrome() {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (pids().length === 0) return;
    for (const p of pids()) { try { process.kill(Number(p), sig); } catch {} }
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && pids().length > 0) { try { execSync('sleep 0.2'); } catch {} }
  }
}
killProfileChrome();

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=TranslateUI',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
let closed = false;
const cleanup = () => { if (closed) return; closed = true; try { chrome.kill('SIGTERM'); } catch {} killProfileChrome(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForCDP(ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${PORT}/json/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Chrome CDP 沒有就緒');
}

let browser;
try {
  await waitForCDP();
  browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  const yiErrors = [];
  const mine = (...p) => /\[譯\]|x-yi|chrome-extension:\/\//.test(p.filter(Boolean).join('\n'));
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[譯]')) console.log('console>', t);
    if (m.type() === 'error' && mine(t, m.location()?.url)) yiErrors.push(t.slice(0, 160));
  });
  page.on('pageerror', (e) => { if (mine(String(e), e?.stack)) yiErrors.push(String(e).slice(0, 160)); });

  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  // 同意視窗（歐盟法遵畫面）
  for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("全部接受")']) {
    try {
      const l = page.locator(sel).first();
      if (await l.count() && await l.isVisible()) { await l.click({ timeout: 2000 }); await page.waitForTimeout(1500); break; }
    } catch {}
  }

  await page.evaluate(() => document.querySelector('video')?.play?.().catch(() => {}));
  await page.waitForTimeout(1200);

  // 開字幕，並優先選「自動產生」那一軌——那是最難的逐字滾動情境
  const track = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cc = document.querySelector('.ytp-subtitles-button');
    if (cc && cc.getAttribute('aria-pressed') !== 'true') { cc.click(); await sleep(1200); }
    const gear = document.querySelector('.ytp-settings-button');
    if (!gear) return 'no gear';
    gear.click(); await sleep(700);
    const item = [...document.querySelectorAll('.ytp-menuitem')].find((e) => /subtitle|caption|字幕/i.test(e.textContent ?? ''));
    if (!item) { gear.click(); return 'no caption menu'; }
    item.click(); await sleep(700);
    const opts = [...document.querySelectorAll('.ytp-menuitem')];
    const auto = opts.find((e) => /自動產生|auto-generated/i.test(e.textContent ?? ''));
    const pick = auto ?? opts.find((e) => /^英文$|^English$/i.test((e.textContent ?? '').trim()));
    if (!pick) { gear.click(); return `no english track: ${opts.map((e) => (e.textContent ?? '').trim()).join('/')}`; }
    const label = (pick.textContent ?? '').trim();
    pick.click(); await sleep(900);
    return label;
  });
  console.log('字幕軌:', track);

  // 觸發翻譯（build:test 的測試觸發器）
  await page.evaluate(() => window.postMessage({ yi: 'translate' }, '*'));
  await page.waitForTimeout(1500);

  const stats = () => page.evaluate(() => new Promise((res) => {
    const t = setTimeout(() => res(null), 3000);
    window.addEventListener('message', function h(e) {
      if (e.source !== window) return;
      if (e.data?.yi === 'stats:result') { clearTimeout(t); window.removeEventListener('message', h); res(e.data.stats); }
    });
    window.postMessage({ yi: 'stats' }, '*');
  }));

  console.log(`取樣 ${SAMPLE_S} 秒…`);
  const t0 = Date.now();
  let sawOverlay = 0;
  while ((Date.now() - t0) / 1000 < SAMPLE_S) {
    await page.waitForTimeout(3000);
    const n = await page.locator('x-yi[data-yi-captions]').count();
    if (n === 1) sawOverlay++;
    else if (n > 1) sawOverlay = -999; // 出現重複 overlay 就是 bug，讓它明顯地爛掉
  }

  const sBeforeReplay = await stats();

  // 倒轉重播同一段：同樣的字幕文字會再出現一次，用來證明快取真的在字幕路徑上生效。
  // 滾動視窗的字幕每句都不一樣，不倒轉的話快取永遠命中不到，「快取生效」就無從驗起。
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = Math.max(0, v.currentTime - 45); v.play(); });
  await page.waitForTimeout(25000);
  const s = await stats();
  const replay = {
    cueCacheHitsBefore: sBeforeReplay?.site?.cueCacheHits,
    cueCacheHitsAfter: s?.site?.cueCacheHits,
    cueEngineCallsBefore: sBeforeReplay?.site?.cueEngineCalls,
    cueEngineCallsAfter: s?.site?.cueEngineCalls,
  };

  // 播放控制：暫停 / 快轉 / 全螢幕，確認沒被譯文擋住也沒被攔截
  const controls = { };
  controls.beforePause = await page.evaluate(() => { const v = document.querySelector('video'); return { t: Math.round(v.currentTime), paused: v.paused }; });
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForTimeout(1000);
  controls.afterPause = await page.evaluate(() => { const v = document.querySelector('video'); return { t: Math.round(v.currentTime), paused: v.paused }; });
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = v.currentTime + 60; v.play(); });
  await page.waitForTimeout(4000);
  controls.afterSeek = await page.evaluate(() => { const v = document.querySelector('video'); return { t: Math.round(v.currentTime), paused: v.paused }; });

  // 譯文節點不能吃掉點擊：量它的 pointer-events
  controls.overlayPointerEvents = await page.evaluate(() => {
    const el = document.querySelector('x-yi[data-yi-captions]');
    return el ? getComputedStyle(el).pointerEvents : '(無譯文節點)';
  });

  await page.evaluate(() => document.querySelector('.ytp-fullscreen-button')?.click());
  await page.waitForTimeout(3000);
  controls.fullscreen = await page.evaluate(() => ({
    isFullscreen: !!document.fullscreenElement,
    overlayStillInside: !!document.querySelector('#movie_player x-yi[data-yi-captions]'),
    overlayVisible: (() => {
      const el = document.querySelector('x-yi[data-yi-captions]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
  }));
  await page.screenshot({ path: path.join(ROOT, 'reports/verify-yt-fullscreen.png') });
  await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
  await page.waitForTimeout(2500);

  const placeProbe = () => page.evaluate(() => {
    const c = document.querySelector('.ytp-caption-window-container');
    const w = c?.querySelector('.caption-window');
    const o = document.querySelector('x-yi[data-yi-captions]');
    if (!c || !w || !o) return { note: '(無字幕或譯文)', hasC: !!c, hasW: !!w, hasO: !!o };
    const cb = c.getBoundingClientRect(), wb = w.getBoundingClientRect(), ob = o.getBoundingClientRect();
    const rel = ob.top >= wb.bottom - 2 ? '下方' : (ob.bottom <= wb.top + 2 ? '上方' : '重疊');
    return {
      rel,
      containerH: Math.round(cb.height),
      winBottomInContainer: Math.round(wb.bottom - cb.top),
      overlayH: Math.round(ob.height),
      overlayStyleTop: o.style.top,
      wouldOverflow: Math.round(wb.bottom - cb.top) + Math.round(ob.height) > Math.round(cb.height),
      controlsVisible: !document.querySelector('#movie_player')?.classList.contains('ytp-autohide'),
    };
  });

  // 兩張截圖：控制列顯示（字幕被抬高、下方有空間）與控制列隱藏（字幕貼底）。
  // 這兩種狀態下譯文的擺放位置不同，兩張都要留證據。
  await page.mouse.move(640, 400);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(ROOT, 'reports/verify-yt.png') });
  const placement = await placeProbe();

  await page.mouse.move(640, 700);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ROOT, 'reports/verify-yt-idle.png') });
  const placementIdle = await placeProbe();

  // 站內換影片（SPA 導航）：模組要自動重新掛載到新播放器
  const spa = { from: page.url().slice(0, 48) };
  try {
    // 用播放器的「下一部」按鈕做站內導航：側邊欄的節點結構常改，這顆按鈕穩定得多
    const url0 = page.url();
    await page.evaluate(() => document.querySelector('.ytp-next-button')?.click());
    await page.waitForTimeout(8000);
    if (page.url() === url0) {
      await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href*="/watch?v="]')]
          .find((x) => x.href !== location.href && x.href.length > 34);
        a?.click();
      });
      await page.waitForTimeout(8000);
    }
    // 新影片也要開字幕
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const cc = document.querySelector('.ytp-subtitles-button');
      if (cc && cc.getAttribute('aria-pressed') !== 'true') { cc.click(); await sleep(1200); }
      document.querySelector('video')?.play?.().catch(() => {});
    });
    const before = (await stats())?.site?.cueTranslated ?? 0;
    await page.waitForTimeout(24000);
    const after = (await stats())?.site?.cueTranslated ?? 0;
    // 分辨「模組沒重新掛上」與「新影片本來就沒字幕」——後者不是我們的 bug。
    // 推薦的下一部影片每次都不同，不能假設它一定有 CC。
    spa.newVideoHasCaptions = await page.evaluate(
      () => document.querySelectorAll('.ytp-caption-segment').length > 0
        || (document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true'
            && !!document.querySelector('.ytp-caption-window-container')),
    );
    spa.to = page.url().slice(0, 48);
    spa.navigated = spa.to !== spa.from;
    spa.cueTranslatedBefore = before;
    spa.cueTranslatedAfter = after;
    spa.stillTranslatingAfterNav = after > before;
    spa.verdict = spa.navigated
      ? (after > before ? '換片後仍在翻譯 ✓'
        : (spa.newVideoHasCaptions ? '換片後沒再翻——要查' : '換片後新影片沒有字幕，無從判斷'))
      : '沒有發生站內導航';
    // 只看 count > 0 會放過「舊 overlay 沒清掉、新的又長一個」，要求剛好一個
    spa.overlayCount = await page.locator('x-yi[data-yi-captions]').count();
    spa.exactlyOneOverlay = spa.overlayCount === 1;
  } catch (e) { spa.error = String(e).slice(0, 120); }

  // 關閉翻譯後不得有殘留
  await page.evaluate(() => window.postMessage({ yi: 'off' }, '*'));
  await page.waitForTimeout(1500);
  const residue = await page.evaluate(() => ({
    xyi: document.querySelectorAll('x-yi').length,
    captionOverlay: document.querySelectorAll('x-yi[data-yi-captions]').length,
    styleTag: !!document.getElementById('yi-yt-style'),
    doneAttrs: document.querySelectorAll('[data-yi-done]').length,
  }));

  console.log(JSON.stringify({
    video: videoUrl,
    track,
    trackIsAutoGenerated: /自動產生|auto-generated/i.test(track),
    sampleSeconds: SAMPLE_S,
    overlaySamplesExactlyOne: sawOverlay,
    note: '字幕是本腳本自己開啟並選軌的（設定步驟，不是「這支影片天生有字幕」的證據）；'
      + 'replay 是刻意倒轉重播來製造快取命中的合成測試，不是自然播放下的命中率。',
    site: s?.site,
    replay,
    engineCalls: s?.engineCalls,
    cacheHits: s?.cacheHits,
    cacheSize: s?.cacheSize,
    failed: s?.failed,
    yiErrors,
    controls,
    placementControlsVisible: placement,
    placementControlsHidden: placementIdle,
    spaNavigation: spa,
    residueAfterOff: residue,
  }, null, 2));

  console.log('screenshot → reports/verify-yt.png、reports/verify-yt-fullscreen.png');
  await page.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
