import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioUnlock } from '../components/AudioUnlock.js';
import { IconFullscreen } from '../components/Icon.js';
import { LiveDot } from '../components/LiveDot.js';
import { OfflineState } from '../components/OfflineState.js';
import { createViewerSession } from '../container.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useHotkeys, useTabTitle } from '../react/use-page-effects.js';
import { useViewer } from '../react/use-viewer.js';

type Props = { readonly slug: string };

/**
 * A tela que decide o produto.
 *
 * Vídeo em 100% da viewport desde o primeiro frame. Sem header, sem sidebar,
 * sem logo, sem contador de likes. O amigo abriu o link para ver o jogo.
 */
export function Viewer({ slug }: Props) {
  const session = useMemo(() => createViewerSession(), []);
  const state = useViewer(session);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const watching = state.status === 'watching';
  const controls = useAutoHide(2_000, watching);
  const stats = useMediaStats(watching ? state.stats : null);

  useTabTitle(watching ? `● tela.gg/${slug}` : `${slug} · tela`);

  useEffect(() => {
    void session.open(slug);
    return () => {
      void session.close();
    };
  }, [session, slug]);

  // `srcObject` não é atributo — precisa ser atribuído na instância.
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !watching) return;
    if (element.srcObject !== state.stream) element.srcObject = state.stream;
    void element.play().catch(() => undefined);
  }, [watching, state]);

  const unlock = useCallback(() => {
    setMuted(false);
    const element = videoRef.current;
    if (element) {
      element.muted = false;
      void element.play().catch(() => undefined);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = videoRef.current?.parentElement;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen().catch(() => undefined);
  }, []);

  useHotkeys(
    useMemo(
      () => ({
        f: toggleFullscreen,
        ' ': () => setMuted((current) => !current),
      }),
      [toggleFullscreen],
    ),
    watching,
  );

  useEffect(() => {
    const element = videoRef.current;
    if (element) element.muted = muted;
  }, [muted]);

  if (!watching) {
    return (
      <main className="min-h-full">
        <OfflineState
          slug={slug}
          motivo={
            state.status === 'full'
              ? 'cheio'
              : state.status === 'sem-conexao'
                ? 'sem-conexao'
                : state.status === 'sem-servidor'
                  ? 'sem-servidor'
                  : 'offline'
          }
        />
      </main>
    );
  }

  const hasAudio = state.hasAudio;

  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-void"
      onMouseMove={controls.show}
      onDoubleClick={toggleFullscreen}
    >
      {/*
        `muted` obrigatório no primeiro play: sem isso o browser bloqueia o
        autoplay inteiro e o espectador vê tela preta em vez de vídeo.
      */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className="h-full w-full bg-void object-contain"
      />

      {hasAudio && muted && <AudioUnlock onUnlock={unlock} />}

      <div
        className={[
          'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-4 p-4',
          'bg-gradient-to-t from-void/80 to-transparent transition-opacity duration-300',
          controls.visible ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        <LiveDot />
        {/* Latência visível: é prova da qualidade, e este público repara. */}
        <span className="tabular ml-auto text-[12px] text-muted">{stats.rtt}</span>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label="Tela cheia"
          className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface hover:text-text"
        >
          <IconFullscreen />
        </button>
      </div>
    </main>
  );
}
