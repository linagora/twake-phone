import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { registerServiceWorker } from './push.js'
import './styles.css'

// It shows the notifications of calls (step 5), and asks nothing by itself.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
