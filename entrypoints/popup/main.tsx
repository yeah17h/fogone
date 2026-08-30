// popup：兩個職責——
// 1. 首次啟用：在「使用者點擊」內下載語言包（鐵律 7 的落地處）
// 2. 對目前分頁下「翻譯／關閉」指令

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SUPPORTED_SOURCES, TARGET } from '@/lib/engine';
import type { SessionStats } from '@/lib/scheduler';

type PairState = { source: string; state: string };

function usePairs() {
  const [pairs, setPairs] = useState<PairState[]>([]);
  const refresh = async () => {
    if (typeof Translator === 'undefined') return setPairs([]);
    const next = await Promise.all(
      SUPPORTED_SOURCES.map(async (source) => ({
        source,
        state: await Translator.availability({ sourceLanguage: source, targetLanguage: TARGET }),
      })),
    );
    setPairs(next);
  };
  useEffect(() => { refresh(); }, []);
  return { pairs, refresh };
}

function App() {
  const { pairs, refresh } = usePairs();
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);

  const hasAPI = typeof Translator !== 'undefined';
  // 「還沒好的語言對」不該擋住「已經好的」（#8）：只要有一對可用就給翻譯鈕，
  // 沒好的那幾對改用一行提示說清楚是哪一對、卡在什麼狀態。
  // 舊寫法用 every()，只要 ja 沒好，連英文頁都翻不了，而且畫面上完全看不出原因。
  const ready = pairs.filter((p) => p.state === 'available');
  const pending = pairs.filter((p) => p.state !== 'available');
  const anyReady = ready.length > 0;

  // 關鍵：所有 create() 在點擊的「同步階段」發起（帶手勢），下載並行
  const enable = () => {
    setBusy(true);
    const jobs = SUPPORTED_SOURCES.map((source) =>
      Translator.create({
        sourceLanguage: source,
        targetLanguage: TARGET,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            setProgress(`${source} → ${TARGET} 下載 ${Math.round((e.loaded ?? 0) * 100)}%`);
          });
        },
      }).catch((err: Error) => setProgress(`${source}：${err.message}`)),
    );
    Promise.allSettled(jobs).then(() => {
      setProgress('');
      setBusy(false);
      refresh();
    });
  };

  const [status, setStatus] = useState('');

  const send = async (type: 'yi:translate' | 'yi:off') => {
    setStatus('');
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) { setStatus('找不到目前分頁。'); return; }
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type });
      if (type === 'yi:off') { setStatus('已關閉並清除這一頁的譯文。'); return; }
      if (res?.reason === 'no-api') setStatus('此瀏覽器沒有本地翻譯 API（需要桌面版 Chrome 138+）。');
      else if (res?.already) {
        const s: SessionStats | undefined = res.stats;
        // 語言包狀態逐對列出（#3）：只看「跳過：語言包 N」分不出是沒下載還是下載中
        const packs = Object.entries(s?.availability ?? {})
          .map(([pair, state]) => `${pair} ${state}`)
          .join('、');
        setStatus(
          s
            ? `翻譯中——找到 ${s.found}、完成 ${s.done}、失敗 ${s.failed}；` +
              `跳過：中文 ${s.skippedChinese}、非英日 ${s.skippedDetect}、語言包 ${s.skippedPack}。` +
              // 引擎呼叫 vs 快取命中（#10）：驗收要靠這兩個數字，
              // 也讓使用者看得出「重翻」到底有沒有真的省下來
              // ?? 0：擴充更新後、分頁還沒重新整理時，舊 content script 回來的 stats
              // 沒有這三個欄位，直接內插會印出「引擎呼叫 undefined」
              `引擎呼叫 ${s.engineCalls ?? 0}、快取命中 ${s.cacheHits ?? 0}（存 ${s.cacheSize ?? 0} 筆）。` +
              (packs ? `語言包：${packs}。` : '') +
              // 分段策略（#2）：零遙測沒有遠端 log，診斷資訊只能放在使用者看得到的地方
              // 字幕模式（M2）：只有站點模組跑起來時才顯示，其他頁面不佔版面
              (s.site?.id
                ? `字幕（${s.site.id}）：翻譯 ${s.site.cueTranslated}、丟棄 ${s.site.cueDropped}`
                  + `、已是中文 ${s.site.cueSkippedChinese}（觀察 ${s.site.cueSeen}）；`
                  + `字幕引擎呼叫 ${s.site.cueEngineCalls}、快取命中 ${s.site.cueCacheHits}。`
                : '') +
              (s.mode === 'dense'
                ? `分段：密度備援（標準選擇器不夠用，備援多撈 ${s.fallbackFound} 個）。`
                : '分段：標準。') +
              (s.detectorBroken ? '（語言偵測器在此環境不可用，已改用備援判斷）' : '')
            : '這一頁已經在翻譯中。',
        );
      }
      else setStatus(`已啟動：先找到 ${res?.units ?? 0} 個段落，往下捲會繼續翻。`);
    } catch {
      setStatus(
        '這個分頁還沒載入翻譯程式。請重新整理該網頁後再點一次。' +
        '（安裝或更新擴充後，原本就開著的分頁都要重新整理才會生效；' +
        'chrome:// 頁面與 Chrome 商店無法翻譯。）',
      );
    }
  };

  return (
    <main style={{ width: 260, padding: 14, font: '14px/1.6 system-ui', color: '#1c2330' }}>
      <h1 style={{ fontSize: 15, margin: '0 0 8px' }}>譯（開發版）</h1>

      {!hasAPI && (
        <p style={{ color: '#b3261e' }}>
          此瀏覽器沒有本地 Translator API（需要桌面版 Chrome 138+）。
        </p>
      )}

      {hasAPI && pending.length > 0 && (
        <>
          <p style={{ margin: '0 0 8px', color: '#5c6675' }}>
            {anyReady
              ? `尚未啟用：${pending.map((p) => `${p.source}→繁中（${p.state}）`).join('、')}。`
              : `首次使用：下載本地語言包（${SUPPORTED_SOURCES.join('、')} → 繁中）。下載後翻譯全程在你的裝置上進行。`}
          </p>
          <button onClick={enable} disabled={busy} style={btn}>
            {busy ? '下載中…' : anyReady ? '啟用其餘語言包' : '啟用本地翻譯'}
          </button>
          <p style={{ minHeight: 20, fontSize: 12, color: '#5c6675' }}>{progress}</p>
        </>
      )}

      {hasAPI && anyReady && (
        <>
          <button onClick={() => send('yi:translate')} style={btn}>雙語翻譯此頁</button>
          <button onClick={() => send('yi:off')} style={{ ...btn, background: '#eef1f5', color: '#1c2330' }}>
            關閉此頁翻譯
          </button>
          <p style={{ minHeight: 18, fontSize: 12, color: '#5c6675', margin: '2px 0 0' }}>{status}</p>
        </>
      )}

      <p style={{ fontSize: 11, color: '#8a93a3', marginTop: 10 }}>
        引擎：Chrome 本地 Translator API（L0）。零遙測。
      </p>
    </main>
  );
}

const btn: React.CSSProperties = {
  display: 'block', width: '100%', marginBottom: 8, padding: '9px 12px',
  border: 0, borderRadius: 6, background: '#274690', color: '#fff',
  font: '14px system-ui', cursor: 'pointer',
};

createRoot(document.getElementById('root')!).render(<App />);
