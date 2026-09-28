import { P2P_LIMITS } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioUnlock } from '../components/AudioUnlock.js';
import { IconExitFullscreen, IconFullscreen, IconViewers } from '../components/Icon.js';
import { LiveDot } from '../components/LiveDot.js';
import type { Motivo } from '../components/OfflineState.js';
import { OfflineState } from '../components/OfflineState.js';
import { VolumeControl } from '../components/VolumeControl.js';
import { createViewerSession, volumePreference } from '../container.js';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { ViewerState } from '../core/media/viewer-session.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useHotkeys, useTabTitle } from '../react/use-page-effects.js';
import { useFrameLatency } from '../react/use-frame-latency.js';
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
/**
 * O som, quando há algo a dizer sobre ele. Rótulo curto na barra, explicação
 * no `title`. Silêncio curto não aparece: só depois de 20s o classificador
 * afirma `sem-sinal`, e pode ser o jogo calado mesmo — o texto não culpa ninguém.
 */
const AVISO_AUDIO: Partial<Record<EstadoAudio, { rotulo: string; titulo: string }>> = {
  perda: {
    rotulo: 'som picotando',
    titulo: 'a conexão está perdendo pacotes de áudio e o navegador está tapando os buracos',
  },
  'sem-sinal': {
    rotulo: 'sem som',
    titulo: 'nenhum som chegando há 20 segundos — pode ser só silêncio no jogo',
  },
  encerrada: {
    rotulo: 'áudio encerrado',
    titulo: 'o transmissor parou de enviar som',
  },
};

