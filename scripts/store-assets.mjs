// scripts/store-assets.mjs — 產生 Chrome 線上應用程式商店的圖片素材
// 用法：node scripts/store-assets.mjs [--only=shots|promos]
//
// 產出（store/assets/）：
//   screenshot-1-web.png        1280×800  整頁雙語（英文站）
//   screenshot-2-youtube.png    1280×800  YouTube CC 雙語字幕
//   screenshot-3-popup.png      1280×800  擴充視窗 UI（零權限訴求）
//   screenshot-4-japanese.png   1280×800  日文站雙語
//   promo-small-440x280.png     440×280   小型宣傳圖（後台必填）
//   promo-large-920x680.png     920×680   大型宣傳圖（選填）
//
// 為什麼不直接用 reports/*.png：那些是驗證截圖，含測試痕跡與非正式版面，
// 而且尺寸不合後台規格。商店素材另外截、尺寸一次到位。
//
// 為什麼截圖要走 build:test：頁面上的譯文得先真的被翻出來才有東西可截，
// 而正式建置沒有程式化觸發器（鐵律 5：只有使用者手勢能觸發下載）。
// 截到的 DOM 由與正式版**同一條** content script 路徑產生，外觀一致；
// 差別只在誰按下開始。
//
// 前置：npm run build:test，且 .pw-profile 已裝好擴充與語言包（見 verify.mjs 檔頭）。
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'store/assets');
const TMP = path.join(ROOT, 'store/assets/.raw'); // 未合成的原始截圖，保留以便重算版面
const ext = path.join(ROOT, '.output/chrome-mv3');
const profile = path.join(ROOT, '.pw-profile');
const PORT = 9334; // 與 verify.mjs 的 9333 錯開，兩者可並存不打架
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const doShots = onlyArg !== 'promos';
const doPromos = onlyArg !== 'shots';

// 版面常數：合成圖 = 上方說明帶 + 下方 1:1 原始截圖，截圖不縮放（縮放會糊）
const W = 1280, H = 800, BAND = 120, SHOT_H = H - BAND;

if (!fs.existsSync(ext)) { console.error('找不到 .output/chrome-mv3，先跑 npm run build:test'); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error(`找不到 Chrome：${CHROME}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// ── 清掉佔用同 profile 的舊 Chrome（理由同 verify.mjs：不清就會測到舊擴充產物）──
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
if (stale.length > 0) { console.log(`清掉 ${stale.length} 個佔用 .pw-profile 的舊 Chrome 行程…`); killProfileChrome(); }

// 埠必須是空的才啟動：若 PORT 已被另一個 Chrome 佔住，我們 spawn 的實例會 bind 失敗然後
// 自己退出，而 waitForCDP() 會立刻接受那個「別人的」端點——接下來整段流程就跑在錯的
// 瀏覽器上（錯的 profile、錯的擴充版本，甚至在對方視窗裡開分頁截圖）。寧可停下來。
try {
  const res = await fetch(`http://localhost:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    console.error(`port ${PORT} 已經有另一個 Chrome 在監聽，附加上去會截到錯的瀏覽器。`);
    console.error('先關掉它再跑（verify.mjs 用的是 9333，兩者不該互相佔用）。');
    process.exit(1);
  }
} catch { /* 連不上＝埠是空的，正是我們要的 */ }

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=TranslateUI',
  '--hide-scrollbars', // 商店素材不該出現捲軸
  'about:blank',
], { stdio: 'ignore', detached: false });

let closed = false;
const killChrome = () => {
  if (closed) return;
  closed = true;
  try { chrome.kill('SIGTERM'); } catch {}
  killProfileChrome();
};
process.on('exit', killChrome);
process.on('SIGINT', () => { killChrome(); process.exit(130); });
chrome.on('exit', (code) => {
  if (!closed) console.error(`⚠️  Chrome 提前結束（code ${code}）——後續步驟會失敗`);
});

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

