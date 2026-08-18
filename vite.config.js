import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Đường dẫn con khi deploy lên GitHub Pages (hoangduytn1703.github.io/download-video)
  base: '/download-video/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
