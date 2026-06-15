/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

// 從 package.json 讀版號，build 時注入成 __APP_VERSION__，UI 顯示的版本永遠跟著實際 build 走
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  test: {
    // calc/store 都是純邏輯，用 node 環境；store 測試內手動 polyfill window+localStorage
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
