import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      // HMR can be disabled with DISABLE_HMR in constrained environments.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
