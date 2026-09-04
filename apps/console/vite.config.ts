import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发代理：/api → Agent9（相对路径模式无需跨域）。可用 VITE_AGENT9_BASE_URL 覆盖目标。
const target = process.env.VITE_AGENT9_BASE_URL || 'https://us-west-2.staging.agent.mem9.ai/';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5272,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/livez': { target, changeOrigin: true },
      '/readyz': { target, changeOrigin: true },
    },
  },
});
