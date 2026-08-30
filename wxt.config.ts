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
    name: '譯 — 本地雙語翻譯（開發版）',
    description: '預設在你的裝置上完成翻譯，文字不出裝置。',
    permissions: [],
  },
});