// 擴充 ID：不寫死（unpacked 的 ID 綁 profile，換機器就變）。
// 先問 CDP 的 target 清單；MV3 的 service worker 沒在跑時不會出現在清單裡，
// 所以主要來源其實是 profile 的偏好設定檔——而且擴充清單在 **Secure Preferences**，
// 不是 Preferences（後者的 extensions.settings 是空的，找錯檔會一直找不到）。
// 順序很重要：**先查偏好設定檔**，因為那是唯一能把 ID 對回「我們這個擴充」的來源。
// CDP target 清單只能證明「某個擴充有 target 在跑」——這個 profile 裡有 6 個擴充，
// 撈到第一個 chrome-extension:// 就用，很可能開到 Google 文件離線版的 popup。
// CDP 只留作備援，而且要能對上偏好設定檔找到的 ID 才算數。
function extensionIdFromProfile() {
  // 兩層 realpath：Chrome 記的是安裝當下的實際路徑，若 repo 或 .output 任一段是 symlink，
  // 純字串比對會失敗。realpath 失敗（路徑已不存在）就退回 resolve。
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const want = real(ext);
  for (const f of ['Secure Preferences', 'Preferences']) {
    const p = path.join(profile, 'Default', f);
    if (!fs.existsSync(p)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(p, 'utf8'))?.extensions?.settings ?? {};
      for (const [id, v] of Object.entries(settings)) {
        if (v?.path && real(String(v.path)) === want) return id;
      }
    } catch {}
  }
  return null;
}

async function extensionId() {
  const fromProfile = extensionIdFromProfile();
  if (fromProfile) return fromProfile;
  // 備援：偏好設定檔讀不到時才問 CDP。沒有交叉驗證的來源，所以只在剛好只有一個
  // 擴充 target 時才敢用——多於一個就分不出哪個是我們的，寧可回 null 讓這張圖失敗。
  try {
    const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
    const ids = [...new Set(targets
      .map((t) => /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url ?? '')?.[1])
      .filter(Boolean))];
    if (ids.length === 1) return ids[0];
  } catch {}
  return null;
}

const dataUri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;

// 共用視覺識別（沿用佔位圖示的配色，見 BACKLOG #12）
const NAVY = '#1B3A6B', ACCENT = '#5FC9D6', INK = '#0E2145';
const FONT = "'PingFang TC','Heiti TC','Noto Sans CJK TC',system-ui,-apple-system,sans-serif";

// FOGONE 的識別核心：fog + gone 共用中間那個 g，用強調色點出來（BACKLOG #12 的設計備註）
const wordmark = (size) => `
  <span style="font:700 ${size}px/1 ${FONT};letter-spacing:-.02em;color:#fff">
    Fo<span style="color:${ACCENT}">g</span>one
  </span>`;

let browser;
const made = [];
const failed = [];

