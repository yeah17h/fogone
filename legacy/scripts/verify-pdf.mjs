// scripts/verify-pdf.mjs — PDF 檢視器驗證（M3 5d）
// 用法：node scripts/verify-pdf.mjs [--stress N]
//
// 做四件事：
//   1. 三份測試 PDF 各開一次 → 翻譯 → 回報段落／完成／引擎呼叫／快取命中，並截圖
//   2. 捲動流暢度：翻譯進行中連續捲 3 秒，量 fps 與最長一幀
//   3. 錯誤處理：抓取失敗／非 PDF／超過上限／損毀檔案／私網位址各要有明確訊息
//   4. 「回到原生檢視器」逃生口：連結存在、指向原網址、點下去真的離開檢視器
//   （--stress N：三份檔案輪開 N 輪，每輪強制 GC 後量測，看記憶體有沒有隨開檔次數成長。
//    **N 至少要 3**：第一輪是一次性成本，基準取第二輪，兩輪的話沒有東西可比。）
//
// 沒有涵蓋的兩件事，別把它們當成已驗證：
//   - 「網站存取權設成點按時」只用「解析不到的網域」代打，走的是同一條 fetch 拒絕路徑，
//     但沒有真的去 chrome://extensions 改設定（那是 chrome:// 的 UI，自動化不划算）。
//   - 記憶體只量得到主執行緒；PDF.js 在 worker 裡，那邊的洩漏這裡看不到。
//     Documents／Nodes／JSEventListeners 不動足以排除「文件沒被釋放」這一類。
//
// 數字直接讀 window.__yiViewer（build:test 產物才有），不解析畫面上的中文句子——
// 那種解析一改文案就無聲壞掉。
//
// Chrome 的啟動與 CDP 附加見 scripts/chrome.mjs（含一次性前置設定）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { ROOT, launchChrome, findExtensionId, warnIfNoExtension } from './chrome.mjs';

const stressIdx = process.argv.indexOf('--stress');
const STRESS = stressIdx >= 0 ? Number(process.argv[stressIdx + 1] ?? 3) : 0;

// 額外的 PDF 路徑可以直接接在命令列後面（跑大檔效能時很有用），例如：
//   node scripts/verify-pdf.mjs .pdf-fixtures/big.pdf
const EXTRA = process.argv.slice(2).filter((a) => a.endsWith('.pdf'));
const FIXTURES = [
  ...['arxiv-2col', 'gov-han', 'whitepaper']
    .map((name) => ({ name, file: path.join(ROOT, '.pdf-fixtures', `${name}.pdf`) })),
  ...EXTRA.map((f) => ({ name: path.basename(f, '.pdf'), file: path.resolve(f) })),
];

const missing = FIXTURES.filter((f) => !fs.existsSync(f.file));
if (missing.length > 0) {
  console.error(`缺少測試 PDF：${missing.map((m) => m.name).join('、')}\n`
    + '先跑 node scripts/make-pdf-fixtures.ts（會下載到 .pdf-fixtures/）');
  process.exit(1);
}

const extensionId = findExtensionId();
if (!extensionId) {
  console.error('在 .pw-profile 裡找不到本擴充。\n'
    + '一次性設定：chrome://extensions → 開發人員模式 → 載入未封裝 → 選 .output/chrome-mv3');
  process.exit(1);
}
const VIEWER = `chrome-extension://${extensionId}/viewer.html`;

// 壞檔與超大檔就地產生，不進版本庫。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yi-pdf-'));
const corrupt = path.join(tmp, 'corrupt.pdf');
// 前 1024 bytes 內有 %PDF- 才進得了 PDF.js（我們的 looksLikePdf 閘門），
// 之後全是垃圾——這才測得到「解析階段失敗」而不是「一眼就不是 PDF」。
fs.writeFileSync(corrupt, Buffer.concat([
  Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x41),
]));
const oversize = path.join(tmp, 'oversize.pdf');
fs.writeFileSync(oversize, Buffer.from('%PDF-1.7\n'));
fs.truncateSync(oversize, 101 * 1024 * 1024); // 稀疏檔，不真的佔 101MB 磁碟

