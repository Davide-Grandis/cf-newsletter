import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import product from '../package.json';

// Build output is consumed by the admin worker via the [assets] binding.
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_PRODUCT_VERSION': JSON.stringify(product.version),
    'import.meta.env.VITE_PRODUCT_COMMIT': JSON.stringify(process.env.PRODUCT_COMMIT ?? 'development'),
  },
  build: {
    outDir: '../workers/admin/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
