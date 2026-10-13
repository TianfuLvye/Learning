import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiPort = Number(process.env.PORT || 3001);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'shared') },
  },
  server: {
    port: Number(process.env.CLIENT_PORT || 5173),
    fs: { allow: [path.resolve(__dirname)] },
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
  build: { outDir: path.resolve(__dirname, 'dist/client'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
