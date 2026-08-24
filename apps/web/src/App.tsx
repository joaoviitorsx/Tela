import { type PresetId } from '@tela/shared';
import { useState } from 'react';
import { Abertura } from './components/Abertura.js';
import { useAbertura } from './react/use-abertura.js';
import { Broadcast } from './routes/Broadcast.js';
import { Home } from './routes/Home.js';
import { NotFound } from './routes/NotFound.js';
import { Recover } from './routes/Recover.js';
import { Viewer } from './routes/Viewer.js';
import { useRoute } from './router.js';

export function App() {
  const { route, navigate } = useRoute();
  const [pending, setPending] = useState<{
    slug: string;
    presetId: PresetId;
    audioDeviceId: string | null;
  } | null>(null);

  switch (route.name) {
    case 'home':
      return (
        <>
          {/*
            A abertura só existe na tela inicial, e só na primeira visita. Ela
            fica ANTES da home no DOM porque é `position: fixed` com
            `pointer-events: none` — a home embaixo está montada, interativa e
            opaca desde `t = 0` (§7 da coreografia). Se o WebGL falhar, o
            usuário não perde nada além da cena.
          */}
          <AberturaDaHome />
          <Home
            onStart={(slug, presetId, audioDeviceId) => {
              setPending({ slug, presetId, audioDeviceId });
              navigate('/transmitir');
            }}
          />
        </>
      );

    case 'broadcast':
      // Chegar em /transmitir por link direto (F5, favorito) não tem contexto
      // de slug — volta para a home em vez de mostrar uma tela quebrada.
      if (pending === null) {
        return (
          <Home
            onStart={(slug, presetId, audioDeviceId) => {
              setPending({ slug, presetId, audioDeviceId });
              navigate('/transmitir');
            }}
          />
        );
      }
      return (
        <Broadcast
          slug={pending.slug}
          presetId={pending.presetId}
          audioDeviceId={pending.audioDeviceId}
          onExit={() => {
            setPending(null);
            navigate('/');
          }}
        />
      );

    case 'viewer':
      return <Viewer slug={route.slug} />;

    case 'recover':
      return <Recover onBack={() => navigate('/')} />;

    case 'not-found':
      return <NotFound onHome={() => navigate('/')} />;
  }
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
