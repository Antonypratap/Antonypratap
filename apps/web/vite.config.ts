import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { parseApiBase, refuseUnknownWebEnv } from './src/api-base';
import { webSecurityHeaders } from './src/security-headers';
import { checkVercelConfig } from './src/vercel-config';

export default defineConfig(({ mode }) => {
  // Only VITE_API_BASE_URL may reach the browser bundle (api-base.ts); an invalid value, or any
  // other VITE_ variable, stops the build instead of shipping something unintended.
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...pick(process.env, 'VITE_') };
  refuseUnknownWebEnv(env);
  const api = parseApiBase(env.VITE_API_BASE_URL);
  // On Vercel, vercel.json must be deployable and send exactly these headers (vercel-config.ts).
  if (process.env.VERCEL === '1')
    checkVercelConfig(
      JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as unknown,
      webSecurityHeaders(api.origin),
    );
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // The Veyra API (npm run dev:api). The browser talks to it through /api on this origin.
      proxy: { '/api': 'http://127.0.0.1:8787' },
    },
    // The production build, served with the production security headers (CSP included).
    preview: {
      port: 4173,
      strictPort: true,
      headers: webSecurityHeaders(api.origin),
      proxy: { '/api': 'http://127.0.0.1:8787' },
    },
  };
});

function pick(source: NodeJS.ProcessEnv, prefix: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (e): e is [string, string] => e[0].startsWith(prefix) && e[1] !== undefined,
    ),
  );
}
