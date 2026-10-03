import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerSession, ViewerState } from '../core/media/viewer-session.js';
import { useFrameLatency } from './use-frame-latency.js';
import { useMediaStats } from './use-media-stats.js';
import { useViewer } from './use-viewer.js';

/** O som que este painel deve tocar. A rota decide; o painel só aplica. */
export type SomDoPainel = {
  readonly mudo: boolean;
  readonly volume: number;
  /** O navegador já deixou tocar som nesta página (gesto). */
  readonly liberado: boolean;
};

export type OpcoesDoPainel = {
  /** `false` enquanto a sessão não pode abrir (o app está tentando abrir o canal, apelido em edição). */
  readonly abrir: boolean;
  readonly quem: { readonly nome: string; readonly chave: string };
  readonly som: SomDoPainel;
  /**
   * Medir a latência quadro a quadro (`requestVideoFrameCallback`). Só quem a
   * barra mostra precisa: na multivisão a secundária não paga um callback por
   * quadro para um número que ninguém lê.
   */
  readonly medirLatencia?: boolean;
};

export type PainelDeCanal = {
  readonly session: ViewerSession;
  readonly state: ViewerState;
  /** Para quem age no elemento (play, tela cheia). Não é reativo: ver `videoEl`. */
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly videoEl: HTMLVideoElement | null;
  readonly montarVideo: (el: HTMLVideoElement | null) => void;
  readonly watching: boolean;
  /** A mídia hesitou mas o stream está aqui: o `<video>` continua montado. */
  readonly reconectando: boolean;
  readonly comImagem: boolean;
  readonly streamAtual: MediaStream | null;
  readonly hasAudio: boolean;
  /** Som bloqueado pelo autoplay — não escolhido. */
  readonly bloqueado: boolean;
  readonly stats: ReturnType<typeof useMediaStats>;
};

/**
 * Um canal na tela: UMA `ViewerSession`, o `<video>` dela e o que precisa
 * acontecer entre as duas. A rota do espectador monta um por canal (ADR 0032).
 *
 * O que mora aqui é o que vale para qualquer canal — abrir e fechar a sessão,
 * ligar o stream ao elemento, medir a latência por quadro, aplicar o som. O
 * que é da página (tela cheia, atalhos, barra, zoom) continua na rota.
 */
export function usePainelDeCanal(
  session: ViewerSession,
  slug: string,
  { abrir, quem, som, medirLatencia = true }: OpcoesDoPainel,
): PainelDeCanal {
  const state = useViewer(session);

  const videoRef = useRef<HTMLVideoElement | null>(null);
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
   */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const montarVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);

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
  const stats = useMediaStats(watching ? state.stats : null);

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
    (amostra: Parameters<typeof session.registrarLatencia>[0]) => session.registrarLatencia(amostra),
    [session],
  );
  useFrameLatency(videoEl, comImagem && medirLatencia, registrar);

  useEffect(() => {
    if (!abrir) return;
    void session.open(slug, { nome: quem.nome, chave: quem.chave });
    return () => {
      void session.close();
    };
  }, [session, slug, quem.nome, quem.chave, abrir]);

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

  return {
    session,
    state,
    videoRef,
    videoEl,
    montarVideo,
    watching,
    reconectando,
    comImagem,
    streamAtual,
    hasAudio,
    bloqueado,
    stats,
  };
}