// 私網目標：要證明「重新導向到內網會被擋下」，那個內網位址就得真的有東西回應——
// 連不上的話 fetch 會先丟例外，走的是連線失敗那條路，證明不到重新導向的檢查。
const localPdf = fs.readFileSync(FIXTURES[2].file);
const localServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/pdf' });
  res.end(localPdf);
});
await new Promise((r) => localServer.listen(8099, '127.0.0.1', r));

const { ctx, close } = await launchChrome();
const results = { files: [], errors: [], escapeHatch: null, stress: null, yiErrors: [] };

// 驗收失敗要讓腳本以非 0 結束。只把數字倒進 JSON 的話，「私網重新導向意外成功」
// 這種事會安靜地混在一堆看起來很正常的輸出裡——那等於沒有驗證。
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/** 等到某個條件成立，或逾時回 null。回傳最後一次讀到的 __yiViewer。 */
async function waitViewer(page, ok, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__yiViewer ?? null);
    if (last && ok(last)) return last;
    await page.waitForTimeout(50);   // 輪詢間隔就是 loadMs 的解析度，別調大
  }
  return last;
}

/** 還沒有去處的段落數：總帳裡的「尚未捲到」那一格。 */
function pending(s = {}) {
  return (s.found ?? 0) - (s.done ?? 0) - (s.failed ?? 0)
    - (s.skippedChinese ?? 0) - (s.skippedDetect ?? 0) - (s.skippedPack ?? 0);
}

/** 統計不再變動就當這一輪翻完了（本地引擎沒有「全部完成」事件可聽）。 */
async function settle(page, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.__yiViewer ?? null);
    const key = JSON.stringify(last?.stats ?? null);
    stable = key === previous ? stable + 1 : 0;
    previous = key;
    if (stable >= 4) break;         // 連續 4 次（約 2 秒）沒動
    await page.waitForTimeout(500);
  }
  return last;
}

