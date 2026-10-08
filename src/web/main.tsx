import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { detectRefraction } from './theme';
import './styles/tokens.css';
import './styles/app.css';

// Liquid Glass refraction is a progressive enhancement: only browsers that
// support url() filters inside backdrop-filter (Chromium) get the lens.
if (detectRefraction()) {
  document.documentElement.classList.add('refract');
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
