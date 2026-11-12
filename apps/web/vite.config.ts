import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4310';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5310,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // pdf.js ships its worker as a separate module; keep it out of the optimizer.
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
