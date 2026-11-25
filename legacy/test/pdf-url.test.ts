// assertSafePdfUrl 的把關測試。
//
// 這是安全防線而不是一般邏輯，所以值得有自己的測試：它擋的是
// 「使用者被誘導開一次 viewer.html?url=… 就替攻擊者探測內網」。
// 兩輪 codex review 各抓到一個繞法（重新導向、IPv4-mapped IPv6），
// 都補在下面，回歸時才知道有沒有再退回去。
//
// 註：這裡直接從 lib/pdf/document.ts import，會一併載入 pdfjs-dist。
// 那在 Node 裡沒問題（只是 import，不執行 worker），換來的是**測到正式路徑本身**，
// 而不是另外抄一份 URL 判斷來測——抄一份的話遲早與正式路徑不一致。
import { describe, expect, it } from 'vitest';
import { assertSafePdfUrl } from '../lib/pdf/document';

const blocked = (u: string) => expect(() => assertSafePdfUrl(u), u).toThrow();
const allowed = (u: string) => expect(() => assertSafePdfUrl(u), u).not.toThrow();

describe('assertSafePdfUrl', () => {
  it('放行一般的公開 http/https 網址', () => {
    allowed('https://bitcoin.org/bitcoin.pdf');
    allowed('http://example.com/a.pdf');
    allowed('https://arxiv.org/pdf/2303.08774');
    allowed('https://[2606:4700::1]/a.pdf');     // 公開 IPv6
    allowed('https://172.15.0.1/a.pdf');         // 172.16~31 才是私網，15 不是
    allowed('https://11.0.0.1/a.pdf');
  });

  it('擋掉非 http/https', () => {
    blocked('file:///etc/passwd');
    blocked('chrome-extension://abc/viewer.html');
    blocked('data:application/pdf;base64,AAAA');
    blocked('javascript:alert(1)');
  });

  it('擋掉本機與區網的 IPv4', () => {
    blocked('http://127.0.0.1:8080/a.pdf');
    blocked('http://127.1.2.3/a.pdf');
    blocked('http://0.0.0.0/a.pdf');
    blocked('http://10.0.0.5/a.pdf');
    blocked('http://192.168.1.1/a.pdf');
    blocked('http://169.254.169.254/a.pdf');     // 雲端 metadata 端點
    blocked('http://172.16.0.1/a.pdf');
    blocked('http://172.31.255.255/a.pdf');
  });

  it('擋掉 localhost 與 .local 名稱', () => {
    blocked('http://localhost:3000/a.pdf');
    blocked('http://foo.localhost/a.pdf');
    blocked('http://printer.local/a.pdf');
  });

  it('擋掉 IPv6 的本機與區網', () => {
    blocked('http://[::1]/a.pdf');
    blocked('http://[::]/a.pdf');
    blocked('http://[fe80::1]/a.pdf');
    blocked('http://[fea0::1]/a.pdf');           // fe80::/10 一路到 febf
    blocked('http://[febf::1]/a.pdf');
    blocked('http://[fd00::1]/a.pdf');           // ULA
    blocked('http://[fc00::1]/a.pdf');
  });

  // codex review 第二輪抓到的繞法：URL 會把 [::ffff:127.0.0.1] 正規化成
  // [::ffff:7f00:1]，長得完全不像 127.0.0.1 卻連到同一個地方。
  it('擋掉 IPv4-mapped IPv6（兩種寫法都要）', () => {
    blocked('http://[::ffff:127.0.0.1]:8099/a.pdf');
    blocked('http://[::ffff:7f00:1]:8099/a.pdf');
    blocked('http://[::ffff:192.168.0.1]/a.pdf');
    blocked('http://[::ffff:c0a8:1]/a.pdf');
    blocked('http://[::127.0.0.1]/a.pdf');       // 已廢棄的 IPv4-compatible 寫法
    // 但 ::ffff: 後面接的是公開位址就該放行，不能一竿子打翻
    allowed('http://[::ffff:93.184.216.34]/a.pdf');
  });
});
