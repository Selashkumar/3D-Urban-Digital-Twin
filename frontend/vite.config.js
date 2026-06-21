import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CesiumJS is loaded as a pre-built script from /public/cesium/Cesium.js
// (copied from node_modules/cesium/Build/Cesium/ by npm run setup:cesium)
// This avoids all bundler issues with CesiumJS WebWorkers and WASM modules.

export default defineConfig({
  plugins: [react()],
  define: {
    // Just in case any cesium module checks this env
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
