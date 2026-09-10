// 檢視器頁面：載入 PDF → 抽文字層 → 重排成段落 → 雙語對照。
//
// **重排頁面就是一般的 DOM**，所以雙語走的是網頁那條路，一字未改：
// 把段落渲染成 <p>，然後 new Session(document)。可視優先佇列、語言判斷、
// 引擎、快取、<x-yi> 注入全部沿用——PDF 這邊不需要第二套翻譯管線。
//
// 段落用**命令式**寫進容器，不交給 React 管：React 之後若重繪那棵子樹，
// 會把 Session 掛上去的 <x-yi> 一起抹掉。那是別人的節點，React 不知道要留。
//
// 本機檔案走拖放與檔案選擇器，讀的是 File 物件，**完全不經過 file://**——
// 因此不依賴使用者手動開啟「允許存取檔案網址」那個開關（見 docs/research/pdf-text-layer.md §1.5）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { openPdf, assertSafePdfUrl, MAX_PDF_BYTES, type OpenedPdf, type PageText } from '@/lib/pdf/document';
import { reflow, type Paragraph } from '@/lib/pdf/reflow';
import { Session, type SessionStats } from '@/lib/scheduler';
import { unmountAll } from '@/lib/renderer';
import { LocalEngine } from '@/lib/engine';

type Status =
  | { phase: 'idle' }
  | { phase: 'loading'; what: string }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

type Loaded = {
  /** 原始網址，來自 ?url=。本機檔案沒有，逃生口也就不顯示 */
  sourceUrl: string | null;
  name: string;
  numPages: number;
  title: string | null;
  pagesRead: number;
  /** 文字層抽取失敗的頁數（損毀 PDF 常常只壞其中幾頁） */
  pagesFailed: number;
  /** 第一頁失敗的原因，用來分辨「壞掉一頁」與「整個 worker 掛了」 */
  firstPageError: string;
  paragraphs: Paragraph[];
};

// 一次讀的頁數上限。實測（scripts/verify-pdf.mjs）：9 頁雙欄論文抽字 113ms／83 段；
// 讀滿上限的 30 頁是 157ms／291 段，翻譯進行中連續捲動仍是 120fps、最長一幀 9ms。
// 也就是說上限不是為了效能——瓶頸不在這裡——而是防「幾百頁的掃描書」一次把分頁吃垮。
const MAX_PAGES = 30;

