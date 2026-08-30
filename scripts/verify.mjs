// scripts/verify.mjs — 建置後驗證腳本（固化的測試流程）
// 用法：node scripts/verify.mjs <url> [--scroll]
// 前置：npm i -D playwright；npm run build:test；第一次跑要在跳出的視窗手動點「啟用本地翻譯」
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const url = process.argv[2] ?? 'https://www.bbc.com/news';
const doScroll = process.argv.includes('--scroll');
const ext = path.resolve('.output/chrome-mv3');
const profile = path.resolve('.pw-profile'); // 固定 profile：語言包與登入態只設定一次

if (!fs.existsSync(ext)) {
  console.error('找不到 .output/chrome-mv3，先跑 npm run build:test');
  process.exit(1);
}
fs.mkdirSync('reports', { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',          // 一定要真 Chrome：只有它有本地 Translator API
  headless: false,            // 擴充需要非 headless
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
  ],
});

const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.text().includes('[譯]')) console.log('console>', m.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 觸發 build:test 產物裡的測試觸發器
await page.evaluate(() => window.postMessage({ yi: 'translate' }, '*'));
await page.waitForTimeout(2500);

if (doScroll) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(1500);
}

const xyiCount = await page.locator('x-yi').count();
const sample = (await page.locator('x-yi').first().textContent().catch(() => '')) ?? '';
console.log(JSON.stringify({ url, scrolled: doScroll, xyiCount, sample: sample.slice(0, 60) }, null, 2));

await page.screenshot({ path: 'reports/verify.png' });
console.log('screenshot → reports/verify.png');

await ctx.close();
