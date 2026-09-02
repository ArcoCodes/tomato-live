import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AdminChange } from './components/AdminChange.tsx'

// A separate page, not a route inside the broadcast: the live view's heartbeat is what drives
// rendering, so opening the admin page must not start filming.
const isAdmin = window.location.pathname.replace(/\/$/, '') === '/admin-change'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdmin ? <AdminChange /> : <App />}
  </StrictMode>,
)
