import { P2P_LIMITS } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioUnlock } from '../components/AudioUnlock.js';
import { IconExitFullscreen, IconFullscreen, IconViewers } from '../components/Icon.js';
import { LiveDot } from '../components/LiveDot.js';
import type { Motivo } from '../components/OfflineState.js';
import { OfflineState } from '../components/OfflineState.js';
import { VolumeControl } from '../components/VolumeControl.js';
import { createViewerSession, volumePreference } from '../container.js';
import type { ViewerState } from '../core/media/viewer-session.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useHotkeys, useTabTitle } from '../react/use-page-effects.js';
import { useViewer } from '../react/use-viewer.js';
import { PASSO_VOLUME, useVolume } from '../react/use-volume.js';

type Props = { readonly slug: string };

/**
 * Cada status da sessão vira o estado que o espectador precisa ler.
 *
 * `Record` sobre a união exaustiva de propósito: se alguém acrescentar um
 * status em `ViewerState`, isto para de compilar até que alguém decida o que
 * mostrar. Um `default` silencioso aqui foi exatamente o bug que apareceu em
 * produção — `connecting` e `reconnecting` caíam em "não está transmitindo",
 * então a página anunciava que o amigo estava offline enquanto negociava com
 * ele, e continuava anunciando para sempre se a negociação travasse.
 */
const MOTIVO: Record<Exclude<ViewerState['status'], 'watching'>, Motivo> = {
  checking: 'conectando',
  connecting: 'conectando',
  offline: 'offline',
  reconnecting: 'reconectando',
  full: 'cheio',
  'sem-conexao': 'sem-conexao',
  'sem-servidor': 'sem-servidor',
};

/** Só estes dois dependem de alguém mexer no navegador; os outros se resolvem. */
const PEDE_ACAO: ReadonlySet<Motivo> = new Set<Motivo>(['sem-conexao', 'sem-servidor']);

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
  const som = useVolume(volumePreference);

  /**
   * Enquanto o dedo está na barra de volume o HUD não pode sumir. Passar
   * `enabled: false` já mantém tudo visível — o `useAutoHide` trata disso —
   * então não é preciso um segundo mecanismo de trava.
   */
  const [somAtivo, setSomAtivo] = useState(false);
  const [emTelaCheia, setEmTelaCheia] = useState(false);

  const watching = state.status === 'watching';
  const controls = useAutoHide(2_000, watching && !somAtivo);
  const stats = useMediaStats(watching ? state.stats : null);

  useTabTitle(watching ? `● tela.gg/${slug}` : `${slug} · tela`);

  useEffect(() => {
    void session.open(slug);
    return () => {
      void session.close();
    };
  }, [session, slug]);

  /**
   * `srcObject` não é atributo — precisa ser atribuído na instância.
   *
   * A dependência é o STREAM, não o estado inteiro. `state` troca de
   * identidade a cada amostra de estatística, então depender dele fazia este
   * efeito rodar — e chamar `play()` — uma vez por segundo durante a
   * transmissão inteira, num elemento que já estava tocando.
   */
  const streamAtual = state.status === 'watching' ? state.stream : null;
  useEffect(() => {
    const element = videoRef.current;
    if (!element || streamAtual === null) return;
    if (element.srcObject !== streamAtual) element.srcObject = streamAtual;
    void element.play().catch(() => undefined);
  }, [streamAtual]);

  /** O elemento é a fonte da verdade do áudio; o hook é a fonte da intenção. */
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !watching) return;
    element.muted = som.mudo;
    element.volume = som.volume;
  }, [watching, som.mudo, som.volume]);

  const liberarSom = useCallback(() => {
    som.reativar();
    const element = videoRef.current;
    if (!element) return;
    // Direto no elemento, dentro do gesto: é o clique que autoriza o áudio.
    element.muted = false;
    void element.play().catch(() => undefined);
  }, [som]);

  /**
   * Tela cheia, incluindo onde a API padrão não existe.
   *
   * O Safari do iPhone não implementa `requestFullscreen` em elemento comum —
   * só o `<video>` entra em tela cheia, e por um método próprio. Como a
   * rejeição era engolida por um `catch` vazio, o botão simplesmente não fazia
   * nada no celular e não havia como saber por quê.
   */
  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    const palco = video?.parentElement;

    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    const nativoDoVideo = (): void => {
      const legado = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      legado?.webkitEnterFullscreen?.();
    };

    if (palco?.requestFullscreen === undefined) {
      nativoDoVideo();
      return;
    }
    void palco.requestFullscreen().catch(nativoDoVideo);
  }, []);

  // O ícone tem que dizer o que o clique FAZ, não onde você está.
  useEffect(() => {
    const sincronizar = () => setEmTelaCheia(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sincronizar);
    return () => document.removeEventListener('fullscreenchange', sincronizar);
  }, []);

  useHotkeys(
    useMemo(
      () => ({
        f: toggleFullscreen,
        m: som.alternarMudo,
        ' ': som.alternarMudo,
        arrowup: () => som.empurrar(PASSO_VOLUME),
        arrowdown: () => som.empurrar(-PASSO_VOLUME),
      }),
      [toggleFullscreen, som],
    ),
    watching,
  );

  if (state.status !== 'watching') {
    const motivo = MOTIVO[state.status];
    return (
      <main>
        <OfflineState
          slug={slug}
          motivo={motivo}
          maxPeers={P2P_LIMITS.maxViewersBrowser}
          {...(PEDE_ACAO.has(motivo) ? { onRecarregar: () => window.location.reload() } : {})}
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
        muted={som.mudo}
        className="h-full w-full bg-void object-contain"
      />

      {/*
        `!som.liberado` é o que separa "o browser bloqueou" de "eu silenciei".
        Sem essa condição, silenciar de propósito — pelo botão ou pela barra de
        espaço — cobriria o jogo inteiro com o overlay pedindo um clique.
      */}
      {hasAudio && som.mudo && !som.liberado && <AudioUnlock onUnlock={liberarSom} />}

      <div
        className={[
          'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-4 p-4',
          'bg-gradient-to-t from-void/80 to-transparent transition-opacity duration-300',
          controls.visible ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        <LiveDot />

        {/*
          Quantos estão vendo junto. Contagem, não lista: dá o senso de
          companhia sem entregar o identificador de ninguém, e responde a
          pergunta que quem chega cedo faz — "sou só eu?".
        */}
        <span
          className="tabular ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted"
          aria-label={`${state.viewers} ${state.viewers === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}`}
        >
          <IconViewers className="h-3.5 w-3.5 shrink-0" />
          {state.viewers}
        </span>

        {/* Latência visível: é prova da qualidade, e este público repara. */}
        <span className="tabular text-[12px] text-muted">{stats.rtt}</span>

        {hasAudio && (
          <VolumeControl
            volume={som.volume}
            mudo={som.mudo}
            ajustavel={som.ajustavel}
            ativo={somAtivo}
            onVolume={som.ajustar}
            onAlternar={som.alternarMudo}
            passo={PASSO_VOLUME}
            onAtivo={setSomAtivo}
          />
        )}

        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={emTelaCheia ? 'Sair da tela cheia' : 'Tela cheia'}
          // `shrink-0`: numa linha flex apertada o botão era espremido para 16×44 em
          // 320/360/390px — declarado 44 quadrado, entregue como um risco.
          className="pointer-events-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-muted transition-colors duration-150 hover:bg-surface hover:text-text"
        >
          {emTelaCheia ? <IconExitFullscreen /> : <IconFullscreen />}
        </button>
      </div>
    </main>
  );
}
