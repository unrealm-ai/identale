// Modified for Identale; see the root NOTICE.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { webLicenses } from '../../scripts/build/web-licenses.mjs';

export default defineConfig({
  plugins: [vue(), webLicenses({ repositoryRoot: fileURLToPath(new URL('../..', import.meta.url)) })],
  server: {
    host: '127.0.0.1', port: 15173, strictPort: true,
    proxy: { '/api': { target: process.env['DENTITY_CONTROL_PLANE_URL'] ?? 'http://127.0.0.1:18300', changeOrigin: false } },
  },
});
