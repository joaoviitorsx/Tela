import { type PresetId, type Prioridade } from '@tela/shared';
import { useEffect } from 'react';
import { Abertura } from './components/Abertura.js';
import { useAbertura } from './react/use-abertura.js';
import { Home } from './routes/Home.js';

type Props = {
  readonly comAbertura: boolean;
  readonly onStart: (slug: string, presetId: PresetId, audioDeviceId: string | null, prioridade: Prioridade) => void;
};

/**
 * A tela inicial, com ou sem a abertura, num módulo só para virar UM chunk.
 *
 * `App` carrega isto com `React.lazy`: quem abre o link de um amigo (`/<canal>`)
 * não precisa de `Home`, de `Abertura` nem do seletor de captura, e baixava os
 * três junto com o espectador. A abertura vive aqui, e não em `App`, para que
 * `useAbertura` e `Abertura` entrem no chunk da home e saiam do principal.
 */
export function PaginaHome({ comAbertura, onStart }: Props) {
  useEffect(() => {
    // Quem está na home é, quase sempre, quem vai transmitir: o chunk da
    // transmissão desce em tempo ocioso, para o clique em COMEÇAR não cair no
    // fallback. Nunca roda no espectador — ele não passa por aqui.
    const baixar = () => void import('./routes/Broadcast.js');
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(baixar, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(baixar, 1500);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <>
      {/*
        A abertura só existe na tela inicial, e só na primeira visita. Ela
        fica ANTES da home no DOM porque é `position: fixed` com
        `pointer-events: none` — a home embaixo está montada, interativa e
        opaca desde `t = 0` (§7 da coreografia). Se o WebGL falhar, o
        usuário não perde nada além da cena.
      */}
      {comAbertura ? <AberturaDaHome /> : null}
      <Home onStart={onStart} />
    </>
  );
}

/**
 * A abertura vive num componente próprio para nascer e morrer com a rota.
 *
 * `useAbertura` mede o DOM da home no primeiro efeito, então ele precisa rodar
 * depois de a home existir e sumir quando ela sair. Um hook chamado direto em
 * `App` continuaria montado ao navegar para `/transmitir`, e o `dispose()` do
 * contexto WebGL só aconteceria no fechamento da aba.
 */
function AberturaDaHome() {
  const { montado, canvasRef } = useAbertura();
  return <Abertura canvasRef={canvasRef} montado={montado} />;
}
