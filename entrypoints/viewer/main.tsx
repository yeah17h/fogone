// 檢視器頁面（5a：殼）——載入 PDF、抽出文字層、把結果攤出來。
//
// 這一批只做到「開得起來、抽得到字」。段落重建是 5b、雙語渲染是 5c，
// 所以這裡刻意把「每頁抽到幾個片段、前幾段長什麼樣」直接顯示出來：
// 那是 5b 的輸入，看得見才驗得了。
//
// 本機檔案走拖放與檔案選擇器，讀的是 File 物件，**完全不經過 file://**——
// 因此不依賴使用者手動開啟「允許存取檔案網址」那個開關（見 docs/research/pdf-text-layer.md §1.5）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { openPdf, assertSafePdfUrl, MAX_PDF_BYTES, type OpenedPdf, type PageText } from '@/lib/pdf/document';

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
  pages: PageText[];
};

const MAX_PAGES_IN_SHELL = 30; // 5a 只是殼：超過就先截斷，效能調校是 5d

function App() {
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const docRef = useRef<OpenedPdf | null>(null);

  // 每次載入拿一個序號。所有 await 之後都要確認自己還是最新的那一次，
  // 否則「連續開兩份 PDF」會出現：慢的舊檔後完成、把新檔的畫面蓋掉；
  // 兩條迴圈同時寫 docRef，被蓋掉的那份文件永遠不會被釋放；
  // 甚至一邊 destroy 另一邊正在 getPageText() 的文件。
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (
    source: { kind: 'url'; url: string } | { kind: 'data'; data: ArrayBuffer },
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
      doc = await openPdf(source, ac.signal);
      if (gen !== genRef.current) return;    // 已經被下一次載入取代
      docRef.current = doc;
      const n = Math.min(doc.numPages, MAX_PAGES_IN_SHELL);
      const pages: PageText[] = [];
      for (let p = 1; p <= n; p++) {
        if (gen !== genRef.current) return;
        setStatus({ phase: 'loading', what: `${name}（抽取第 ${p}/${n} 頁文字層）` });
        pages.push(await doc.getPageText(p));
      }
      if (gen !== genRef.current) return;
      setLoaded({ sourceUrl, name, numPages: doc.numPages, title: doc.title, pages });
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
    void docRef.current?.destroy().catch(() => {});
    docRef.current = null;
  }, []);

  const takeFile = useCallback(async (file: File) => {
    if (file.size > MAX_PDF_BYTES) {
      setStatus({ phase: 'error',
        message: `檔案過大（${(file.size / 1048576).toFixed(0)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）。` });
      return;
    }
    void load({ kind: 'data', data: await file.arrayBuffer() }, file.name, null);
  }, [load]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void takeFile(f);
  }, [takeFile]);

  const totalItems = loaded?.pages.reduce((a, p) => a + p.items.length, 0) ?? 0;
  const totalChars = loaded?.pages.reduce(
    (a, p) => a + p.items.reduce((b, i) => b + i.str.length, 0), 0) ?? 0;

  return (
    <main style={S.main}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header style={S.header}>
        <div>
          <strong style={{ fontSize: 16 }}>幾個譯思 — PDF 檢視器</strong>
          <div style={S.dim}>文字層抽取（5a 殼）。雙語渲染尚未接上。</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={S.btn} onClick={() => fileInput.current?.click()}>選擇 PDF 檔…</button>
          {loaded?.sourceUrl && (
            // 逃生口：使用者永遠要能回到 Chrome 原生檢視器，不能被我們綁架
            <a style={{ ...S.btn, ...S.btnGhost }} href={loaded.sourceUrl}>回到原生檢視器</a>
          )}
        </div>
      </header>

      <input ref={fileInput} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); }} />

      {status.phase === 'idle' && (
        <div style={{ ...S.drop, ...(dragging ? S.dropActive : null) }}>
          <div style={{ fontSize: 15 }}>把 PDF 拖進這裡</div>
          <div style={S.dim}>或按右上角「選擇 PDF 檔…」。檔案只在你的瀏覽器裡處理，不會上傳。</div>
        </div>
      )}

      {status.phase === 'loading' && <p style={S.note}>載入中：{status.what}</p>}

      {status.phase === 'error' && (
        <div style={S.error}>
          <strong>開不起來</strong>
          <div style={{ marginTop: 6 }}>{status.message}</div>
        </div>
      )}

      {status.phase === 'ready' && loaded && (
        <>
          <section style={S.summary}>
            <div><b>{loaded.title ?? loaded.name}</b></div>
            <div style={S.dim}>
              {loaded.numPages} 頁
              {loaded.numPages > loaded.pages.length && `（本頁只抽前 ${loaded.pages.length} 頁）`}
              ｜文字片段 {totalItems}｜字元 {totalChars}
              ｜{totalItems > 0 ? '有文字層' : '沒有文字層（可能是掃描檔，本批不處理）'}
            </div>
          </section>
          {loaded.pages.map((p) => (
            <section key={p.pageNumber} style={S.page}>
              <div style={S.pageHead}>
                第 {p.pageNumber} 頁　{Math.round(p.width)}×{Math.round(p.height)}pt
                　片段 {p.items.length}
                　旋轉 {p.items.filter((i) => i.rotated).length}
              </div>
              <div style={S.raw}>
                {p.items.slice(0, 60).map((i, k) => (
                  <span key={k} style={S.chip} title={`x=${i.x.toFixed(1)} y=${i.y.toFixed(1)} h=${i.height.toFixed(1)}`}>
                    {i.str}
                  </span>
                ))}
                {p.items.length > 60 && <span style={S.dim}>…還有 {p.items.length - 60} 個片段</span>}
              </div>
            </section>
          ))}
        </>
      )}
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
  page: { borderTop: '1px solid #eef1f5', paddingTop: 12, marginTop: 12 },
  pageHead: { fontSize: 12, color: '#5c6675', marginBottom: 8 },
  raw: { display: 'flex', flexWrap: 'wrap', gap: '4px 6px' },
  chip: { background: '#f2f4f8', borderRadius: 4, padding: '1px 5px', fontSize: 13, whiteSpace: 'pre-wrap' },
};

createRoot(document.getElementById('root')!).render(<App />);
