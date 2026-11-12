// scripts/spike-summarizer.mjs — spike 3：Chrome 本地 Summarizer API 可行性量測
// 用法：node scripts/spike-summarizer.mjs [--allow-download]
//
// 只量測，不做功能。要回答的是產品的「摘要模式」該走本地還是 BYOK。
//
// 安全預設：**不會觸發模型下載**。Summarizer 背後是 Gemini Nano，是 GB 級的下載，
// 不能因為跑個 spike 就在使用者機器上塞一包。availability 不是 'available' 時只回報、不 create。
// 真的要測下載路徑再加 --allow-download。
//
// 環境需求同 verify.mjs：系統安裝的正式版 Chrome ＋ .pw-profile。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { CHROME, killProfileChrome as killChrome } from './chrome.mjs';

const allowDownload = process.argv.includes('--allow-download');
const ROOT = path.resolve(import.meta.dirname, '..');
const profile = path.join(ROOT, '.pw-profile');
const PORT = 9333;

if (!fs.existsSync(CHROME)) { console.error(`找不到 Chrome：${CHROME}`); process.exit(1); }

killChrome();

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-features=TranslateUI', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGTERM'); } catch {} killChrome(); });

async function waitForCDP(ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${PORT}/json/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Chrome CDP 沒有就緒');
}

// 一段真實的英文技術散文，長度接近實際會拿來摘要的文章段落
const SAMPLE = `
The Navigation API provides the ability to initiate, intercept, and manage browser navigation
actions. It can also examine an application's history entries. This is a successor to previous
web platform features such as the History API and window.location, which solves their
shortcomings and is specifically aimed at the needs of single-page applications (SPAs).
In SPAs, the page template tends to stay the same during usage, and the content is dynamically
rewritten as the user visits different pages or features. As a result, only one distinct page is
loaded in the browser, which breaks the expected user experience of navigating back and forth
between different locations in the viewing history. This problem can be mitigated by using the
History API, but that API was designed at a time when SPAs were much less common, and it has a
number of rough edges that the Navigation API is intended to smooth over.
`.trim();

