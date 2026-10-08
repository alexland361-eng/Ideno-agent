import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * STATIC PREVIEW config — simulates static hosting (GitHub Pages).
 *
 * Unlike the dev config, this has NO server.proxy: /api/* returns 404,
 * which is exactly what the deployed UI experiences on a static host and
 * what boots the clearly-labeled offline demo mode.
 *
 *   npm run build && npx vite preview --config vite.preview.config.ts
 */
export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [react()],
  // No SPA history fallback: unknown paths 404 like a real static host.
  // (The app has no URL routes — view switching is in-page state.)
  appType: 'mpa',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  preview: {
    allowedHosts: true,
  },
});
