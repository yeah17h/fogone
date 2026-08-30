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
    permissions: [],
  },
});
