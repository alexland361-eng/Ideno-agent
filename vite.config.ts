import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web client is built as static assets and served by the Ideno backend.
// In dev, Vite runs on :5173 and proxies /api to the backend on :8787.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
