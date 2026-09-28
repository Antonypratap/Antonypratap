import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design-system/base.css';
import { HomePage } from './marketing/HomePage';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
);
