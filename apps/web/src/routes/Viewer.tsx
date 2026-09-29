import { P2P_LIMITS } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioUnlock } from '../components/AudioUnlock.js';
import { BarraEspectador } from '../components/BarraEspectador.js';
import { EntradaDeApelido } from '../components/EntradaDeApelido.js';
import { VidroCrt } from '../components/EfeitosTv.js';
import { IconOlho } from '../components/Icon.js';
import type { Motivo } from '../components/OfflineState.js';
import { OfflineState } from '../components/OfflineState.js';
import { createViewerSession, espectador, volumePreference } from '../container.js';
import { apelidoValido } from '../core/identity/espectador.js';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { ViewerState } from '../core/media/viewer-session.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useCopia } from '../react/use-copia.js';
import { useMediaStats } from '../react/use-media-stats.js';
import { useHotkeys, useTabTitle } from '../react/use-page-effects.js';
import { useFrameLatency } from '../react/use-frame-latency.js';
import { usePictureInPicture } from '../react/use-picture-in-picture.js';
import { useViewer } from '../react/use-viewer.js';
import { PASSO_VOLUME, useVolume } from '../react/use-volume.js';
import { useZoomPan } from '../react/use-zoom-pan.js';

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
  removido: 'removido',
  'aguardando-aprovacao': 'aguardando-aprovacao',
  recusado: 'recusado',
  desatualizado: 'desatualizado',
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