const PEDE_ACAO: ReadonlySet<Motivo> = new Set<Motivo>(['sem-conexao', 'relay-indisponivel', 'relay-nao-configurado', 'sem-servidor']);

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
  /**
   * O elemento também como ESTADO, e não só como ref.
   *
   * `videoRef.current` não é reativo: na render em que os efeitos são
   * declarados ele ainda é `null` — o `<video>` só é montado depois, e atribuir
   * `.current` não dispara render nenhuma. Um efeito que dependa de
   * `videoRef.current` roda uma vez com `null` e nunca mais.
   *
   * Isso matou a medição de latência por quadro no commit em que ela nasceu:
   * `useFrameLatency` recebia `null`, saía pelo early return, e o recurso
   * inteiro era código morto que passava em todos os testes.
   *
   * O ref continua para quem precisa dele de forma imperativa (play, volume,
   * tela cheia); o estado existe para quem precisa REAGIR à montagem.
   */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const montarVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
  const som = useVolume(volumePreference);

  /**
   * Enquanto o dedo está na barra de volume o HUD não pode sumir. Passar
   * `enabled: false` já mantém tudo visível — o `useAutoHide` trata disso —
   * então não é preciso um segundo mecanismo de trava.
   */
  const [somAtivo, setSomAtivo] = useState(false);
  const [copiouDiag, setCopiouDiag] = useState(false);


  /**
   * Copia a série temporal para o usuário MANDAR em vez de descrever.
   *
   * Nada sai da máquina sozinho — isto não é telemetria. É a resposta ao ciclo
   * de depuração que hoje é: a pessoa relata "está travando", alguém adivinha,
   * pede para ela olhar um número, adivinha de novo.
   */
  const copiarDiagnostico = useCallback(() => {
    const relatorio = session.diagnostico(navigator.userAgent);
    if (relatorio === null) return;
    void navigator.clipboard
      .writeText(JSON.stringify(relatorio, null, 2))
      .then(() => {
        setCopiouDiag(true);
        setTimeout(() => setCopiouDiag(false), 2_000);
      })
      .catch(() => undefined);
  }, [session]);
  const [emTelaCheia, setEmTelaCheia] = useState(false);

  const watching = state.status === 'watching';
  /**
   * A imagem sobrevive ao soluço de rede.
   *
   * `reconnecting` é emitido por `track.onmute` e por
   * `connectionState === 'disconnected'` — dois eventos que acontecem numa
   * troca de AP de Wi-Fi COM a mídia continuando a chegar, porque o par de
   * candidatos é o mesmo. Enquanto houver stream, o `<video>` fica montado e
   * o aviso vem por cima; trocá-lo por uma tela de espera arrancava um vídeo
   * que nunca parou e montava um elemento novo, preto até o próximo quadro.
   */
  const reconectando = state.status === 'reconnecting' && state.stream !== null;
  const comImagem = watching || reconectando;
  const controls = useAutoHide(2_000, watching && !somAtivo);
  const stats = useMediaStats(watching ? state.stats : null);
  /*
    Lido do estado, que muda uma vez por segundo com as estatísticas — e não a
    60 Hz junto com os quadros. Re-renderizar a página inteira por quadro seria
    trabalho na máquina de quem está assistindo, exatamente o que o produto
    evita do outro lado.
  */
  const medida = session.latenciaAtual;
  /**
   * A latência ponta a ponta, medida no quadro.
   *
   * `getStats()` mede pedaços — RTT é a rede, `totalProcessingDelay` vai do
   * primeiro pacote até o decode. Faltam captura, encode, o pacer e o render, e
   * é justamente aí que mora a diferença entre os 58ms que o HUD mostrava e o
   * segundo que o usuário relatou. `requestVideoFrameCallback` é a única API do
   * navegador que fecha essa conta.
   */
  const registrar = useCallback(
    (amostra: Parameters<typeof session.registrarLatencia>[0]) =>
      session.registrarLatencia(amostra),
    [session],
  );
  useFrameLatency(videoEl, comImagem, registrar);

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
  const streamAtual =
    state.status === 'watching' || state.status === 'reconnecting' ? state.stream : null;
  useEffect(() => {
    const element = videoRef.current;
    if (!element || streamAtual === null) return;
    if (element.srcObject !== streamAtual) element.srcObject = streamAtual;
    void element.play().catch(() => undefined);
  }, [streamAtual]);

  /**
   * O elemento é a fonte da verdade do áudio; o hook é a fonte da intenção.
   *
   * Depende de `videoEl` e não de `videoRef.current`: o ref não é reativo, e um
   * efeito que dependesse dele rodaria uma vez com `null` e nunca mais. E de
   * `comImagem`, que é o que o corpo de fato lê — a dependência tinha ficado em
   * `watching` quando o corpo passou a olhar `comImagem`, então o volume não
   * era reaplicado ao voltar de um soluço de rede.
   */
  useEffect(() => {
    if (videoEl === null || !comImagem) return;
    videoEl.muted = som.mudo;
    videoEl.volume = som.volume;
  }, [videoEl, comImagem, som.mudo, som.volume]);

  /**
   * Só a página vê o autoplay recusado e o mudo escolhido. A sessão precisa
   * dos dois para não chamar de "sem som" o que é bloqueio ou escolha.
   */
  // Do STREAM e não do estado: `reconnecting` não carrega `hasAudio`, e sumir
  // com o controle de volume no meio de um soluço seria a mesma desmontagem
  // que este bloco existe para evitar, em miniatura.
  const hasAudio = streamAtual !== null && streamAtual.getAudioTracks().length > 0;
  const bloqueado = hasAudio && som.mudo && !som.liberado;
  useEffect(() => {
    session.informarReproducao({ bloqueada: bloqueado, mudo: som.mudo || som.volume === 0 });
  }, [session, bloqueado, som.mudo, som.volume]);

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

    /**
     * `!= null` e um `typeof`, e a versão estrita quebrava o celular inteiro.
     *
     * No iPhone a Fullscreen API não existe: `document.fullscreenElement` é
     * `undefined`, e `undefined !== null` é **true**. O código entrava no ramo
     * de SAÍDA e chamava `document.exitFullscreen()`, que também não existe —
     * `TypeError` síncrono dentro do `onClick`, que o `.catch()` não pega
     * porque nada chegou a ser retornado. O fallback `webkitEnterFullscreen`
     * logo abaixo, que existe justamente para o iPhone, nunca era alcançado.
     *
     * Consequência: o espectador no celular ficava com 1080p espremido em
     * ~390px de largura. Redução de 4,9× — "imagem borrada" que não tem nada a
     * ver com encoder.
     */
    if (document.fullscreenElement != null) {
      if (typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
      return;
    }

    const nativoDoVideo = (): void => {
      const legado = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      legado?.webkitEnterFullscreen?.();
    };

    if (typeof palco?.requestFullscreen !== 'function') {
      nativoDoVideo();
      return;
    }
    void palco.requestFullscreen().catch(nativoDoVideo);
  }, []);

  // O ícone tem que dizer o que o clique FAZ, não onde você está.
  useEffect(() => {
    // `webkitbeginfullscreen`/`webkitendfullscreen` são os eventos do caminho
    // nativo do `<video>` no iPhone. Sem eles o ícone mentia justamente onde o
    // fallback funciona.
    const sincronizar = () => setEmTelaCheia(document.fullscreenElement != null);
    const entrou = () => setEmTelaCheia(true);
    const saiu = () => setEmTelaCheia(false);
    const video = videoEl;
    document.addEventListener('fullscreenchange', sincronizar);
    video?.addEventListener('webkitbeginfullscreen', entrou);
    video?.addEventListener('webkitendfullscreen', saiu);
    return () => {
      document.removeEventListener('fullscreenchange', sincronizar);
      video?.removeEventListener('webkitbeginfullscreen', entrou);
      video?.removeEventListener('webkitendfullscreen', saiu);
    };
    /*
      `videoEl` na lista, e sem ele o fallback do iPhone nunca funcionava: com
      a lista vazia o efeito rodava uma vez, quando o elemento ainda era `null`,
      e os dois listeners de `webkitfullscreen` jamais eram registrados. Mesmo
      defeito que matou a medição de latência por quadro — ref não é reativo.
    */
  }, [videoEl]);

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
    comImagem,
  );

  if (!comImagem) {
    const motivo: Motivo = state.status === 'sem-conexao' && state.relayStatus === 'unavailable'
      ? 'relay-indisponivel'
      : state.status === 'sem-conexao' && state.relayStatus === 'not-configured'
        ? 'relay-nao-configurado'
        : MOTIVO[state.status];
    const relatorio = session.diagnostico(navigator.userAgent);
    return (
      <main>
        <OfflineState
          slug={slug}
          motivo={motivo}
          maxPeers={P2P_LIMITS.maxViewersBrowser}
          {...(PEDE_ACAO.has(motivo) ? { onTentarNovamente: () => void session.retryNow() } : {})}
          diagnostico={relatorio !== null && PEDE_ACAO.has(motivo) ? (
            <details className="px-6 pb-6 text-[13px] text-muted">
              <summary className="cursor-pointer">ver diagnóstico da tentativa</summary>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-void p-3 text-[11px]">
                {JSON.stringify(relatorio, null, 2)}
              </pre>
              <button type="button" onClick={copiarDiagnostico} className="mt-2 underline">
                {copiouDiag ? 'copiado' : 'copiar diagnóstico'}
              </button>
            </details>
          ) : null}
        />
      </main>
    );
  }

  const avisoAudio = watching ? AVISO_AUDIO[state.audio] : undefined;

  return (
    <main
      /*
        `h-dvh` e não `h-screen`: `100vh` é a viewport GRANDE no celular, com
        a barra de URL recolhida — maior que a área visível. O `<main>` ficava
        mais alto que a tela e a barra do HUD, ancorada em `bottom-0`, caía
        inteira fora da dobra: sem contagem, sem latência, sem volume, sem
        botão de tela cheia. `OfflineState` já usava `min-h-dvh` com um
        comentário explicando exatamente isto; o Viewer tinha ficado de fora.
      */
      className="relative h-dvh w-full overflow-hidden bg-void"
      onMouseMove={controls.show}
      onDoubleClick={toggleFullscreen}
    >
      {/*
        `muted` obrigatório no primeiro play: sem isso o browser bloqueia o
        autoplay inteiro e o espectador vê tela preta em vez de vídeo.
      */}
      <video
        ref={montarVideo}
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
      {bloqueado && <AudioUnlock onUnlock={liberarSom} />}

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
          aria-label={
            watching
              ? `${state.viewers} ${state.viewers === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}`
              : 'reconectando'
          }
        >
          <IconViewers className="h-3.5 w-3.5 shrink-0" />
          {watching ? state.viewers : '—'}
        </span>

        {/*
          A latência que o espectador SENTE, não o RTT.

          Isto mostrava `stats.rtt` e chamava de latência. RTT é a ida e volta
          da rede — não inclui encoder, jitter buffer, decoder nem render. Um
          usuário relatou "1 segundo de atraso" com esta linha marcando 58ms, e
          os dois números estavam certos: eram grandezas diferentes, e a tela
          mostrava a que não importa.
        */}
        {/*
          Prefere a medida do QUADRO, que é a única completa. `stats.latencia`
          entra quando `requestVideoFrameCallback` não existe ou ainda não
          produziu amostra — ela é `rtt/2 + processamento`, que é um piso
          honesto mas ainda perde captura, encode e render.
        */}
        <span
          className={[
            'tabular text-[12px]',
            medida.alta ? 'text-warn' : 'text-muted',
          ].join(' ')}
          title={
            medida.ms === null
              ? `rede ${stats.rtt}`
              : `rede ${stats.rtt} · medido no quadro (${
                  medida.origem === 'captura' ? 'ponta a ponta' : 'só a recepção'
                })`
          }
        >
          {medida.ms === null ? stats.latencia : `${Math.round(medida.ms)}ms`}
        </span>

        {/* Só aparece quando travou de verdade. Silêncio é boa notícia. */}
        {stats.travou && (
          <span
            className="tabular text-[12px] text-warn"
            title="tempo total de imagem congelada nesta sessão"
          >
            {stats.congelado} travado
          </span>
        )}

        {avisoAudio !== undefined && (
          <span className="text-[12px] text-warn" title={avisoAudio.titulo}>
            {avisoAudio.rotulo}
          </span>
        )}

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

        {/*
          Só aparece quando há o que mandar. Um botão que não faz nada é pior
          que botão nenhum.
        */}
        <button
          type="button"
          onClick={copiarDiagnostico}
          aria-label="Copiar diagnóstico técnico desta sessão"
          className="pointer-events-auto inline-flex h-11 shrink-0 items-center rounded-sm px-2.5 text-[12px] text-muted transition-colors duration-150 hover:bg-surface hover:text-text"
        >
          {copiouDiag ? 'copiado' : 'diagnóstico'}
        </button>

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
