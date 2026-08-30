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
  const allReady = pairs.length > 0 && pairs.every((p) => p.state === 'available');

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
              (packs ? `語言包：${packs}。` : '') +
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

      {hasAPI && !allReady && (
        <>
          <p style={{ margin: '0 0 8px', color: '#5c6675' }}>
            首次使用：下載本地語言包（{SUPPORTED_SOURCES.join('、')} → 繁中）。
            下載後翻譯全程在你的裝置上進行。
          </p>
          <button onClick={enable} disabled={busy} style={btn}>
            {busy ? '下載中…' : '啟用本地翻譯'}
          </button>
          <p style={{ minHeight: 20, fontSize: 12, color: '#5c6675' }}>{progress}</p>
        </>
      )}

      {hasAPI && allReady && (
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