const PEDE_ACAO: ReadonlySet<Motivo> = new Set<Motivo>([
  'sem-conexao',
  'sem-video',
  'relay-indisponivel',
  'relay-nao-configurado',
  'sem-servidor',
  'removido',
  'recusado',
  'desatualizado',
]);

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
  const diagCopia = useCopia(2_000);
  const copiarDiag = diagCopia.copiar;

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
    copiarDiag(JSON.stringify(relatorio, null, 2));
  }, [session, copiarDiag]);
  /** O corpo da página: é ELE que entra em tela cheia, para a barra ir junto. */
  const paginaRef = useRef<HTMLElement>(null);
  const [escondida, setEscondida] = useState(false);
  const zoom = useZoomPan();
  const pip = usePictureInPicture(videoEl);
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

  useTabTitle(watching ? `● ${slug} · Tela` : `${slug} · Tela`);

  /**
   * O apelido do pedido (ADR 0025). `null` = ainda não disse quem é: a sessão
   * nem abre, porque não há pedido sem nome. Um `#k=` de link antigo
   * (ADR 0021) é simplesmente ignorado (ADR 0026).
   */
  const [nome, setNome] = useState<string | null>(() => espectador.apelido());
  const [rascunho, setRascunho] = useState(() => espectador.apelido() ?? '');
  const precisaNome = nome === null;

  useEffect(() => {
    if (precisaNome) return;
    void session.open(slug, { nome: nome ?? '', chave: espectador.chave() });
    return () => {
      void session.close();
    };
  }, [session, slug, nome, precisaNome]);

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
    const palco = paginaRef.current;

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
        h: () => setEscondida((v) => !v),
        p: pip.alternar,
        '+': zoom.aumentar,
        '=': zoom.aumentar,
        '-': zoom.diminuir,
        m: som.alternarMudo,
        ' ': som.alternarMudo,
        arrowup: () => som.empurrar(PASSO_VOLUME),
        arrowdown: () => som.empurrar(-PASSO_VOLUME),
      }),
      [toggleFullscreen, som, pip.alternar, zoom.aumentar, zoom.diminuir],
    ),
    comImagem,
  );

  if (precisaNome) {
    return (
      <main>
        <VidroCrt />
        <EntradaDeApelido
          slug={slug}
          valor={rascunho}
          aoMudar={setRascunho}
          invalido={rascunho.trim() !== '' && apelidoValido(rascunho) === null}
          pronto={apelidoValido(rascunho) !== null}
          aoEnviar={() => {
            const guardado = espectador.lembrarApelido(rascunho);
            if (guardado !== null) setNome(guardado);
          }}
        />
      </main>
    );
  }

  if (!comImagem) {
    // O relay só explica falha de REDE. Conectou e o quadro não veio: é mídia.
    const motivo: Motivo =
      state.status === 'sem-conexao' && state.etapa === 'midia'
        ? 'sem-video'
        : state.status === 'sem-conexao' && state.relayStatus === 'unavailable'
          ? 'relay-indisponivel'
          : state.status === 'sem-conexao' && state.relayStatus === 'not-configured'
            ? 'relay-nao-configurado'
            : MOTIVO[state.status];
    const relatorio = session.diagnostico(navigator.userAgent);
    return (
      <main>
        {/* Scanlines só na sala de espera: com imagem, o jogo é o conteúdo. */}
        <VidroCrt />
        <OfflineState
          slug={slug}
          motivo={motivo}
          maxPeers={P2P_LIMITS.maxViewersBrowser}
          // Onde a conexão está de verdade: a sessão sabe se ainda procura o
          // canal ou já negocia. Os blocos do "sintonizando" seguem isso, não
          // um relógio.
          etapa={state.status === 'connecting' ? 'negociando' : 'procurando'}
          {...(PEDE_ACAO.has(motivo)
            ? {
                onTentarNovamente:
                  motivo === 'desatualizado'
                    ? () => window.location.reload()
                    : () => void session.retryNow(),
              }
            : {})}
          {...(motivo === 'recusado' ? { rotuloAcao: 'PEDIR DE NOVO' } : {})}
          {...(state.status === 'aguardando-aprovacao'
            ? {
                nome: state.nome,
                // Trocar o apelido refaz o pedido com o nome novo.
                acaoSecundaria: { rotulo: 'trocar apelido', aoClicar: () => setNome(null) },
              }
            : {})}
          diagnostico={
            relatorio !== null && PEDE_ACAO.has(motivo) ? (
              <details className="border-t-2 border-line px-5 pb-5 text-[12px] text-muted">
                <summary className="flex min-h-11 cursor-pointer items-center">
                  ver diagnóstico da tentativa
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all border-2 border-line bg-deep p-3 text-[11px]">
                  {JSON.stringify(relatorio, null, 2)}
                </pre>
                <button type="button" onClick={copiarDiagnostico} className="tecla mt-2">
                  {diagCopia.copiado ? 'COPIADO' : 'COPIAR DIAGNÓSTICO'}
                </button>
              </details>
            ) : null
          }
        />
      </main>
    );
  }

  const avisoAudio = watching ? (AVISO_AUDIO[state.audio] ?? null) : null;
  const barraVisivel = !escondida && controls.visible;

  return (
    <main
      ref={paginaRef}
      /*
        `h-dvh` e não `h-screen`: `100vh` é a viewport GRANDE no celular, com a
        barra de URL recolhida — maior que a área visível. O `<main>` ficava
        mais alto que a tela e a barra, ancorada em `bottom-0`, caía inteira
        fora da dobra: sem contagem, sem latência, sem volume, sem botão de
        tela cheia.
      */
      className="relative h-dvh w-full overflow-hidden bg-black"
      onMouseMove={controls.show}
      onDoubleClick={toggleFullscreen}
    >
      {/*
        O palco do vídeo: recebe a roda (zoom) e o arrasto (pan). O vídeo do
        jogo NUNCA leva scanline — o vidro do CRT nem é montado nesta rota.

        `muted` obrigatório no primeiro play: sem isso o browser bloqueia o
        autoplay inteiro e o espectador vê tela preta em vez de vídeo.
      */}
      <div
        ref={zoom.palcoRef}
        onWheel={zoom.aoRodar}
        onPointerDown={zoom.aoPressionar}
        onPointerMove={zoom.aoMover}
        onPointerUp={zoom.aoSoltar}
        onPointerCancel={zoom.aoSoltar}
        className={[
          'absolute inset-0 overflow-hidden',
          zoom.zoom > 1 ? (zoom.arrastando ? 'cursor-grabbing' : 'cursor-grab') : '',
          zoom.zoom > 1 ? 'touch-none' : '',
        ].join(' ')}
      >
        <div
          className={`h-full w-full origin-center ${zoom.arrastando ? '' : 'transition-transform duration-200 motion-reduce:transition-none'}`}
          style={{ transform: `translate(${zoom.pan.x}px, ${zoom.pan.y}px) scale(${zoom.zoom})` }}
        >
          <video
            ref={montarVideo}
            autoPlay
            playsInline
            muted={som.mudo}
            className="h-full w-full bg-black object-contain"
          />
        </div>
      </div>

      {/*
        `!som.liberado` é o que separa "o browser bloqueou" de "eu silenciei".
        Sem essa condição, silenciar de propósito — pelo botão ou pela barra de
        espaço — cobriria o jogo inteiro com o overlay pedindo um clique.
      */}
      {bloqueado && <AudioUnlock onUnlock={liberarSom} />}

      {/*
        A barra é a última coisa a sumir e a primeira a voltar (movimento do
        mouse, toque ou foco). Some com opacidade, não com `display`: nenhum
        reflow no meio do jogo. Escondida ela continua focável de propósito —
        é o `focusin` que a traz de volta para quem navega por teclado.
      */}
      <div
        className={[
          'transition-opacity duration-300',
          barraVisivel ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      >
        <BarraEspectador
          canal={slug}
          viewers={watching ? state.viewers : null}
          reconectando={reconectando}
          latencia={medida.ms === null ? stats.latencia : `${Math.round(medida.ms)}ms`}
          latenciaAlta={medida.alta}
          latenciaTitulo={
            medida.ms === null
              ? `rede ${stats.rtt}`
              : `rede ${stats.rtt} · medido no quadro (${
                  medida.origem === 'captura' ? 'ponta a ponta' : 'só a recepção'
                })`
          }
          imagem={stats.resolution}
          travado={stats.travou ? stats.congelado : null}
          avisoAudio={avisoAudio}
          temAudio={hasAudio}
          volume={{
            valor: som.volume,
            mudo: som.mudo,
            ajustavel: som.ajustavel,
            passo: PASSO_VOLUME,
            aoAjustar: som.ajustar,
            aoAlternar: som.alternarMudo,
            aoAtivar: setSomAtivo,
          }}
          zoom={{
            porcento: `${Math.round(zoom.zoom * 100)}%`,
            ampliado: zoom.zoom > 1,
            aoAumentar: zoom.aumentar,
            aoDiminuir: zoom.diminuir,
            aoResetar: zoom.resetar,
          }}
          aoEsconder={() => setEscondida(true)}
          pip={pip.disponivel ? { ativo: pip.ativo, aoAlternar: pip.alternar } : null}
          emTelaCheia={emTelaCheia}
          aoTelaCheia={toggleFullscreen}
          copiouDiagnostico={diagCopia.copiado}
          aoCopiarDiagnostico={copiarDiagnostico}
        />
      </div>

      {/*
        Controles escondidos (H ou o botão): sobra um fantasma no canto, quase
        apagado, que volta ao mover o mouse. Sem ele quem escondeu por engano
        no celular não teria como trazer a barra de volta.
      */}
      {escondida && (
        <button
          type="button"
          onClick={() => setEscondida(false)}
          title="Mostrar controles (H)"
          aria-label="Mostrar controles (H)"
          className={[
            'absolute bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center border-2 border-edge bg-[rgb(10_10_12_/_0.85)] transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100',
            controls.visible ? 'opacity-100' : 'opacity-20',
          ].join(' ')}
        >
          <IconOlho className="h-[18px] w-[18px] text-accent" />
        </button>
      )}
    </main>
  );
}
