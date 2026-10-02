import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App.js';
import { DiagnosticoDoApp } from './DiagnosticoDoApp.js';
import { parseRoute } from '../router.js';
import '../styles/globals.css';
import { audioCue, seletorDeFontes } from './container.desktop.js';
import { MolduraDesktop } from './MolduraDesktop.js';
import { criarModoDaJanela } from './modo-da-janela.js';
import { motivoDaQueda } from './queda.js';
import { SeletorDeFontesDesktop } from './SeletorDeFontesDesktop.js';
import { TelaDeQueda } from './TelaDeQueda.js';
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
const { pathname, search } = window.location;
// "A transmissão caiu" (D4): o main recarrega a janela em `?queda=<motivo>`.
// Lido ANTES de a normalização abaixo trocar a URL (e levar a consulta junto).
const quedaInicial = motivoDaQueda(search);
if (pathname === '/desktop.html' || parseRoute(pathname).name === 'broadcast' || quedaInicial !== null) {
  window.history.replaceState({}, '', '/');
}

// No navegador (dev em http://localhost:5174) não há ponte: vale o documento,
// e a captura é o seletor do próprio navegador.
const ponte = window.telaDesktop;
const modo = ponte === undefined ? undefined : criarModoDaJanela(ponte);
const visibilidade = ponte === undefined ? undefined : fonteDeVisibilidadeDesktop(ponte, undefined, modo);
// O DIAGNÓSTICO do trilho (D-04) vale também no navegador de dev, sem ponte.
const sobreposicao = (
  <>
    <DiagnosticoDoApp />
    {ponte === undefined ? null : <SeletorDeFontesDesktop seletor={seletorDeFontes} plataforma={ponte.plataforma} />}
  </>
);

const root = document.getElementById('root');
if (root === null) throw new Error('#root não existe no desktop.html');

/**
 * A tela de queda vem ANTES do app: nada é restaurado, e o botão leva ao
 * início como numa abertura normal.
 */
function Raiz() {
  const [queda, setQueda] = useState(quedaInicial);
  if (queda !== null) return <TelaDeQueda motivo={queda} aoVoltar={() => setQueda(null)} />;
  return (
    <MolduraDesktop
      sobreposicao={sobreposicao}
      somDeOculto={audioCue.privacidade}
      {...(ponte === undefined ? {} : { ponte })}
      {...(modo === undefined ? {} : { modo })}
      {...(visibilidade === undefined ? {} : { visibilidade })}
    >
      <App {...(visibilidade === undefined ? {} : { visibilidade })} />
    </MolduraDesktop>
  );
}

createRoot(root).render(
  <StrictMode>
    <Raiz />
  </StrictMode>,
);
