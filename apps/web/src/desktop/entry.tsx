import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App.js';
import { parseRoute } from '../router.js';
import '../styles/globals.css';
import { MolduraDesktop } from './MolduraDesktop.js';
import { fonteDeVisibilidadeDesktop } from './visibilidade-desktop.js';

/**
 * A entrada do renderer do Tela Desktop: o `main.tsx` da web dentro da
 * moldura do app (PLANO-desktop §3.6, §11).
 *
 * O caminho é normalizado ANTES de o roteador ler. `/desktop.html` é como o
 * arquivo chega pelo dev server ou pelo protocolo do app, e para o roteador
 * é "não encontrado". E `/transmitir` depois de um recarregamento não tem
 * sessão nenhuma — a web mostra a home com a URL antiga, mas aqui a URL antiga
 * deixaria o trilho travado numa transmissão que não existe.
 */
const { pathname } = window.location;
if (pathname === '/desktop.html' || parseRoute(pathname).name === 'broadcast') {
  window.history.replaceState({}, '', '/');
}

// No navegador (dev em http://localhost:5174) não há ponte: vale o documento.
const visibilidade = window.telaDesktop === undefined ? undefined : fonteDeVisibilidadeDesktop(window.telaDesktop);

const root = document.getElementById('root');
if (root === null) throw new Error('#root não existe no desktop.html');

createRoot(root).render(
  <StrictMode>
    <MolduraDesktop>
      <App {...(visibilidade === undefined ? {} : { visibilidade })} />
    </MolduraDesktop>
  </StrictMode>,
);
