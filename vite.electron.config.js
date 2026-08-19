import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Bản build cho app desktop: nạp từ file:// nên đường dẫn asset phải tương đối
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist-app', emptyOutDir: true },
})
