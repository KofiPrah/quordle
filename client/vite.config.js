import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  envDir: '../',
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    allowedHosts: ['tomorrow-stood-warriors-needs.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
    hmr: {
      clientPort: 443,
    },
  },
});