let browser;
try {
  await waitForCDP();
  browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = browser.contexts()[0];

  const report = {};

  // ── 1. API 是否存在、各種設定組合的 availability ─────────────────────────
  const page = await ctx.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  report.surface = await page.evaluate(() => ({
    hasSummarizer: typeof Summarizer !== 'undefined',
    hasTranslator: typeof Translator !== 'undefined',
    hasLanguageDetector: typeof LanguageDetector !== 'undefined',
    hasWriter: typeof Writer !== 'undefined',
    hasRewriter: typeof Rewriter !== 'undefined',
    hasLanguageModel: typeof LanguageModel !== 'undefined',
  }));

  if (!report.surface.hasSummarizer) {
    console.log(JSON.stringify({ ...report, verdict: 'Summarizer API 不存在於這個 Chrome' }, null, 2));
    process.exit(0);
  }

  // 各種選項組合分別問 availability——重點是「能不能指定繁中輸出」
  report.availability = await page.evaluate(async () => {
    const combos = {
      'default': {},
      'key-points/markdown/short': { type: 'key-points', format: 'markdown', length: 'short' },
      'tldr/plain-text/short': { type: 'tldr', format: 'plain-text', length: 'short' },
      'outputLanguage=zh-Hant': { outputLanguage: 'zh-Hant' },
      'outputLanguage=zh-Hant + input=en': { outputLanguage: 'zh-Hant', expectedInputLanguages: ['en'] },
      'outputLanguage=en': { outputLanguage: 'en' },
      'outputLanguage=ja': { outputLanguage: 'ja' },
    };
    const out = {};
    for (const [label, opts] of Object.entries(combos)) {
      try { out[label] = await Summarizer.availability(opts); }
      catch (e) { out[label] = `ERR ${e?.name}: ${String(e?.message ?? e).slice(0, 140)}`; }
    }
    return out;
  });

  // 輸出語言掃描：「繁中不行」要有對照組才站得住，否則分不出是語言不支援還是整個 API 不行
  report.outputLanguages = await page.evaluate(async () => {
    const langs = ['en', 'ja', 'es', 'fr', 'de', 'ko', 'zh', 'zh-Hans', 'zh-Hant', 'zh-TW', 'zh-CN'];
    const out = {};
    for (const l of langs) {
      try { out[l] = await Summarizer.availability({ outputLanguage: l }); }
      catch (e) { out[l] = `ERR ${e?.name}`; }
    }
    return out;
  });

  // ── 2. 只有在 available 時才 create（除非明確允許下載）─────────────────────
  const anyAvailable = Object.values(report.availability).some((v) => v === 'available');
  report.willCreate = anyAvailable || allowDownload;

  if (!report.willCreate) {
    report.note = 'availability 沒有任何組合是 available，且未加 --allow-download，'
      + '因此不呼叫 create()——Summarizer 背後是 GB 級模型，不該因為跑 spike 就下載。';
  } else {
    report.runs = await page.evaluate(async ({ text, allowDownload }) => {
      const attempts = [
        { label: '繁中輸出（key-points）', opts: { type: 'key-points', format: 'plain-text', length: 'short', outputLanguage: 'zh-Hant', expectedInputLanguages: ['en'] } },
        { label: '繁中輸出（tldr）', opts: { type: 'tldr', format: 'plain-text', length: 'short', outputLanguage: 'zh-Hant', expectedInputLanguages: ['en'] } },
        { label: '預設（不指定輸出語言）', opts: { type: 'tldr', format: 'plain-text', length: 'short' } },
      ];
      const results = [];
      for (const a of attempts) {
        const r = { label: a.label, opts: a.opts };
        const progress = [];
        try {
          const avail = await Summarizer.availability(a.opts);
          r.availability = avail;
          if (avail !== 'available' && !allowDownload) { r.skipped = '非 available，未加 --allow-download 故跳過'; results.push(r); continue; }
          const t0 = performance.now();
          const s = await Summarizer.create({
            ...a.opts,
            monitor(m) { m.addEventListener('downloadprogress', (e) => progress.push(e.loaded ?? -1)); },
          });
          r.createMs = Math.round(performance.now() - t0);
          const t1 = performance.now();
          r.summary = await s.summarize(text, { context: 'A reference page for web developers.' });
          r.summarizeMs = Math.round(performance.now() - t1);
          r.downloadEvents = progress.length;
          s.destroy?.();
        } catch (e) {
          r.error = `${e?.name}: ${String(e?.message ?? e).slice(0, 260)}`;
        }
        results.push(r);
      }
      return results;
    }, { text: SAMPLE, allowDownload });
  }

  // ── 3. 擴充頁面環境是否也拿得到（content script 世界跟主世界曾有差異）──────
  try {
    const prefsPath = path.join(profile, 'Default', 'Secure Preferences');
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    const extId = Object.entries(prefs.extensions.settings)
      .find(([, v]) => String(v.path ?? '').includes('chrome-mv3'))?.[0];
    if (extId) {
      const pp = await ctx.newPage();
      await pp.goto(`chrome-extension://${extId}/popup.html`);
      await pp.waitForTimeout(1000);
      report.extensionPage = await pp.evaluate(async () => {
        if (typeof Summarizer === 'undefined') return { hasSummarizer: false };
        try {
          return { hasSummarizer: true, availability: await Summarizer.availability({ outputLanguage: 'zh-Hant' }) };
        } catch (e) { return { hasSummarizer: true, availability: `ERR ${String(e).slice(0, 120)}` }; }
      });
      await pp.close();
    }
  } catch (e) { report.extensionPage = { error: String(e).slice(0, 140) }; }

  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  try { chrome.kill('SIGTERM'); } catch {}
  killChrome();
}
