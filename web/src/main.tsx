import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './styles.css';
import { App } from './App';
import { isEmbedded } from './lib/embed';
import { resolveRoute } from './lib/tenant';
import { setTenant } from './api/client';

// Resolve the tenant from the URL path ONCE, before any API call fires.
setTenant(resolveRoute().tenantSlug);

if (isEmbedded()) document.body.classList.add('embed');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
