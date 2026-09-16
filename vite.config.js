import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import keepAlive from './tools/vite-keepalive.js';

export default defineConfig({
  // Electron loads the build from disk via file://, so assets must be relative.
  base: './',
  plugins: [react(), keepAlive()],
  server: {
    port: 5173, strictPort: true,
    // A plain browser on the dev server (no window.conduit) behaves like the
    // PWA: same-origin /jf and /relay, proxied here to the LAN services. Lets
    // the dev bundle (StrictMode, unminified) be driven by puppeteer.
    proxy: {
      '/jf': { target: 'http://192.168.1.85:2101', changeOrigin: true, rewrite: (p) => p.replace(/^\/jf/, '') },
      '/relay': { target: 'ws://192.168.1.85:8788', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
