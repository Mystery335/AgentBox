import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { StdbProvider } from './stdb.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StdbProvider>
      <App />
    </StdbProvider>
  </StrictMode>,
)
