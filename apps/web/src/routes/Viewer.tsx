import { P2P_LIMITS } from '@tela/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AbertoNoApp } from '../components/AbertoNoApp.js';
import { AudioUnlock } from '../components/AudioUnlock.js';
import { BarraEspectador, type PropsDaBarra } from '../components/BarraEspectador.js';
import { BarraEspectadorCompacta } from '../components/BarraEspectadorCompacta.js';
import { EntradaDeApelido } from '../components/EntradaDeApelido.js';
import { VidroCrt } from '../components/EfeitosTv.js';
import { IconOlho } from '../components/Icon.js';
import type { Motivo } from '../components/OfflineState.js';
import { OfflineState } from '../components/OfflineState.js';
import { DialogoAssistirJunto } from '../components/DialogoAssistirJunto.js';
import {
  abrirNoApp,
  audioCue,
  canaisRecentes,
  createViewerSession,
  espectador,
  preferenciaDaPip,
  semAppMarca,
  volumePreference,
} from '../container.js';
import { caminhoDosCanais } from '../core/domain/canais-da-rota.js';
import { canalDaEntrada } from '../core/domain/entrada-de-canal.js';
import {
  adicionar,
  alternarLayout,
  focar,
  iniciarMultivisao,
  moverPip,
  ordemDoLink,
  pausar,
  proximoTamanho,
  redimensionar,
  remover,
  retomar,
  secundaria,
} from '../core/multivisao/estado.js';
import { GuardaDeBanda } from '../core/multivisao/guarda-de-banda.js';
import { proximosAtrasos } from '../core/multivisao/sincronia.js';
import { ATRASO_EXTRA_MAXIMO_MS, type ViewerSession } from '../core/media/viewer-session.js';
import { type Arranjo, posicaoDoPainel } from '../react/layout-da-multivisao.js';
import { congelarQuadro } from '../react/quadro-congelado.js';
import { useDialogo } from '../react/use-dialogo.js';
import { useMediaStats } from '../react/use-media-stats.js';
import type { SomDoPainel } from '../react/use-painel-de-canal.js';
import { useSessoes, useViewerOpcional } from '../react/use-sessoes.js';
import { useViewer } from '../react/use-viewer.js';
import { PainelDoCanal } from './PainelDoCanal.js';
import { formatarMs } from '../core/domain/formatar-medidas.js';
import { horaCurta } from '../core/media/aviso-de-canal.js';
import { apelidoValido } from '../core/identity/espectador.js';
import type { EstadoAudio } from '../core/media/audio-state.js';
import type { ViewerState } from '../core/media/viewer-session.js';
import { useAbrirNoApp } from '../react/use-abrir-no-app.js';
import { useAutoHide } from '../react/use-auto-hide.js';
import { useCopia } from '../react/use-copia.js';
import { useBarraCompacta, useMediaQuery } from '../react/use-media-query.js';
import { useAvisoDeCanal } from '../react/use-aviso-de-canal.js';
import { useHotkeys } from '../react/use-page-effects.js';
import { usePictureInPicture } from '../react/use-picture-in-picture.js';
import { PASSO_VOLUME, useVolume } from '../react/use-volume.js';
import type { CausaDaLentidao } from '../core/media/vigia-de-fluidez.js';
import { useZoomPan } from '../react/use-zoom-pan.js';

type Props = {
  /** Um canal, ou dois na multivisão (`/a+b`, ADR 0032). O primeiro abre como principal. */
  readonly canais: readonly string[];
};

/** A secundária nunca toca som (ADR 0032 §5): dois jogos ao mesmo tempo é barulho. */
const SOM_DA_SECUNDARIA: SomDoPainel = { mudo: true, volume: 1, liberado: true };

const TEXTO_DA_PAUSA = {
  rede: 'PAUSADA · SUA REDE NÃO SEGURA DUAS',
  decodificacao: 'PAUSADA · ESTE COMPUTADOR NÃO DÁ CONTA DE DUAS',
} as const;



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
/**
 * Por que a imagem está aos saltos, quando a causa é do lado de quem assiste
 * (`vigia-de-fluidez.ts`) — a única em que ele pode agir. Diz o que fazer.
 */
