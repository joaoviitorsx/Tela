import { type PresetId } from '@tela/shared';
import { useState } from 'react';
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
        <Home
          onStart={(slug, presetId, audioDeviceId) => {
            setPending({ slug, presetId, audioDeviceId });
            navigate('/transmitir');
          }}
        />
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
