import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// also import maplibre css here as a fallback
// (already in index.html from CDN, but belt-and-suspenders)
// import 'maplibre-gl/dist/maplibre-gl.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
