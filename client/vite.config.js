import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  envDir: process.env.RAILWAY_ENVIRONMENT ? undefined : '../',
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
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
