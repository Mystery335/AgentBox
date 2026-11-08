import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Read VITE_* settings from AgentBox/.env (only VITE_* reach the browser).
  envDir: '..',
})