function App() {
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const docRef = useRef<OpenedPdf | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [translating, setTranslating] = useState(false);
  const [statusLine, setStatusLine] = useState('');

  // 每次載入拿一個序號。所有 await 之後都要確認自己還是最新的那一次，
  // 否則「連續開兩份 PDF」會出現：慢的舊檔後完成、把新檔的畫面蓋掉；
  // 兩條迴圈同時寫 docRef，被蓋掉的那份文件永遠不會被釋放；
  // 甚至一邊 destroy 另一邊正在 getPageText() 的文件。
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (
    // 接 File 而不是接讀好的 ArrayBuffer：`file.arrayBuffer()` 若在 load() 外面 await，
    // 那段等待不受任何 generation 管。快速連選兩個檔案時，先讀完的那個會先拿到
    // generation，於是**較早選的檔案反而變成最新的**；元件在讀取途中卸載也一樣，
    // 讀完照樣會走進來 setState。把讀取搬進 generation 的保護範圍內。
    source: { kind: 'url'; url: string } | { kind: 'file'; file: File },
    name: string,
    sourceUrl: string | null,
  ) => {
    const gen = ++genRef.current;
    abortRef.current?.abort();               // 舊的那次別再解析下去了
    const ac = new AbortController();
    abortRef.current = ac;

    setStatus({ phase: 'loading', what: name });
    setLoaded(null);
    // 換一份文件就把上一份收掉，否則 worker 那側的資源會一直累積
    const previous = docRef.current;
    docRef.current = null;
    await previous?.destroy().catch(() => {});

    let doc: OpenedPdf | null = null;
    try {
      // 大小檢查放在這裡而不是呼叫端：呼叫端擋下來的話只會 setStatus 而不動
      // generation，於是「A 還在抽字時選了過大的 B」會讓 A 完成後把 B 的錯誤蓋掉。
      // 進到這條路徑就吃得到 generation 保護。（擋在 arrayBuffer() 之前，
      // 不然 100MB 的檔案已經整包讀進記憶體才拒絕。）
      if (source.kind === 'file' && source.file.size > MAX_PDF_BYTES) {
        throw new Error(`檔案過大（${(source.file.size / 1048576).toFixed(0)} MB，`
          + `上限 ${MAX_PDF_BYTES / 1048576} MB）。`);
      }
      const opened = source.kind === 'file'
        ? { kind: 'data' as const, data: await source.file.arrayBuffer() }
        : source;
      if (gen !== genRef.current) return;
      doc = await openPdf(opened, ac.signal);
      if (gen !== genRef.current) return;    // 已經被下一次載入取代
      docRef.current = doc;
      const n = Math.min(doc.numPages, MAX_PAGES);
      const pages: PageText[] = [];
      // 單頁抽字失敗不該讓整份文件開不起來：損毀的 PDF 常常只壞其中幾頁，
      // 其餘照樣讀得出來。全部頁都失敗才算這份檔案開不起來。
      // **但要留下原因**：這個 catch 也會吞掉 worker 崩潰之類的系統性錯誤，
      // 只記個數字的話畫面上會變成「少了幾頁，不知道為什麼」——零遙測產品
      // 沒有遠端 log 可以事後追，診斷只能留在使用者看得到的地方。
      let pagesFailed = 0;
      let firstPageError = '';
      for (let p = 1; p <= n; p++) {
        if (gen !== genRef.current) return;
        setStatus({ phase: 'loading', what: `${name}（抽取第 ${p}/${n} 頁文字層）` });
        try {
          pages.push(await doc.getPageText(p));
        } catch (e) {
          pagesFailed++;
          if (!firstPageError) firstPageError = e instanceof Error ? e.message : String(e);
        }
      }
      if (gen !== genRef.current) return;
      if (pages.length === 0) {
        // 這份文件已經沒有用處了。docRef 清掉之後，下面的 finally 會負責釋放它——
        // 留著的話它要等到「下一次載入或離開頁面」才會被收。
        docRef.current = null;
        throw new Error(`這份 PDF 的 ${n} 頁全部無法讀取文字層，檔案可能已損毀`
          + `${firstPageError ? `（${firstPageError}）` : ''}。`);
      }
      const paragraphs = reflow(pages);
      setLoaded({ sourceUrl, name, numPages: doc.numPages, title: doc.title,
                  // pagesRead 是「這次嘗試讀的頁數」，不是「成功的頁數」——
                  // 用成功數的話，10 頁壞 1 頁會顯示成「本次讀取前 9 頁」，那是假的。
                  pagesRead: n, pagesFailed, firstPageError, paragraphs });
      setStatus({ phase: 'ready' });
      doc = null;                            // 交棒給 docRef，不要在 finally 收掉
    } catch (e) {
      if (gen !== genRef.current || ac.signal.aborted) return; // 被取代的失敗不必吵使用者
      setStatus({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      // 這一次已經不作數（被取代或卸載）卻已經開好文件 → 在這裡收掉，
      // 否則它不在 docRef 裡，就再也沒有人會釋放它
      if (doc && (gen !== genRef.current || doc !== docRef.current)) {
        await doc.destroy().catch(() => {});
      }
    }
  }, []);

  // ?url= 自動載入（popup 的「用 Fogone 開啟這份 PDF」走這條）
  useEffect(() => {
    const u = new URLSearchParams(location.search).get('url');
    if (!u) return;
    // 先驗再用：驗過的網址才會被 fetch，也才會被放進「回到原生檢視器」的 href
    let safe: URL;
    try { safe = assertSafePdfUrl(u); }
    catch (e) { setStatus({ phase: 'error', message: e instanceof Error ? e.message : String(e) }); return; }
    let name = safe.href;
    try { name = decodeURIComponent(safe.pathname.split('/').pop() || safe.href); } catch { /* 檔名怪就用網址 */ }
    void load({ kind: 'url', url: safe.href }, name, safe.href);
  }, [load]);

  // 卸載：停掉進行中的載入（genRef 前進讓它自己收尾），再釋放已開啟的文件
  useEffect(() => () => {
    genRef.current++;
    abortRef.current?.abort();
    sessionRef.current?.stop();
    sessionRef.current = null;
    void docRef.current?.destroy().catch(() => {});
    docRef.current = null;
  }, []);

  // 停掉翻譯並清乾淨。**先 stop 再 unmountAll**：反過來的話已排入佇列的工作
  // 還會繼續把譯文掛回剛清空的頁面上。
  const stopTranslation = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    unmountAll(document);
    setTranslating(false);
    setStats(null);
    setStatusLine('');
  }, []);

  // 命令式把段落寫進容器。React 不管這棵子樹，Session 掛上去的 <x-yi>
  // 才不會在下一次重繪時被抹掉。
  useEffect(() => {
    const host = articleRef.current;
    if (!host) return;
    stopTranslation();
    host.replaceChildren();
    if (!loaded) return;
    let lastPage = 0;
    for (const para of loaded.paragraphs) {
      if (para.page !== lastPage) {
        const marker = document.createElement('div');
        marker.textContent = `第 ${para.page} 頁`;
        // data-yi-skip：頁碼標記是我們自己加的介面文字，不該被當成內容翻譯
        marker.dataset.yiSkip = '';
        Object.assign(marker.style, {
          font: '12px system-ui', color: '#8a93a3', margin: '26px 0 10px',
          borderTop: '1px solid #eef1f5', paddingTop: 8,
        });
        host.append(marker);
        lastPage = para.page;
      }
      const p = document.createElement('p');
      p.textContent = para.text;
      Object.assign(p.style, { margin: '0 0 14px', lineHeight: '1.8' });
      host.append(p);
    }
  }, [loaded, stopTranslation]);

  const startTranslation = useCallback(() => {
    if (!LocalEngine.supported()) {
      setStatusLine('這個瀏覽器沒有本地 Translator API（需要桌面版 Chrome 138+）。');
      return;
    }
    stopTranslation();
    const session = new Session(document);
    sessionRef.current = session;
    const found = session.start();
    setTranslating(true);
    setStats({ ...session.stats });
    setStatusLine(found === 0 ? '沒有找到可翻譯的段落。' : '');
  }, [stopTranslation]);

  // 統計列要會動：翻譯是非同步的，不輪詢就只看得到起跑那一瞬間的數字。
  useEffect(() => {
    if (!translating) return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (session) setStats({ ...session.stats });
    }, 400);
    return () => clearInterval(timer);
  }, [translating]);

  // 段落去向的總帳。
  //
  // 「完成 0」在畫面上跟「壞掉了」長得一模一樣——中文 PDF 全部被跳過是**正確行為**
  // （zh→zh-Hant 沒有東西可翻），但不講的話使用者只會看到一個不動的 0。
  // 所以不是只在完成 0 時才解釋，而是**每一段都要有去處**。
  //
  // 加總必為段落總數，這是算式保證的（不是靠事後檢查）：三個推算格
  // 「過短未收 = 總數 − 找到」「尚未捲到 = 找到 − 已排隊」「處理中 = 已排隊 − 各種結局」
  // 一路把差額吸收掉。
  // 所以這裡沒有「其他」那一格——它在數學上永遠是 0，留著只是假裝有在檢查。
  // 真的出事時看得出來的是**負數**：分段器收到的單位比段落還多（例如檢視器自己的
  // 介面文字被當成內容收走）會讓「過短未收」變成負的，那一眼就知道不對勁。
  const ledger = (() => {
    if (!stats || !loaded) return '';
    const total = loaded.paragraphs.length;
    // 分段器會濾掉太短、沒有字母的段落（PDF 常見的殘留編號、頁碼、單一符號），
    // 那些根本沒進佇列，統計裡看不到，只能用「總數 − 找到」反推。
    const notCollected = total - stats.found;
    // 「還沒進視窗」與「進了視窗正在跑」是兩回事，不能都叫「尚未捲到」——
    // 剛按下翻譯時首屏那幾段明明正在打引擎，卻被講成沒捲到，那是假的。
    // stats.queued 正好把兩者分開：進過視窗的才會被 enqueue。
    const notQueued = stats.found - stats.queued;
    const inFlight = stats.queued - stats.done - stats.failed
      - stats.skippedChinese - stats.skippedDetect - stats.skippedPack;
    const packs = Object.entries(stats.availability).map(([p, s]) => `${p} ${s}`).join('、');
    const buckets: [string, number][] = [
      ['完成', stats.done],
      ['已是中文', stats.skippedChinese],
      ['非英日文', stats.skippedDetect],
      [`語言包未就緒${packs ? `（${packs}）` : ''}`, stats.skippedPack],
      ['失敗', stats.failed],
      ['過短未收', notCollected],
      ['尚未捲到', notQueued],
      ['處理中', inFlight],
    ];
    const parts = buckets.filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`);
    return `段落 ${total}——${parts.join('、')}。`;
  })();

  // build:test 產物才有：讓 scripts/verify-pdf.mjs 直接讀數字，
  // 不必去解析畫面上的中文句子（那種解析一改文案就無聲壞掉）。
  if (__YI_TESTING__) {
    (window as unknown as Record<string, unknown>).__yiViewer = {
      // 載入序號：同一個分頁連開多份檔案時，沒有它就分不出畫面上的 ready
      // 是這次的還是上一份留下的（壓測迴圈會誤判成「載入完成」）。
      gen: genRef.current,
      phase: status.phase,
      message: status.phase === 'error' ? status.message : '',
      paragraphs: loaded?.paragraphs.length ?? 0,
      pagesRead: loaded?.pagesRead ?? 0,
      pagesFailed: loaded?.pagesFailed ?? 0,
      ledger,
      stats,
    };
  }

  const takeFile = useCallback((file: File) => {
    void load({ kind: 'file', file }, file.name, null);
  }, [load]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void takeFile(f);
  }, [takeFile]);

  return (
    <main style={S.main}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header style={S.header} data-yi-skip="">
        <div>
          <strong style={{ fontSize: 16 }}>幾個譯思 — PDF 檢視器</strong>
          <div style={S.dim}>重排成段落後雙語對照。檔案只在你的瀏覽器裡處理，不會上傳。</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {loaded && (translating
            ? <button style={{ ...S.btn, ...S.btnGhost }} onClick={stopTranslation}>關閉翻譯</button>
            : <button style={S.btn} onClick={startTranslation}>雙語翻譯這份 PDF</button>)}
          <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => fileInput.current?.click()}>選擇 PDF 檔…</button>
          {loaded?.sourceUrl && (
            // 逃生口：使用者永遠要能回到 Chrome 原生檢視器，不能被我們綁架
            <a style={{ ...S.btn, ...S.btnGhost }} href={loaded.sourceUrl}>回到原生檢視器</a>
          )}
        </div>
      </header>

      <input ref={fileInput} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); }} />

      {status.phase === 'idle' && (
        <div style={{ ...S.drop, ...(dragging ? S.dropActive : null) }} data-yi-skip="">
          <div style={{ fontSize: 15 }}>把 PDF 拖進這裡</div>
          <div style={S.dim}>或按右上角「選擇 PDF 檔…」。檔案只在你的瀏覽器裡處理，不會上傳。</div>
        </div>
      )}

      {status.phase === 'loading' && <p style={S.note} data-yi-skip="">載入中：{status.what}</p>}

      {status.phase === 'error' && (
        <div style={S.error} data-yi-skip="">
          <strong>開不起來</strong>
          <div style={{ marginTop: 6 }}>{status.message}</div>
        </div>
      )}

      {status.phase === 'ready' && loaded && (
        // data-yi-skip：統計列是我們自己的介面文字。不標的話，段落數少到啟動密度備援時
        // 它會被當成內容收進去翻——統計列翻譯自己，總帳也就對不上了。
        <section style={S.summary} data-yi-skip="">
          <div><b>{loaded.title ?? loaded.name}</b></div>
          <div style={S.dim}>
            {loaded.numPages} 頁
            {loaded.numPages > loaded.pagesRead && `（本次讀取前 ${loaded.pagesRead} 頁）`}
            {loaded.pagesFailed > 0
              && `｜${loaded.pagesFailed} 頁讀不出文字層（${loaded.firstPageError}）`}
            ｜段落 {loaded.paragraphs.length}
            {stats && `｜完成 ${stats.done}｜引擎呼叫 ${stats.engineCalls}｜快取命中 ${stats.cacheHits}`}
            {stats && stats.failed > 0 && `｜失敗 ${stats.failed}`}
          </div>
          {statusLine && <div style={{ ...S.dim, marginTop: 4 }}>{statusLine}</div>}
          {ledger && <div style={{ ...S.dim, marginTop: 4 }}>{ledger}</div>}
        </section>
      )}

      {/* 段落容器：交給下面的 effect 命令式填內容，React 不碰它的子節點 */}
      <article ref={articleRef} style={S.article} />
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { font: '14px/1.7 system-ui, -apple-system, sans-serif', color: '#1c2330',
          maxWidth: 900, margin: '0 auto', padding: '20px 24px 80px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            gap: 16, paddingBottom: 14, borderBottom: '1px solid #e3e7ee', marginBottom: 20 },
  dim: { color: '#5c6675', fontSize: 12 },
  btn: { padding: '8px 14px', border: 0, borderRadius: 6, background: '#274690', color: '#fff',
         font: '14px system-ui', cursor: 'pointer', textDecoration: 'none', display: 'inline-block' },
  btnGhost: { background: '#eef1f5', color: '#1c2330' },
  drop: { border: '2px dashed #c6cedb', borderRadius: 10, padding: '56px 20px',
          textAlign: 'center', color: '#5c6675' },
  dropActive: { borderColor: '#274690', background: '#f2f6ff' },
  note: { color: '#5c6675' },
  error: { border: '1px solid #f0c2bd', background: '#fdf3f2', color: '#8c2f26',
           borderRadius: 8, padding: '14px 16px' },
  summary: { background: '#f6f8fb', borderRadius: 8, padding: '12px 14px', marginBottom: 18 },
  article: { maxWidth: 760, font: '16px/1.8 system-ui, -apple-system, sans-serif' },
};

createRoot(document.getElementById('root')!).render(<App />);
