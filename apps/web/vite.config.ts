import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { WEB_SECURITY_HEADERS } from './src/security-headers';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The Veyra API (npm run dev:api). The browser only ever talks to /api/v1.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  // The production build, served with the production security headers (CSP included).
  preview: {
    port: 4173,
    strictPort: true,
    headers: WEB_SECURITY_HEADERS,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
