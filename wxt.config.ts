import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      // 測試建置旗標：npm run build:test 會開啟開發觸發器（見 content.ts）
      __YI_TESTING__: JSON.stringify(process.env.YI_TESTING === '1'),
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