const AVISO_IMAGEM: Record<CausaDaLentidao, { rotulo: string; titulo: string }> = {
  rede: {
    rotulo: 'sua conexão',
    titulo:
      'a imagem chega aos saltos porque a sua conexão está perdendo pacotes — Wi-Fi longe do roteador, download pesado ou rede móvel; cabo ou outra rede resolvem',
  },
  decodificacao: {
    rotulo: 'seu computador',
    titulo:
      'a imagem chega, mas este computador não está dando conta de mostrá-la — feche abas e programas pesados, ou confira a aceleração por hardware do navegador',
  },
};

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
export function Viewer({ canais: canaisDaRota }: Props) {
  /*
    Quem tem o app instalado é levado a ele; a sessão da web só abre quando a
    fase é `navegador`. Onde não há o que tentar a fase já nasce assim.
  */
  const app = useAbrirNoApp(canaisDaRota.join('+'), abrirNoApp, semAppMarca);
  const som = useVolume(volumePreference);

  /**
   * O apelido do pedido (ADR 0025). `null` = ainda não disse quem é: a sessão
   * nem abre, porque não há pedido sem nome. Um `#k=` de link antigo
   * (ADR 0021) é simplesmente ignorado (ADR 0026).
   */
  const [nome, setNome] = useState<string | null>(() => espectador.apelido());
  const [rascunho, setRascunho] = useState(() => espectador.apelido() ?? '');
  /*
    Sala aberta (ADR 0028): ninguém pergunta o apelido antes de entrar. O
    formulário só volta a aparecer se a pessoa pedir para trocá-lo numa sala
    com aprovação (ADR 0025), que hoje está desligada.
  */
  const [editandoNome, setEditandoNome] = useState(false);
  const precisaNome = editandoNome;
  const quem = { nome: nome ?? '', chave: espectador.chave() };

  /*
    Multivisão (ADR 0032): um canal é o caso de sempre, com um painel só.
    Cada canal tem a própria sessão, estável enquanto ele estiver na tela —
    trocar a principal não abre nem fecha conexão nenhuma.
  */
  const [mv, setMv] = useState(() => iniciarMultivisao(canaisDaRota, preferenciaDaPip.ler()));
  const outra = secundaria(mv);
  const multiRef = useRef(false);
  multiRef.current = outra !== null;
  // Perguntado a cada conexão: na multivisão este espectador não repassa (cascata, ADR 0031).
  const criarSessao = useCallback(() => createViewerSession({ repassar: () => !multiRef.current }), []);
  const sessoes = useSessoes(mv.canais, criarSessao);
  const session = sessoes.get(mv.principal);
  if (session === undefined) throw new Error('principal sem sessão');
  const sessaoDaOutra = outra === null ? null : (sessoes.get(outra) ?? null);
  const state = useViewer(session);
  const estadoDaOutra = useViewerOpcional(sessaoDaOutra);

  /*
    Os `<video>` de cada painel. A página age no da principal (tela cheia,
    picture-in-picture nativo, som liberado pelo clique).
  */
  const [videos, setVideos] = useState<Readonly<Record<string, HTMLVideoElement | null>>>({});
  const aoMontarVideo = useCallback((canal: string, el: HTMLVideoElement | null) => {
    setVideos((v) => (v[canal] === el ? v : { ...v, [canal]: el }));
  }, []);
  const videoEl = videos[mv.principal] ?? null;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  videoRef.current = videoEl;

  // Aqui, e não num hook: o TypeScript só estreita `state` por condições do mesmo escopo.
  const watching = state.status === 'watching';
  const reconectando = state.status === 'reconnecting' && state.stream !== null;
  const comImagem = watching || reconectando;
  const stats = useMediaStats(watching ? state.stats : null);
  // Do STREAM e não do estado: `reconnecting` não carrega `hasAudio`.
  const streamAtual = state.status === 'watching' || state.status === 'reconnecting' ? state.stream : null;
  const hasAudio = streamAtual !== null && streamAtual.getAudioTracks().length > 0;
  const bloqueado = hasAudio && som.mudo && !som.liberado;

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

  /*
    Celular: barra compacta de uma linha, e um toque no vídeo mostra ou
    esconde (V-01, V-02). Com mouse o comportamento é o de sempre.
  */
  const compacta = useBarraCompacta();
  const comDedo = useMediaQuery('(pointer: coarse)');
  const controls = useAutoHide(2_000, watching && !somAtivo, compacta && comDedo ? 'alterna' : 'revela');
  const emPe = useMediaQuery('(orientation: portrait)');
  /*
    Quanto a barra de baixo ocupa, MEDIDO: ela quebra em duas linhas quando
    falta largura, e o quadro do canto tem de subir junto. `ResizeObserver`
    só dispara quando o tamanho muda — nada por quadro.
  */
  const [camadaDaBarra, setCamadaDaBarra] = useState<HTMLDivElement | null>(null);
  const [alturaDaBarra, setAlturaDaBarra] = useState(0);
  useEffect(() => {
    const barra = camadaDaBarra?.firstElementChild;
    if (!(barra instanceof HTMLElement) || typeof ResizeObserver === 'undefined') return;
    const medir = () => setAlturaDaBarra(Math.round(barra.getBoundingClientRect().height));
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(barra);
    return () => observador.disconnect();
  }, [camadaDaBarra, compacta]);
  const barraVisivelAgora = !escondida && controls.visible;
  const somDaPrincipal = useMemo<SomDoPainel>(
    () => ({ mudo: som.mudo, volume: som.volume, liberado: som.liberado }),
    [som.mudo, som.volume, som.liberado],
  );
  const alternarControles = controls.alternar;
  // Toque no vídeo mostra/esconde a barra compacta; com zoom o dedo está arrastando.
  const aoTocarNoVideo = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (compacta && comDedo && e.pointerType === 'touch' && zoom.zoom === 1) alternarControles();
    },
    [compacta, comDedo, zoom.zoom, alternarControles],
  );
  /*
    Lido do estado, que muda uma vez por segundo com as estatísticas — e não a
    60 Hz junto com os quadros. Re-renderizar a página inteira por quadro seria
    trabalho na máquina de quem está assistindo, exatamente o que o produto
    evita do outro lado.
  */
  const medida = session.latenciaAtual;

  /*
    Título e favicon dizem de relance se o canal já entrou no ar, e a fase
    separa "acabou" de "ainda não começou" (V-03, V-04).
  */
  const canal = useAvisoDeCanal(mv.principal, state.status, comImagem, audioCue.bipe);

  const liberarSom = useCallback(() => {
    som.reativar();
    const element = videoRef.current;
    if (!element) return;
    // Direto no elemento, dentro do gesto: é o clique que autoriza o áudio.
    element.muted = false;
    void element.play().catch(() => undefined);
  }, [som, videoRef]);

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
  }, [videoRef]);

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
        arrowup: () => som.empurrar(PASSO_VOLUME),
        arrowdown: () => som.empurrar(-PASSO_VOLUME),
      }),
      [toggleFullscreen, som, pip.alternar, zoom.aumentar, zoom.diminuir],
    ),
    comImagem,
  );

  /*
    ── Multivisão (ADR 0032) ──────────────────────────────────────────────
  */

  /** O último quadro da secundária pausada, para o quadro não ficar preto. */
  const [congelado, setCongelado] = useState<string | null>(null);

  /**
   * Troca a principal. O som muda de dono DENTRO do gesto — direto nos
   * elementos, antes do render — porque é o clique que autoriza o áudio; o
   * efeito de cada painel só confirma o mesmo valor depois.
   */
  const trocarPara = useCallback(
    (canal: string) => {
      const nova = videos[canal];
      const velha = videos[mv.principal];
      if (velha) velha.muted = true;
      if (nova) {
        nova.muted = som.mudo;
        nova.volume = som.volume;
        void nova.play().catch(() => undefined);
      }
      zoom.resetar();
      if (mv.pausada?.canal === canal) setCongelado(null);
      setMv((e) => focar(e, canal));
    },
    [videos, mv.principal, mv.pausada, som.mudo, som.volume, zoom],
  );

  const fechar = useCallback((canal: string) => {
    setMv((e) => remover(e, canal));
    setCongelado(null);
  }, []);

  /*
    A guarda de banda: roda quando o estado muda — uma vez por segundo, com
    as estatísticas —, nunca por quadro. Pausar fecha a sessão da secundária:
    sem download, sem decodificação.
  */
  const guarda = useRef(new GuardaDeBanda());
  const lentidaoPrincipal = state.status === 'watching' ? (state.lentidao ?? null) : null;
  const lentidaoDaOutra = estadoDaOutra?.status === 'watching' ? (estadoDaOutra.lentidao ?? null) : null;
  useEffect(() => {
    if (outra === null || mv.pausada !== null) return;
    const motivo = guarda.current.observar(performance.now(), [lentidaoPrincipal, lentidaoDaOutra]);
    if (motivo === null) return;
    setCongelado(congelarQuadro(videos[outra] ?? null));
    setMv((e) => pausar(e, motivo));
  }, [state, estadoDaOutra, lentidaoPrincipal, lentidaoDaOutra, outra, mv.pausada, videos]);

  /*
    Sincronia (mesma partida): atrasa o canal mais rápido até o mais lento.
    Desligada por padrão — dois jogos diferentes não têm o que alinhar. Roda
    na cadência das estatísticas (1 Hz), em O(1).
  */
  const [sincronizar, setSincronizar] = useState(false);
  useEffect(() => {
    const zerar = (s: ViewerSession | null) => s?.definirAtrasoExtra(0);
    if (!sincronizar || sessaoDaOutra === null) {
      zerar(session);
      zerar(sessaoDaOutra);
      return;
    }
    const natural = (s: ViewerSession): number | null => {
      const l = s.latenciaAtual;
      return l.janela?.mediana ?? l.ms;
    };
    const mesmaOrigem = session.latenciaAtual.janela?.origem === sessaoDaOutra.latenciaAtual.janela?.origem;
    if (!mesmaOrigem) return;
    const [p, o] = proximosAtrasos(
      [natural(session), natural(sessaoDaOutra)],
      [session.atrasoDeSincronia, sessaoDaOutra.atrasoDeSincronia],
      ATRASO_EXTRA_MAXIMO_MS,
    );
    session.definirAtrasoExtra(p);
    sessaoDaOutra.definirAtrasoExtra(o);
  }, [sincronizar, session, sessaoDaOutra, state, estadoDaOutra]);
  // Com um canal só não há o que sincronizar.
  useEffect(() => {
    if (outra === null) setSincronizar(false);
  }, [outra]);

  const retomarOutra = useCallback(() => {
    guarda.current.retomou(performance.now());
    setCongelado(null);
    setMv(retomar);
  }, []);

  // O link da barra de endereço acompanha a tela: copiar e mandar abre igual.
  const caminho = caminhoDosCanais(ordemDoLink(mv));
  useEffect(() => {
    if (window.location.pathname === caminho) return;
    window.history.replaceState(window.history.state, '', `${caminho}${window.location.search}${window.location.hash}`);
  }, [caminho]);

  // Canto e tamanho do quadro valem para a próxima vez.
  useEffect(() => {
    preferenciaDaPip.gravar({ canto: mv.canto, tamanho: mv.tamanho });
  }, [mv.canto, mv.tamanho]);

  // Os recentes do `+ TELA`: só canal que chegou a passar imagem.
  const outraNoAr = estadoDaOutra?.status === 'watching';
  useEffect(() => {
    if (watching) canaisRecentes.lembrar(mv.principal);
  }, [watching, mv.principal]);
  useEffect(() => {
    if (outraNoAr && outra !== null) canaisRecentes.lembrar(outra);
  }, [outraNoAr, outra]);

  /* "+ TELA": o diálogo de pôr outro canal. */
  const [juntoAberto, setJuntoAberto] = useState(false);
  const [entradaJunto, setEntradaJunto] = useState('');
  const [erroJunto, setErroJunto] = useState<'invalido' | 'repetido' | null>(null);
  const campoJuntoRef = useRef<HTMLInputElement>(null);
  const fecharJunto = useCallback(() => {
    setJuntoAberto(false);
    setEntradaJunto('');
    setErroJunto(null);
  }, []);
  const dialogoJunto = useDialogo(juntoAberto, fecharJunto, campoJuntoRef);
  const abrirJunto = useCallback(() => setJuntoAberto(true), []);
  const porNaTela = (canal: string) => {
    const r = adicionar(mv, canal);
    if (!r.ok) {
      setErroJunto('repetido');
      return;
    }
    if (mv.pausada !== null) setCongelado(null);
    setMv(r.value);
    fecharJunto();
  };
  const enviarJunto = () => {
    const canalDigitado = canalDaEntrada(entradaJunto);
    if (!canalDigitado.ok) {
      setErroJunto('invalido');
      return;
    }
    porNaTela(canalDigitado.value);
  };

  useHotkeys(
    useMemo(
      () => ({
        a: abrirJunto,
        t: () => {
          if (outra !== null) trocarPara(outra);
        },
        x: () => {
          if (outra !== null) fechar(outra);
        },
        l: () => setMv(alternarLayout),
        s: () => {
          if (outra !== null) setSincronizar((v) => !v);
        },
        '[': () => setMv((e) => redimensionar(e, -1)),
        ']': () => setMv((e) => redimensionar(e, 1)),
      }),
      [abrirJunto, outra, trocarPara, fechar],
    ),
    !juntoAberto,
  );

  if (app.fase !== 'navegador') {
    return (
      <main>
        <VidroCrt />
        <AbertoNoApp
          slug={canaisDaRota.join(' + ')}
          estado={app.fase === 'no-app' ? 'aberto' : 'tentando'}
          aoContinuarNoNavegador={app.continuarNoNavegador}
        />
      </main>
    );
  }

  if (precisaNome) {
    return (
      <main>
        <VidroCrt />
        <EntradaDeApelido
          slug={mv.principal}
          valor={rascunho}
          aoMudar={setRascunho}
          invalido={rascunho.trim() !== '' && apelidoValido(rascunho) === null}
          pronto={apelidoValido(rascunho) !== null}
          aoEnviar={() => {
            const guardado = espectador.lembrarApelido(rascunho);
            if (guardado !== null) {
              setNome(guardado);
              setEditandoNome(false);
            }
          }}
        />
      </main>
    );
  }

  /*
    Sem imagem na principal: a tela de espera de sempre, agora POR CIMA do
    painel — a PiP continua no palco, e um clique nela troca.
  */
  let sobreposicao: React.ReactNode = null;
  if (!comImagem) {
    // O relay só explica falha de REDE. Conectou e o quadro não veio: é mídia.
    const motivoDaSessao: Motivo =
      state.status === 'sem-conexao' && state.etapa === 'midia'
        ? 'sem-video'
        : state.status === 'sem-conexao' && state.relayStatus === 'unavailable'
          ? 'relay-indisponivel'
          : state.status === 'sem-conexao' && state.relayStatus === 'not-configured'
            ? 'relay-nao-configurado'
            : MOTIVO[state.status];
    // A imagem existia e acabou: enquanto a sessão sonda de novo (offline ou
    // conectando), a tela diz "encerrada", e não "aguardando sinal".
    const motivo: Motivo =
      canal.fase === 'encerrada' && (motivoDaSessao === 'offline' || motivoDaSessao === 'conectando')
        ? 'encerrada'
        : motivoDaSessao;
    const relatorio = session.diagnostico(navigator.userAgent);
    sobreposicao = (
        <OfflineState
          slug={mv.principal}
          motivo={motivo}
          {...(canal.terminouEm === null ? {} : { encerradaEm: horaCurta(canal.terminouEm) })}
          // O teto é do TRANSMISSOR, não do produto: 5 em quem codifica por
          // peer, 50 em quem codifica uma vez. O servidor diz qual ao recusar;
          // um servidor antigo não diz, e aí resta o teto do produto.
          maxPeers={state.status === 'full' && state.maxPeers !== null ? state.maxPeers : P2P_LIMITS.maxViewers}
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
                acaoSecundaria: { rotulo: 'trocar apelido', aoClicar: () => setEditandoNome(true) },
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
    );
  }

  /*
    O arranjo do palco. Celular em pé: as duas empilhadas — o 16:9 de cima é
    o que já aparecia, e o preto que sobrava embaixo vira a segunda.
  */
  const arranjo: Arranjo = outra === null ? 'sozinho' : compacta && emPe ? 'empilhado' : mv.layout;
  const folgaDaBarra = barraVisivelAgora && comImagem ? alturaDaBarra : 0;

  const avisoAudio = watching ? (AVISO_AUDIO[state.audio] ?? null) : null;
  const avisoImagem = watching && state.lentidao != null ? AVISO_IMAGEM[state.lentidao] : null;
  const barraVisivel = barraVisivelAgora;

  const propsDaBarra: PropsDaBarra = {
    canal: mv.principal,
    viewers: watching ? state.viewers : null,
    reconectando,
    // Mediana dos últimos quadros (p95 no título); sem janela, a média do vigia.
    latencia:
      medida.janela !== null
        ? formatarMs(medida.janela.mediana)
        : medida.ms === null
          ? stats.latencia
          : formatarMs(medida.ms),
    latenciaAlta: medida.alta,
    latenciaTitulo:
      medida.ms === null
        ? `rede ${stats.rtt}`
        : `rede ${stats.rtt} · ${
            medida.janela?.origem === 'captura' || medida.origem === 'captura'
              ? 'captura até a tela'
              : 'só a recepção (sem captura)'
          }${medida.janela === null ? '' : ` · mediana de ${medida.janela.amostras} quadros · p95 ${formatarMs(medida.janela.p95)}`}${
            session.atrasoDeSincronia > 0 ? ` · +${session.atrasoDeSincronia} ms de sincronia` : ''
          }`,
    // Com os quadros por segundo: "slide" vira um número que quem assiste pode repetir.
    imagem: stats.fps === '—' ? stats.resolution : `${stats.resolution} · ${stats.fps}`,
    travado: stats.travou ? stats.congelado : null,
    avisoAudio,
    avisoImagem,
    temAudio: hasAudio,
    volume: {
      valor: som.volume,
      mudo: som.mudo,
      ajustavel: som.ajustavel,
      passo: PASSO_VOLUME,
      aoAjustar: som.ajustar,
      aoAlternar: som.alternarMudo,
      aoAtivar: setSomAtivo,
      deslizanteNaCompacta: !comDedo,
    },
    zoom: {
      porcento: `${Math.round(zoom.zoom * 100)}%`,
      ampliado: zoom.zoom > 1,
      aoAumentar: zoom.aumentar,
      aoDiminuir: zoom.diminuir,
      aoResetar: zoom.resetar,
    },
    aoEsconder: () => setEscondida(true),
    pip: pip.disponivel ? { ativo: pip.ativo, aoAlternar: pip.alternar } : null,
    emTelaCheia,
    aoTelaCheia: toggleFullscreen,
    copiouDiagnostico: diagCopia.copiado,
    aoCopiarDiagnostico: copiarDiagnostico,
    abrirNoApp: app.oferece
      ? { aoAbrir: app.abrir, tentando: app.manual === 'tentando', falhou: app.manual === 'falhou' }
      : null,
    multivisao: {
      aoAdicionar: abrirJunto,
      sincronia:
        outra === null
          ? null
          : { ativa: sincronizar, aoAlternar: () => setSincronizar((v) => !v), atrasoMs: session.atrasoDeSincronia },
      layout:
        arranjo === 'pip' || arranjo === 'lado-a-lado'
          ? { ladoALado: arranjo === 'lado-a-lado', aoAlternar: () => setMv(alternarLayout) }
          : null,
    },
  };

  return (
    <main
      ref={paginaRef}
      /*
        `h-dvh` e não `h-screen`: `100vh` é a viewport GRANDE no celular, com a
        barra de URL recolhida — maior que a área visível. O `<main>` ficava
        mais alto que a tela e a barra, ancorada em `bottom-0`, caía inteira
        fora da dobra: sem contagem, sem latência, sem volume, sem botão de
        tela cheia.

        No app desktop a moldura põe `--altura-da-tela: 100%`: a coluna
        fica abaixo da barra de título, e `100dvh` passava dela pela altura
        da barra, com o pé da imagem atrás de um scroll.
      */
      className="relative h-[var(--altura-da-tela,100dvh)] w-full overflow-hidden bg-black"
      // No toque o `mousemove` do gesto não pode revelar: quem decide é `alternar`.
      onMouseMove={compacta && comDedo ? undefined : controls.show}
      onDoubleClick={comImagem ? toggleFullscreen : undefined}
    >
      {/* Scanlines só na sala de espera: com imagem, o jogo é o conteúdo. */}
      {!comImagem && <VidroCrt />}

      {/*
        Um painel por canal, SEMPRE na ordem de `mv.canais` (ADR 0032): trocar
        a principal muda a classe de cada um, nunca a ordem nem o elemento.
      */}
      {mv.canais.map((c, indice) => {
        const sessao = sessoes.get(c);
        if (sessao === undefined) return null;
        const ehPrincipal = c === mv.principal;
        const posicao = posicaoDoPainel({
          arranjo,
          principal: ehPrincipal,
          indice,
          canto: mv.canto,
          tamanho: mv.tamanho,
          folgaDaBarra,
        });
        return (
          <PainelDoCanal
            key={c}
            session={sessao}
            canal={c}
            principal={ehPrincipal}
            abrir={!precisaNome && app.fase === 'navegador' && mv.pausada?.canal !== c}
            quem={quem}
            som={ehPrincipal ? somDaPrincipal : SOM_DA_SECUNDARIA}
            posicao={posicao}
            lugar={`${arranjo}:${ehPrincipal ? 'p' : 's'}:${mv.canto}:${mv.tamanho}`}
            destacado={ehPrincipal && (arranjo === 'lado-a-lado' || arranjo === 'empilhado')}
            aoMontarVideo={aoMontarVideo}
            zoom={ehPrincipal ? zoom : null}
            aoTocarNoVideo={ehPrincipal ? aoTocarNoVideo : undefined}
            sobreposicao={ehPrincipal ? sobreposicao : null}
            quadro={
              ehPrincipal
                ? null
                : {
                    pausa:
                      mv.pausada?.canal === c
                        ? { texto: TEXTO_DA_PAUSA[mv.pausada.motivo], aoRetomar: retomarOutra }
                        : null,
                    congelado,
                    comToque: comDedo,
                    rotuloNoTopo: arranjo !== 'pip',
                    noCanto:
                      arranjo === 'pip'
                        ? {
                            tamanho: mv.tamanho,
                            aoMudarTamanho: () => setMv(proximoTamanho),
                            aoSoltar: (canto) => setMv((e) => moverPip(e, canto)),
                          }
                        : null,
                    aoTrocar: () => trocarPara(c),
                    aoFechar: () => fechar(c),
                  }
            }
          />
        );
      })}

      {/*
        `!som.liberado` é o que separa "o browser bloqueou" de "eu silenciei".
        Sem essa condição, silenciar de propósito — pelo botão ou pela barra de
        espaço — cobriria o jogo inteiro com o overlay pedindo um clique.
      */}
      {bloqueado && comImagem && <AudioUnlock onUnlock={liberarSom} />}

      {/*
        A barra é a última coisa a sumir e a primeira a voltar (movimento do
        mouse, toque ou foco). Some com opacidade, não com `display`: nenhum
        reflow no meio do jogo. Escondida ela continua focável de propósito —
        é o `focusin` que a traz de volta para quem navega por teclado.
      */}
      {comImagem && (
        <div
          ref={setCamadaDaBarra}
          /*
            Camada própria acima dos painéis (z 42): a secundária é imagem e
            fica acima do vidro do CRT (z 41); a barra tem de ficar acima dela,
            senão o lado a lado a cobre pela metade.
          */
          className={[
            'pointer-events-none absolute inset-0 z-[42] transition-opacity duration-300',
            barraVisivel ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
        >
          {compacta ? <BarraEspectadorCompacta {...propsDaBarra} /> : <BarraEspectador {...propsDaBarra} />}
        </div>
      )}

      {/*
        Controles escondidos (H ou o botão): sobra um fantasma no canto, quase
        apagado, que volta ao mover o mouse. Sem ele quem escondeu por engano
        no celular não teria como trazer a barra de volta.
      */}
      {escondida && comImagem && (
        <button
          type="button"
          onClick={() => setEscondida(false)}
          title="Mostrar controles (H)"
          aria-label="Mostrar controles (H)"
          className={[
            'absolute bottom-5 right-5 z-[42] flex h-11 w-11 items-center justify-center border-2 border-edge bg-[rgb(10_10_12_/_0.85)] transition-opacity duration-300 hover:opacity-100 focus-visible:opacity-100',
            controls.visible ? 'opacity-100' : 'opacity-20',
          ].join(' ')}
        >
          <IconOlho className="h-[18px] w-[18px] text-accent" />
        </button>
      )}

      <DialogoAssistirJunto
        dialogRef={dialogoJunto.ref}
        aoClicarNoFundo={dialogoJunto.aoClicar}
        inputRef={campoJuntoRef}
        valor={entradaJunto}
        aoMudar={(v) => {
          setEntradaJunto(v);
          setErroJunto(null);
        }}
        erro={erroJunto}
        recentes={juntoAberto ? canaisRecentes.listar().filter((c) => !mv.canais.includes(c)) : []}
        aoEscolher={porNaTela}
        substitui={outra}
        aoEnviar={enviarJunto}
        aoCancelar={fecharJunto}
      />
    </main>
  );
}
