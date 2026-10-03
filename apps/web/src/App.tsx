import { type PresetId, type Prioridade } from '@tela/shared';
import { lazy, Suspense, useState } from 'react';
import { type FonteDeVisibilidade, useAbaVisivel } from './react/use-aba-visivel.js';
import { parseRoute, useRoute } from './router.js';

/*
  Cada rota é um chunk. Quem abre `/<canal>` baixa o espectador e só ele: sem
  `BroadcastSession`, sem a captura, sem a home e sem a abertura (medido em
  `docs/engenharia/estudo/3-latencia-espectador-host.md`, "Aplicado"). O custo é
  uma viagem a mais antes da primeira pintura; o ganho é bytes no celular de
  quem só vai assistir. O three.js continua sendo importado sob demanda por
  `use-abertura`, dentro do chunk da home.
*/
const carregarViewer = () => import('./routes/Viewer.js');
const carregarBroadcast = () => import('./routes/Broadcast.js');
const carregarRecover = () => import('./routes/Recover.js');
const carregarNotFound = () => import('./routes/NotFound.js');
const carregarHome = () => import('./pagina-home.js');

const Viewer = lazy(() => carregarViewer().then((m) => ({ default: m.Viewer })));
const Broadcast = lazy(() => carregarBroadcast().then((m) => ({ default: m.Broadcast })));
const Recover = lazy(() => carregarRecover().then((m) => ({ default: m.Recover })));
const NotFound = lazy(() => carregarNotFound().then((m) => ({ default: m.NotFound })));
const PaginaHome = lazy(() => carregarHome().then((m) => ({ default: m.PaginaHome })));

/*
  A viagem a mais da rota sob demanda começa JÁ, na carga deste módulo — em
  paralelo com o React subir —, e não quando o `lazy` renderizar. Quem abre o
  link de um amigo é o caso que mais importa: o chunk do espectador chega junto
  com o resto. O `import()` repetido reaproveita o mesmo módulo.
*/
const PRIMEIRA_ROTA: Readonly<Record<ReturnType<typeof parseRoute>['name'], () => Promise<unknown>>> = {
  viewer: carregarViewer,
  home: carregarHome,
  broadcast: carregarHome,
  recover: carregarRecover,
  'not-found': carregarNotFound,
};
void PRIMEIRA_ROTA[parseRoute(window.location.pathname).name]().catch(() => undefined);

/**
 * Fundo de carregamento: o mesmo grafite do app, e o rótulo só aparece depois
 * de 400 ms. Num chunk em cache a troca dura menos que isso e o usuário vê
 * apenas a cor de fundo — nada pisca. Em rede lenta o rótulo entra suave.
 * Sem movimento contínuo: um `fade-in` e para (a regra do CRT, globals.css).
 */
function Carregando() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh items-center justify-center bg-deep">
      <p
        className="entra m-0 font-[family-name:var(--font-pixel)] text-[10px] tracking-[0.2em] text-dim"
        style={{ animationDelay: '400ms' }}
      >
        SINTONIZANDO…
      </p>
    </div>
  );
}

type Props = {
  /** Só o app desktop passa: lá é o processo principal que sabe se a janela aparece. */
  readonly visibilidade?: FonteDeVisibilidade;
};

export function App({ visibilidade }: Props = {}) {
  const { route, navigate } = useRoute();
  // Pausa as animações CSS com a aba escondida: quem transmite deixa a página
  // atrás do jogo durante horas.
  useAbaVisivel(visibilidade);
  const [pending, setPending] = useState<{
    slug: string;
    presetId: PresetId;
    audioDeviceId: string | null;
    prioridade: Prioridade;
  } | null>(null);

  const comecar = (slug: string, presetId: PresetId, audioDeviceId: string | null, prioridade: Prioridade) => {
    setPending({ slug, presetId, audioDeviceId, prioridade });
    navigate('/transmitir');
  };

  return <Suspense fallback={<Carregando />}>{rota()}</Suspense>;

  function rota() {
    switch (route.name) {
      case 'home':
        return <PaginaHome comAbertura onStart={comecar} />;

      case 'broadcast':
        // Chegar em /transmitir por link direto (F5, favorito) não tem contexto
        // de slug — volta para a home em vez de mostrar uma tela quebrada.
        if (pending === null) return <PaginaHome comAbertura={false} onStart={comecar} />;
        return (
          <Broadcast
            slug={pending.slug}
            presetId={pending.presetId}
            audioDeviceId={pending.audioDeviceId}
            prioridade={pending.prioridade}
            onExit={() => {
              setPending(null);
              navigate('/');
            }}
          />
        );

      case 'viewer':
        // `key`: outro canal (link do app, ASSISTIR, voltar) é outra tela — o
        // estado da multivisão nasce da rota. A troca interna usa
        // `replaceState`, que não muda a rota, então não remonta nada.
        return <Viewer key={route.canais.join('+')} canais={route.canais} />;

      case 'recover':
        return <Recover onBack={() => navigate('/')} />;

      case 'not-found':
        return <NotFound onHome={() => navigate('/')} />;
    }
  }
}
