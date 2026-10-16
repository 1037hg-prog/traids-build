import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // open:false — the dev server is a TEST sandbox (separate origin = separate
    // localStorage, so it shows different positions than the real app on :3001).
    // Auto-opening tabs at :3000 caused a "my positions changed!" false alarm
    // on 2026-07-10. The real app is always http://localhost:3001 via run.bat.
    open: false,
    host: true,
    proxy: {
      // Yahoo Finance backend (standalone on 3002) — must come before the catch-all
      '/api/yahoo': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // Everything else under /api → the App+API backend on 3001 (Claude proxy,
      // assess + assess-panel, tradelog, equities, futures, orders…). A catch-all
      // so newly added endpoints work in dev without editing this file each time.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react:    ['react', 'react-dom'],
          recharts: ['recharts'],
        },
      },
    },
  },
})
