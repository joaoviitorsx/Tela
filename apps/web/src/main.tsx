import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/globals.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root não existe no index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
