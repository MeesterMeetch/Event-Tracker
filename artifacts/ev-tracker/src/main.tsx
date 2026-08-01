import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';

import './index.css';

// When deployed as a separate Render Static Site, point the API client at the
// Render Web Service URL.  Set VITE_API_BASE_URL in the Render static site's
// environment to e.g. "https://ev-tracker-api.onrender.com".  When the var is
// absent the client uses relative /api paths, which works when frontend and
// API are served from the same origin (Replit, or a proxied setup).
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
if (apiBaseUrl) {
  setBaseUrl(apiBaseUrl);
}

createRoot(document.getElementById('root')!).render(<App />);
