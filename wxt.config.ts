import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      // 測試建置旗標：npm run build:test 會開啟開發觸發器（見 content.ts）。
      // 認 npm 的腳本名而不是 `YI_TESTING=1 wxt build`：那種環境變數語法 Windows cmd 跑不起來。
      // 也不用 `--mode test`：非 production mode 會換成 React 開發版 runtime 並改輸出目錄，
      // 測試產物就不再是正式版的同一份程式碼。
      __YI_TESTING__: JSON.stringify(process.env.npm_lifecycle_event === 'build:test'),
    },
  }),
  manifest: {
    name: '幾個譯思 Fogone',
    description: '本地雙語翻譯——預設在你的裝置上完成，內容不離開電腦。',
    // 不要任何 chrome.* API 權限
    permissions: [],
    // 明講而不是隱含：content_scripts 的 matches 本來就已讓 Chrome 授予
    // origins: ["<all_urls>"]（實測 chrome.permissions.getAll()），
    // 檢視器抓遠端 PDF 靠的就是它。欄位空著雖然「技術上為真」，
    // 但 manifest 是最權威的揭露文件，讓人以為沒有主機權限就是誤導。
    // 宣告出來不會擴大任何實際範圍，安裝警告文字也不變。
    host_permissions: ['<all_urls>'],
  },
});