try {
  await waitForCDP();
  browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('connectOverCDP 沒有回傳任何 context');

  // ── 合成：把原始截圖擺進固定尺寸的版面，再截一次 ──────────────────────────
  async function compose({ file, width, height, html }) {
    const page = await ctx.newPage();
    try {
      await page.setViewportSize({ width, height });
      // 用 setContent 而不是導覽到 data:text/html：整張 PNG 轉 base64 後有數百 KB，
      // 塞進網址會撞上 URL／IPC 的長度上限，症狀是 goto() 無預警失敗。
      await page.setContent(
        `<body style="margin:0;width:${width}px;height:${height}px;overflow:hidden">${html}</body>`,
        { waitUntil: 'load' },
      );
      await page.waitForTimeout(400); // 等字型與 data: 圖片上好
      await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width, height } });
    } finally {
      await page.close().catch(() => {});
    }
    made.push(file);
    console.log(`  ✓ ${file}  ${width}×${height}`);
  }

  // 每個項目開工前先清掉自己的舊產物：失敗時若留著上一輪的檔案，資料夾看起來六張都在，
  // 只有 console 說失敗——事後只看資料夾的人會把舊圖當成這次的成果送審。
  const claim = (file) => { fs.rmSync(path.join(OUT, file), { force: true }); };

  // 「等不到就算了」會產出無效素材卻仍標記成功。needed() 讓等待失敗變成真正的失敗。
  const needed = (ok, what) => { if (!ok) throw new Error(what); };

  // 說明帶 + 原始截圖
  const shotLayout = (rawPath, title, sub) => `
    <div style="width:${W}px;height:${BAND}px;background:${NAVY};color:#fff;
                display:flex;align-items:center;gap:22px;padding:0 44px;box-sizing:border-box">
      <div>${wordmark(30)}<div style="font:600 15px/1.5 ${FONT};color:#B9CBE6;margin-top:2px">幾個譯思</div></div>
      <div style="width:1px;height:56px;background:rgba(255,255,255,.22)"></div>
      <div>
        <div style="font:700 27px/1.25 ${FONT}">${title}</div>
        <div style="font:400 15px/1.5 ${FONT};color:#B9CBE6;margin-top:4px">${sub}</div>
      </div>
    </div>
    <img src="${dataUri(rawPath)}" width="${W}" height="${SHOT_H}"
         style="display:block;object-fit:cover;object-position:top left">`;

  // ── 1) 抓原始截圖 ─────────────────────────────────────────────────────────
  async function newShotPage() {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: W, height: SHOT_H });
    page.on('console', (m) => { if (m.text().includes('[譯]')) console.log('  console>', m.text()); });
    return page;
  }
  const translate = (page) => page.evaluate(() => window.postMessage({ yi: 'translate' }, '*'));
  // 捲到「第一段有譯文的位置」再截。用選擇器捲（article h2/p）不可靠：MDN 的頁首
  // 廣告橫幅仍留在畫面上，商店素材不該替別人打廣告。以譯文自身定位，畫面必定是雙語內容。
  // offset 要大於站點固定頁首的高度（MDN 實測約 98px），否則原文會被壓在導覽列底下、
  // 只露出半截標題。定位對象取譯文的 parentElement——那是原文段落本身，
  // 對齊它才能保證「原文＋譯文」成對完整入鏡；對齊 <x-yi> 只保證譯文入鏡。
  // 可視優先佇列只會先翻視窗內的段落，正文在摺線以下時截到的畫面會很空。
  // 先捲一趟讓正文翻完，再捲回去定位——這不是作弊，使用者實際閱讀時就是這個順序。
  const warmScroll = async (page, rounds = 2) => {
    for (let i = 0; i < rounds; i++) {
      await page.mouse.wheel(0, 1100);
      await page.waitForTimeout(2200);
    }
  };
  const scrollToFirstTranslation = async (page, offset = 118, index = 0) => {
    const ok = await page.evaluate(({ off, idx }) => {
      const all = document.querySelectorAll('x-yi');
      const el = all[Math.min(idx, all.length - 1)];
      if (!el) return false;
      const unit = el.parentElement ?? el;
      const y = unit.getBoundingClientRect().top + window.scrollY - off;
      window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      return true;
    }, { off: offset, idx: index });
    await page.waitForTimeout(2500); // 捲動會帶出新段落，等它們翻完再截
    return ok;
  };
  const dismiss = async (page) => {
    if (await page.locator('[role=dialog]').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
  };

  if (doShots) {
    // (1) 英文技術文件 → 繁中
    try {
      console.log('抓圖 1／4：英文網頁雙語…');
      claim('screenshot-1-web.png');
      const raw = path.join(TMP, 'web.png');
      const page = await newShotPage();
      try {
        await page.goto('https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
          { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await dismiss(page);
        await translate(page);
        await page.waitForTimeout(4000);
        needed(await scrollToFirstTranslation(page), '頁面上沒有任何譯文（<x-yi>），擴充可能沒生效');
        await page.screenshot({ path: raw });
        console.log('  x-yi =', await page.locator('x-yi').count());
      } finally { await page.close().catch(() => {}); }
      await compose({
        file: 'screenshot-1-web.png', width: W, height: H,
        html: shotLayout(raw, '整頁雙語對照', '譯文加在原文下方，不覆蓋、不取代原文，隨時一鍵移除'),
      });
    } catch (e) { failed.push(`screenshot-1-web: ${e.message}`); console.log('  ✗', e.message); }

    // (2) YouTube CC 雙語字幕
    try {
      console.log('抓圖 2／4：YouTube 字幕雙語…');
      claim('screenshot-2-youtube.png');
      const raw = path.join(TMP, 'youtube.png');
      const page = await newShotPage();
      try {
      await page.goto('https://www.youtube.com/watch?v=8aGhZQkoFbQ', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4500);
      for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'button:has-text("全部接受")']) {
        try {
          const l = page.locator(sel).first();
          if (await l.count() && await l.isVisible()) { await l.click({ timeout: 2000 }); await page.waitForTimeout(1500); break; }
        } catch {}
      }
      // 跳到演講中段：開頭是掌聲與寒暄，字幕內容零碎，翻出來看不出價值
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.currentTime = 240; v.play?.().catch(() => {}); }
      });
      await page.waitForTimeout(2000);
      // 開字幕，優先選自動生成那一軌（那才是賣點：沒有乾淨 cue 邊界也翻得動）
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
        if (!pick) { gear.click(); return 'no english track'; }
        const label = (pick.textContent ?? '').trim();
        pick.click(); await sleep(900);
        return label;
      });
      console.log('  字幕軌:', track);
      // 關掉設定選單：選完字幕軌後選單仍開著，會蓋住半個畫面，也讓控制列不自動隱藏
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      await translate(page);
      // 等到譯文真的掛上去再截，不然截到空白字幕。等不到就讓這張圖失敗——
      // 「沒有譯文的 YouTube 截圖」拿去當商店素材是錯的，不該被當成成功產出。
      await page.waitForFunction(() => document.querySelector('x-yi[data-yi-captions]'), null, { timeout: 30000 })
        .catch(() => { throw new Error('等不到字幕譯文（30s）'); });
      await page.waitForTimeout(1500);
      // 全螢幕再截：一般版面的側欄會出現第三方廣告（實測撈到加密貨幣廣告），
      // 商店素材不該替那種東西曝光。全螢幕只有影片與字幕，順帶也證明全螢幕正常
      // ——字幕容器在全螢幕是同一個節點，譯文會跟著進去。
      await page.evaluate(() => document.querySelector('.ytp-fullscreen-button')?.click());
      await page.waitForTimeout(2500);
      // 滑鼠移開播放器，讓控制列自動隱藏（控制列會蓋住字幕，也會把字幕往上推）
      await page.mouse.move(5, 5);
      await page.waitForTimeout(4000);
      // 等到「原文夠長且譯文已跟上」的那一瞬間才按快門。自動生成 CC 是滾動視窗、
      // 逐字往後長（實測 2.7 次/秒），隨手截會截到 "a / stretch that's good" 這種碎片，
      // 展示不出翻譯品質。截到之後不要再等——下一次更新就把畫面換掉了。
      // 光看「原文夠長、譯文夠長」會截到錯配的一瞬間：滾動視窗的原文一直在變，
      // 譯文可能還停在上一個 cue，兩邊各自夠長就通過了。所以再要求**兩者同時
      // 500ms 沒有變動**——原文一變就重新計時，譯文更新也重新計時，
      // 撐得過這段靜止期就代表這組原文／譯文是同一個 cue 的。
      await page.waitForFunction(() => {
        const src = [...document.querySelectorAll('.caption-visual-line')]
          .map((l) => l.textContent ?? '').join(' ').trim();
        const zh = (document.querySelector('x-yi[data-yi-captions]')?.textContent ?? '').trim();
        const prev = window.__yiShotPrev;
        const stableSince = prev && prev.src === src && prev.zh === zh ? prev.t : Date.now();
        window.__yiShotPrev = { src, zh, t: stableSince };
        if (src.length < 45 || zh.length < 12) return false;
        return Date.now() - stableSince >= 500;
      }, null, { timeout: 60000, polling: 200 })
        .catch(() => { throw new Error('等不到「原文夠長且譯文已跟上」的穩定畫面（60s）'); });
      await page.screenshot({ path: raw });
      console.log('  字幕譯文節點 =', await page.locator('x-yi[data-yi-captions]').count());
      } finally { await page.close().catch(() => {}); }
      await compose({
        file: 'screenshot-2-youtube.png', width: W, height: H,
        html: shotLayout(raw, 'YouTube 字幕即時翻譯', '含自動生成的 CC 字幕，原文與譯文同時可見、不遮擋畫面'),
      });
    } catch (e) { failed.push(`screenshot-2-youtube: ${e.message}`); console.log('  ✗', e.message); }

    // (3) 擴充視窗 UI
    try {
      console.log('抓圖 3／4：擴充視窗…');
      claim('screenshot-3-popup.png');
      const id = await extensionId();
      if (!id) throw new Error('找不到擴充 ID——擴充可能還沒裝進 .pw-profile');
      const raw = path.join(TMP, 'popup.png');
      const page = await ctx.newPage();
      try {
        // 2 倍解析度截，合成時放大 2 倍顯示＝1:1 實體像素，放大也不糊
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride',
          { width: 288, height: 300, deviceScaleFactor: 2, mobile: false });
        await page.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        // 截 <main> 而不是整個視窗：popup 的高度由內容決定，視窗高度是我們硬給的，
        // 差額會變成面板下方一大塊白。元素截圖同樣吃 deviceScaleFactor=2。
        await page.locator('main').screenshot({ path: raw });
      } finally { await page.close().catch(() => {}); }
      await compose({
        file: 'screenshot-3-popup.png', width: W, height: H,
        html: `<div style="width:${W}px;height:${H}px;background:${INK};
                    display:flex;align-items:center;justify-content:center;gap:72px;box-sizing:border-box;padding:0 80px">
            <div style="max-width:520px">
              ${wordmark(46)}
              <div style="font:600 20px/1.5 ${FONT};color:#B9CBE6;margin:6px 0 26px">幾個譯思</div>
              <div style="font:700 34px/1.35 ${FONT};color:#fff">零權限、零遙測</div>
              <div style="font:400 18px/1.85 ${FONT};color:#C8D6EA;margin-top:16px">
                安裝時你會看到：這個擴充要求的權限是空的。<br>
                翻譯由 Chrome 內建的裝置端模型完成，<br>文字從未離開你的瀏覽器。
              </div>
              <div style="font:400 15px/1.6 ${FONT};color:${ACCENT};margin-top:22px">開源 · AGPL-3.0</div>
            </div>
            <img src="${dataUri(raw)}" width="576"
                 style="display:block;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.5)">
          </div>`,
      });
    } catch (e) { failed.push(`screenshot-3-popup: ${e.message}`); console.log('  ✗', e.message); }

    // (4) 日文站雙語
    try {
      console.log('抓圖 4／4：日文網頁雙語…');
      claim('screenshot-4-japanese.png');
      const raw = path.join(TMP, 'japanese.png');
      const page = await newShotPage();
      try {
      await page.goto('https://zenn.dev/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      // 首頁是卡片牆，翻起來看不出「整篇對照」；點進第一篇文章。
      // 比對必須是「/<作者>/articles/<slug>」的完整形狀：只找 '/articles/' 會撈到
      // /articles/explore 這種列表頁，截出來仍是卡片牆（實測踩過）。
      const href = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href*="/articles/"]')]
          .find((x) => /^https:\/\/zenn\.dev\/[^/]+\/articles\/[^/?#]+$/.test(x.href));
        return a ? a.href : null;
      });
      if (href) { await page.goto(href, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); }
      await dismiss(page);
      await translate(page);
      await page.waitForTimeout(4500);
      await warmScroll(page);
      // index=1：跳過標題那一對，對齊正文——標題配對很好看，但整個畫面會有一半是留白，
      // 正文段落連續成對才看得出「整篇對照」是什麼樣子
      needed(await scrollToFirstTranslation(page, 118, 1), '頁面上沒有任何譯文（<x-yi>），擴充可能沒生效');
      await page.screenshot({ path: raw });
      console.log('  x-yi =', await page.locator('x-yi').count(), '｜', href ?? 'zenn.dev 首頁');
      } finally { await page.close().catch(() => {}); }
      await compose({
        file: 'screenshot-4-japanese.png', width: W, height: H,
        html: shotLayout(raw, '英文、日文都能讀', '已經是中文的內容自動跳過；往下捲會接續翻譯新出現的段落'),
      });
    } catch (e) { failed.push(`screenshot-4-japanese: ${e.message}`); console.log('  ✗', e.message); }
  }

  // ── 2) 宣傳圖（純版面，不依賴擴充）────────────────────────────────────────
  if (doPromos) {
    console.log('產生宣傳圖…');
    // 每張各自隔離：兩張直接 await 的話，第一張失敗會讓第二張不執行、
    // 最後的產出摘要也印不出來，與四張截圖「各自失敗、繼續下一張」的策略不一致。
    const promo = async (file, spec) => {
      try { claim(file); await compose(spec); }
      catch (e) { failed.push(`${file}: ${e.message}`); console.log('  ✗', e.message); }
    };
    // 440×280 必填。小尺寸只放得下識別與一句話——多寫一個字都會變成雜訊。
    await promo('promo-small-440x280.png', {
      file: 'promo-small-440x280.png', width: 440, height: 280,
      html: `<div style="width:440px;height:280px;box-sizing:border-box;padding:38px 34px;
                  background:linear-gradient(135deg,${NAVY} 0%,${INK} 100%);color:#fff;
                  display:flex;flex-direction:column;justify-content:center">
          ${wordmark(52)}
          <div style="font:600 21px/1.4 ${FONT};color:#B9CBE6;margin-top:8px">幾個譯思</div>
          <div style="height:3px;width:52px;background:${ACCENT};margin:20px 0 18px"></div>
          <div style="font:700 20px/1.55 ${FONT}">翻譯在你的裝置上完成<br>內容不離開電腦</div>
        </div>`,
    });

    // 920×680 選填。空間夠，放三條真的成立的訴求（不預告未推出的功能）。
    await promo('promo-large-920x680.png', {
      file: 'promo-large-920x680.png', width: 920, height: 680,
      html: `<div style="width:920px;height:680px;box-sizing:border-box;padding:74px 70px;
                  background:linear-gradient(135deg,${NAVY} 0%,${INK} 100%);color:#fff;
                  display:flex;flex-direction:column;justify-content:center">
          ${wordmark(84)}
          <div style="font:600 30px/1.4 ${FONT};color:#B9CBE6;margin-top:12px">幾個譯思</div>
          <div style="height:4px;width:88px;background:${ACCENT};margin:34px 0 30px"></div>
          <div style="font:700 36px/1.5 ${FONT}">翻譯在你的裝置上完成，內容不離開電腦</div>
          <div style="font:400 23px/2 ${FONT};color:#C8D6EA;margin-top:26px">
            <div>・整頁雙語對照，譯文加在原文下方</div>
            <div>・YouTube 字幕即時翻譯，含自動生成 CC</div>
            <div>・零權限、零遙測、開源 AGPL-3.0</div>
          </div>
        </div>`,
    });
  }
} finally {
  // close() 沒有內建 timeout：CDP 連線壞掉時它會卡住，killChrome() 就永遠輪不到，
  // 於是留下一個佔著 .pw-profile 的 Chrome，下一次執行還要再清一遍。給它 10 秒上限。
  if (browser) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
  }
  killChrome();
}

console.log('\n產出 → store/assets/');
for (const f of made) console.log('  ', f);
if (failed.length) {
  console.log('\n失敗：');
  for (const f of failed) console.log('  ✗', f);
  process.exitCode = 1;
}
