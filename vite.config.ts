import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Honour PORT when the launcher assigns one; fall back to Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
})
