import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: true,
    proxy: {
      '/api': 'http://localhost:4310',
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2022', minify: 'esbuild', sourcemap: false },
});