try {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const cdp = await ctx.newCDPSession(page);

  // 檔案一律走 CDP 塞進 <input type=file>：Playwright 對「不與它同機」的瀏覽器
  //（connectOverCDP 就算）限制單檔 50MB，而我們就是要測 101MB 那條上限。
  // Chrome 本來就在本機，直接給路徑最省事。
  const setFiles = async (files) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { files, nodeId });
  };

  /**
   * 塞一份檔案並等它真的載完。
   * **要比對 gen**：同一個分頁連開多份檔案時，畫面上還留著上一份的 `ready`，
   * 只等 `phase === 'ready'` 會立刻通過，於是根本沒等到這一次的載入。
   */
  const openFile = async (file) => {
    const before = (await page.evaluate(() => window.__yiViewer?.gen ?? 0));
    await setFiles([file]);
    return waitViewer(page, (v) => v.gen > before && (v.phase === 'ready' || v.phase === 'error'));
  };
  const yiLogs = [];
  const mine = (...parts) => /\[譯\]|x-yi|chrome-extension:\/\//.test(parts.filter(Boolean).join('\n'));
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[譯]')) { console.log('console>', t); yiLogs.push(t); }
    if (m.type() === 'error' && mine(t, m.location()?.url)) results.yiErrors.push(t.slice(0, 160));
  });
  page.on('pageerror', (e) => {
    if (mine(String(e), e?.stack)) results.yiErrors.push(String(e).slice(0, 160));
  });

  // ── 1＋2：三份 PDF 翻譯與捲動流暢度 ─────────────────────────────────────
  for (const fx of FIXTURES) {
    await page.goto(VIEWER, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    const ready = await openFile(fx.file);
    const loadMs = Date.now() - t0;
    if (ready?.phase !== 'ready') {
      results.files.push({ name: fx.name, phase: ready?.phase, message: ready?.message });
      continue;
    }

    await page.getByRole('button', { name: '雙語翻譯這份 PDF' }).click();

    // 翻譯進行中連續捲 3 秒，量 fps 與最長一幀——「流暢」要有數字，不能靠看的。
    const scroll = await page.evaluate(async () => {
      window.scrollTo(0, 0);
      const t0 = performance.now();
      let frames = 0, longest = 0, last = t0;
      await new Promise((resolve) => {
        const step = (t) => {
          frames++;
          longest = Math.max(longest, t - last);
          last = t;
          window.scrollBy(0, 60);
          if (t - t0 < 3000) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const elapsed = performance.now() - t0;
      return { fps: Math.round(frames / (elapsed / 1000)), longestFrameMs: Math.round(longest) };
    });

    // 再一路捲到底，讓可視優先佇列把整份文件消化完（不捲的話只翻得到第一屏）。
    // **要捲不只一輪**：譯文掛上去之後頁面會變高，第一次「到底」的位置在譯文長出來
    // 之後就不是底了，剩下的段落永遠不會進入視窗（實測 big.pdf 因此留下 30 段未處理）。
    let done = null;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < 60; i++) {
        const atBottom = await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight * 0.9);
          return window.scrollY + window.innerHeight >= document.body.scrollHeight - 4;
        });
        await page.waitForTimeout(400);
        if (atBottom) break;
      }
      done = await settle(page);
      if (pending(done?.stats) <= 0) break;
    }
    const s = done?.stats ?? {};
    results.files.push({
      name: fx.name,
      loadMs,
      pagesRead: done?.pagesRead,
      pagesFailed: done?.pagesFailed,
      paragraphs: done?.paragraphs,
      found: s.found, done: s.done, failed: s.failed,
      engineCalls: s.engineCalls, cacheHits: s.cacheHits, cacheSize: s.cacheSize,
      skippedChinese: s.skippedChinese, skippedDetect: s.skippedDetect, skippedPack: s.skippedPack,
      availability: s.availability,
      // done === engineCalls + cacheHits 是 5c 的驗收不變式
      consistent: s.done === (s.engineCalls ?? 0) + (s.cacheHits ?? 0),
      pendingUnits: pending(s),   // 應為 0：每一段都要有去處
      ledger: done?.ledger,
      scroll,
      xyi: await page.locator('x-yi').count(),
      sample: (await page.locator('x-yi').first().textContent().catch(() => '') ?? '').slice(0, 60),
    });
    // 截圖前捲回頂端：段落總帳在統計列裡，那才是這張截圖要留的證據
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, `reports/verify-pdf-${fx.name}.png`) });

    check(s.done === (s.engineCalls ?? 0) + (s.cacheHits ?? 0),
      `${fx.name}：done(${s.done}) !== engineCalls(${s.engineCalls}) + cacheHits(${s.cacheHits})`);
    check(pending(s) === 0, `${fx.name}：還有 ${pending(s)} 段沒有去處`);
    check((s.failed ?? 0) === 0, `${fx.name}：失敗 ${s.failed} 段`);
    check(done?.pagesFailed === 0, `${fx.name}：${done?.pagesFailed} 頁讀不出文字層`);
  }

  // ── 3：錯誤處理 ───────────────────────────────────────────────────────
  const expectCase = async (label, expected, open) => {
    await page.goto(VIEWER, { waitUntil: 'domcontentloaded' });
    await open();
    const v = await waitViewer(page, (x) => x.phase === 'error' || x.phase === 'ready', 45000);
    results.errors.push({ label, expected, phase: v?.phase, message: v?.message });
    check(v?.phase === expected, `${label}：預期 ${expected}，實際 ${v?.phase}`);
  };
  const errorCase = (label, open) => expectCase(label, 'error', open);

  const byUrl = (u) => async () => {
    await page.goto(`${VIEWER}?url=${encodeURIComponent(u)}`, { waitUntil: 'domcontentloaded' });
  };
  // 「網站存取權設成點按時」的實際症狀就是 fetch 直接丟 TypeError；
  // 用一個解析不到的網域可以在不改設定的情況下走到同一條路徑。
  await errorCase('抓取失敗（權限／連線）', byUrl('https://fogone-no-such-host.invalid/a.pdf'));
  await errorCase('非 PDF', byUrl('https://example.com/'));
  await errorCase('私網位址', byUrl('http://127.0.0.1:8080/a.pdf'));
  await errorCase('損毀檔案', () => openFile(corrupt));
  await errorCase('超過 100MB', () => openFile(oversize));
  // 重新導向：assertSafePdfUrl() 只看得到最初的網址，30x 之後必須再驗一次，
  // 否則公開網址可以把我們導進內網。這兩條一正一反才算證明。
  await errorCase('重新導向到私網（應擋下）',
    byUrl('https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8099%2Fa.pdf'));
  await expectCase('重新導向後仍是公開網址（應成功載入）', 'ready', byUrl('http://bitcoin.org/bitcoin.pdf'));

  // 訊息內容也要驗：這幾條的價值就在於「有沒有講出使用者能照做的那件事」
  const said = (label, needle) => {
    const c = results.errors.find((e) => e.label === label);
    check(!!c?.message?.includes(needle), `${label}：訊息裡沒有「${needle}」（${c?.message ?? '無'}）`);
  };
  said('抓取失敗（權限／連線）', '網站存取權');
  said('私網位址', '127.0.0.1');
  said('重新導向到私網（應擋下）', '127.0.0.1');
  said('超過 100MB', '上限 100 MB');

  // ── 4：逃生口 ─────────────────────────────────────────────────────────
  const src = 'https://bitcoin.org/bitcoin.pdf';
  await page.goto(`${VIEWER}?url=${encodeURIComponent(src)}`, { waitUntil: 'domcontentloaded' });
  const opened = await waitViewer(page, (v) => v.phase === 'ready' || v.phase === 'error');
  const link = page.getByRole('link', { name: '回到原生檢視器' });
  const href = await link.getAttribute('href').catch(() => null);
  if (href) {
    await link.click();
    await page.waitForTimeout(2500);
  }
  results.escapeHatch = {
    remoteLoad: opened?.phase,
    remoteParagraphs: opened?.paragraphs,
    href,
    hrefMatchesSource: href === src,
    urlAfterClick: page.url(),
    leftViewer: !page.url().startsWith(VIEWER),
  };
  await page.screenshot({ path: path.join(ROOT, 'reports/verify-pdf-escape.png') });
  check(results.escapeHatch.hrefMatchesSource, '逃生口：href 與原網址不符');
  check(results.escapeHatch.leftViewer, '逃生口：點下去沒有離開檢視器');

  // ── 記憶體壓測（--stress N）─────────────────────────────────────────────
  // 生命週期壓測法：同一個分頁反覆開檔，每輪強制 GC 後量 heap。
  // 開檔次數增加而 heap 持續往上，就是文件沒被釋放。
  if (STRESS > 0) {
    const samples = [];
    await cdp.send('Performance.enable');
    await page.goto(VIEWER, { waitUntil: 'domcontentloaded' });
    for (let round = 0; round < STRESS; round++) {
      for (const fx of FIXTURES) await openFile(fx.file);
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(500);
      // performance.memory 只看得到「主執行緒的 JS heap」——PDF.js 跑在 worker 裡，
      // 那邊的洩漏這個數字看不到。所以同時取 CDP 的 Documents／Nodes／JSEventListeners：
      // 沒被釋放的文件與節點會直接反映在這三個數字上。
      const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
        .map((x) => [x.name, x.value]));
      samples.push({
        heapMB: await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576)),
        documents: m.Documents, nodes: m.Nodes, listeners: m.JSEventListeners,
      });
    }
    results.stress = {
      rounds: STRESS,
      // 第一輪含 PDF.js worker、字型等一次性成本；要看的是第一輪「之後」還有沒有成長。
      // 所以基準是第二輪——**至少要跑三輪**才有東西可比，兩輪的話基準就是最後一筆，
      // 差值恆為 0，看起來永遠沒漏。
      afterEachRound: samples,
      growthAfterFirstRound: samples.length > 2
        ? {
          heapMB: samples[samples.length - 1].heapMB - samples[1].heapMB,
          nodes: samples[samples.length - 1].nodes - samples[1].nodes,
          documents: samples[samples.length - 1].documents - samples[1].documents,
          listeners: samples[samples.length - 1].listeners - samples[1].listeners,
        }
        : null,
    };

    const g = results.stress.growthAfterFirstRound;
    if (g) {
      check(g.documents === 0 && g.nodes === 0 && g.listeners === 0,
        `壓測：第一輪之後仍在成長（documents ${g.documents}、nodes ${g.nodes}、listeners ${g.listeners}）`);
    }
  }

  check(results.yiErrors.length === 0, `擴充自己丟了 ${results.yiErrors.length} 個錯誤`);

  console.log(JSON.stringify(results, null, 2));
  warnIfNoExtension(yiLogs);
  console.log('screenshots → reports/verify-pdf-*.png');
  if (failures.length > 0) {
    console.error(`\n❌ 驗收未通過（${failures.length} 項）：`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 全部驗收項通過');
  }
  await page.close();
} finally {
  await close();
  localServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
