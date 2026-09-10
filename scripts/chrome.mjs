// scripts/chrome.mjs — verify 腳本共用的 Chrome 啟動器。
//
// 為什麼是這個做法：正式版 Chrome 已移除 --load-extension，Playwright 也不再能靠
// --disable-extensions-except 注入擴充。改成「持久 profile ＋ 手動載入一次 ＋ CDP 附加」：
// unpacked 擴充手動裝進 .pw-profile 之後就留在該 profile，Chrome 啟動時從磁碟重讀
// .output/chrome-mv3——所以 rebuild 後直接重跑 verify 即生效，不需要任何注入旗標。
//
// 前置（一次性）：
//   1. npm run build:test
//   2. 跑任一 verify 腳本會啟動 Chrome；在 chrome://extensions 開「開發人員模式」→
//      「載入未封裝」→ 選 .output/chrome-mv3 → 再點擴充圖示「啟用本地翻譯」下載語言包。
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_DIR = path.join(ROOT, '.output/chrome-mv3');
const PROFILE = path.join(ROOT, '.pw-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function profileChromePids() {
  try {
    return execSync(`pgrep -f "user-data-dir=${PROFILE}" || true`, { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * 清掉佔用同一個 profile 的舊 Chrome。**非做不可**：同 profile 已有實例時，
 * 新的 Chrome 只會把網址轉交給舊實例然後自己退出，於是我們其實是在測
 * 「舊實例載入的舊擴充產物」——rebuild 完全不會生效，而且無聲無息。
 */
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

/**
 * 擴充在這個 profile 裡的 ID。unpacked 擴充的 ID 由路徑決定，裝過一次就不變，
 * 但寫死會在別人的機器上失效——從 profile 的偏好設定裡按路徑反查。
 * 檢視器頁面是 chrome-extension://<id>/viewer.html，沒有 ID 就開不了。
 */
export function findExtensionId() {
  const prefs = path.join(PROFILE, 'Default/Secure Preferences');
  if (!fs.existsSync(prefs)) return null;
  const settings = JSON.parse(fs.readFileSync(prefs, 'utf8'))?.extensions?.settings ?? {};
  for (const [id, v] of Object.entries(settings)) {
    if (v?.path === EXT_DIR) return id;
  }
  return null;
}

/**
 * 啟動真 Chrome（帶 CDP 埠）並附加。回傳的 close() 一定要在 finally 裡呼叫。
 */
export async function launchChrome({ args = [] } = {}) {
  if (!fs.existsSync(EXT_DIR)) {
    console.error('找不到 .output/chrome-mv3，先跑 npm run build:test');
    process.exit(1);
  }
  if (!fs.existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });

  const stale = profileChromePids();
  if (stale.length > 0) {
    console.log(`清掉 ${stale.length} 個佔用 .pw-profile 的舊 Chrome 行程…`);
    killProfileChrome();
  }

  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI', // 關掉 Chrome 內建翻譯提示，避免干擾截圖
    ...args,
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

  await waitForCDP();
  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('connectOverCDP 沒有回傳任何 context');

  return {
    ctx,
    async close() {
      await browser.close().catch(() => {});
      killChrome();
    },
  };
}

/** 沒收到任何 [譯] 輸出時的提示——多半是擴充還沒裝進這個 profile。 */
export function warnIfNoExtension(logs) {
  if (logs.length > 0) return;
  console.warn(
    '\n⚠️  沒有收到任何 [譯] console 輸出——擴充可能還沒裝進這個 profile。\n' +
    '   一次性設定：chrome://extensions → 開發人員模式 → 載入未封裝 → 選 .output/chrome-mv3\n' +
    '   → 再點擴充圖示「啟用本地翻譯」下載語言包。\n',
  );
}
