import { type ReactNode, useCallback, useRef, useState } from 'react';
import { MolduraDoQuadro } from '../components/MolduraDoQuadro.js';
import type { ViewerSession, ViewerState } from '../core/media/viewer-session.js';
import { type Canto, cantoMaisPerto } from '../core/multivisao/estado.js';
import type { PosicaoDoPainel } from '../react/layout-da-multivisao.js';
import { useFlip } from '../react/use-flip.js';
import { type SomDoPainel, usePainelDeCanal } from '../react/use-painel-de-canal.js';
import type { ZoomPan } from '../react/use-zoom-pan.js';

/** Sem imagem, o quadro diz o que está acontecendo — em uma linha. */
const AVISO: Record<ViewerState['status'], string | null> = {
  watching: null,
  reconnecting: 'RECONECTANDO…',
  checking: 'SINTONIZANDO…',
  connecting: 'SINTONIZANDO…',
  offline: 'FORA DO AR',
  full: 'SEM VAGA',
  'sem-conexao': 'SEM CONEXÃO',
  'sem-servidor': 'SEM SERVIDOR',
  removido: 'VOCÊ FOI REMOVIDO',
  'aguardando-aprovacao': 'AGUARDANDO APROVAÇÃO',
  recusado: 'PEDIDO RECUSADO',
  desatualizado: 'RECARREGUE A PÁGINA',
};

/** Abaixo disto, soltar é clique (troca); acima, é arrasto. */
const LIMIAR_DO_ARRASTO_PX = 6;

const ROTULO_DO_TAMANHO = { p: 'P', m: 'M', g: 'G' } as const;

export type QuadroSecundario = {
  readonly pausa: { readonly texto: string; readonly aoRetomar: () => void } | null;
  readonly congelado: string | null;
  readonly comToque: boolean;
  /** Metade da tela (lado a lado, empilhado): o pé é da barra de baixo. */
  readonly rotuloNoTopo: boolean;
  /** Só no quadro do canto (PiP): tamanho e arrasto. */
  readonly noCanto: { readonly tamanho: 'p' | 'm' | 'g'; readonly aoMudarTamanho: () => void; readonly aoSoltar: (canto: Canto) => void } | null;
  readonly aoTrocar: () => void;
  readonly aoFechar: () => void;
};

type Props = {
  readonly session: ViewerSession;
  readonly canal: string;
  readonly principal: boolean;
  readonly abrir: boolean;
  readonly quem: { readonly nome: string; readonly chave: string };
  readonly som: SomDoPainel;
  readonly posicao: PosicaoDoPainel;
  /** Muda quando o painel muda de lugar: é o que dispara a animação. */
  readonly lugar: string;
  /** Borda âmbar: a que tem som, quando as duas têm o mesmo tamanho. */
  readonly destacado: boolean;
  readonly aoMontarVideo: (canal: string, el: HTMLVideoElement | null) => void;
  /** Só a principal: zoom e arrasto do palco. */
  readonly zoom: ZoomPan | null;
  /** Só a principal: toque no vídeo mostra ou esconde a barra (celular). */
  readonly aoTocarNoVideo?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  /** Só a principal sem imagem: a tela de espera, por cima do vídeo. */
  readonly sobreposicao?: ReactNode;
  /** Só a secundária. */
  readonly quadro: QuadroSecundario | null;
};

/**
 * Um canal no palco da multivisão (ADR 0032).
 *
 * O `<video>` daqui NUNCA é desmontado por uma troca: a rota só muda
 * `posicao` e `principal`. Por isso a troca é instantânea — mesma sessão,
 * mesmo elemento, mesmo decodificador; só a caixa muda de lugar.
 */
export function PainelDoCanal({
  session,
  canal,
  principal,
  abrir,
  quem,
  som,
  posicao,
  lugar,
  destacado,
  aoMontarVideo,
  zoom,
  aoTocarNoVideo,
  sobreposicao,
  quadro,
}: Props) {
  const painel = usePainelDeCanal(session, canal, { abrir, quem, som, medirLatencia: principal });
  const { montarVideo, state } = painel;

  const montar = useCallback(
    (el: HTMLVideoElement | null) => {
      montarVideo(el);
      aoMontarVideo(canal, el);
    },
    [montarVideo, aoMontarVideo, canal],
  );

  const [caixa, setCaixa] = useState<HTMLDivElement | null>(null);
  const lembrarPosicao = useFlip(caixa, lugar);

  /*
    O arrasto do quadro mexe no `transform` direto no elemento: nenhum render
    do React por movimento do ponteiro. Só o soltar vira estado (o canto).
  */
  const arrasto = useRef<{ x0: number; y0: number; ativo: boolean } | null>(null);
  const acabouDeArrastar = useRef(false);
  const noCanto = quadro?.noCanto ?? null;

  const aoPressionar = (e: React.PointerEvent<HTMLDivElement>) => {
    if (noCanto === null || e.button !== 0) return;
    arrasto.current = { x0: e.clientX, y0: e.clientY, ativo: false };
  };
  const aoMover = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = arrasto.current;
    if (a === null || caixa === null) return;
    const dx = e.clientX - a.x0;
    const dy = e.clientY - a.y0;
    if (!a.ativo) {
      if (Math.hypot(dx, dy) < LIMIAR_DO_ARRASTO_PX) return;
      a.ativo = true;
      caixa.setPointerCapture(e.pointerId);
    }
    caixa.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const aoSoltarPonteiro = () => {
    const a = arrasto.current;
    arrasto.current = null;
    if (a === null || !a.ativo || caixa === null || noCanto === null) return;
    const palco = caixa.parentElement?.getBoundingClientRect();
    const r = caixa.getBoundingClientRect();
    lembrarPosicao();
    caixa.style.transform = '';
    acabouDeArrastar.current = true;
    window.setTimeout(() => {
      acabouDeArrastar.current = false;
    }, 0);
    if (palco === undefined || palco.width === 0 || palco.height === 0) return;
    noCanto.aoSoltar(
      cantoMaisPerto((r.left + r.width / 2 - palco.left) / palco.width, (r.top + r.height / 2 - palco.top) / palco.height),
    );
  };

  const comImagem = state.status === 'watching' || (state.status === 'reconnecting' && state.stream !== null);
  const zoomAtivo = principal ? zoom : null;

  /*
    UMA árvore para os dois papéis: caixa → palco → transformação → vídeo.
    Se a principal e a secundária tivessem formas diferentes, a troca
    desmontaria o `<video>` — e o efeito do `srcObject` (que depende do
    stream, não do elemento) não rodaria de novo: tela preta.
  */
  return (
    <div
      ref={setCaixa}
      className={`${posicao.classe} ${noCanto !== null ? 'touch-none' : ''}`}
      style={posicao.estilo}
      data-canal={canal}
      data-papel={principal ? 'principal' : 'secundaria'}
      onPointerDown={aoPressionar}
      onPointerMove={aoMover}
      onPointerUp={aoSoltarPonteiro}
      onPointerCancel={aoSoltarPonteiro}
    >
      {/*
        O palco do vídeo: na principal recebe a roda (zoom) e o arrasto (pan).
        O vídeo do jogo NUNCA leva scanline.

        `muted` obrigatório no primeiro play: sem isso o browser bloqueia o
        autoplay inteiro e o espectador vê tela preta em vez de vídeo.
      */}
      <div
        ref={zoomAtivo?.palcoRef}
        onWheel={zoomAtivo?.aoRodar}
        onPointerDown={zoomAtivo?.aoPressionar}
        onPointerMove={zoomAtivo?.aoMover}
        onPointerUp={(e) => {
          if (zoomAtivo === null) return;
          zoomAtivo.aoSoltar(e);
          aoTocarNoVideo?.(e);
        }}
        onPointerCancel={zoomAtivo?.aoSoltar}
        className={[
          'absolute inset-0 overflow-hidden bg-black',
          zoomAtivo !== null && zoomAtivo.zoom > 1
            ? zoomAtivo.arrastando
              ? 'cursor-grabbing touch-none'
              : 'cursor-grab touch-none'
            : '',
        ].join(' ')}
      >
        <div
          className={`h-full w-full origin-center ${zoomAtivo?.arrastando ? '' : 'transition-transform duration-200 motion-reduce:transition-none'}`}
          style={
            zoomAtivo === null
              ? undefined
              : { transform: `translate(${zoomAtivo.pan.x}px, ${zoomAtivo.pan.y}px) scale(${zoomAtivo.zoom})` }
          }
        >
          <video ref={montar} autoPlay playsInline muted={som.mudo} className="h-full w-full bg-black object-contain" />
        </div>
      </div>

      {destacado && <div aria-hidden="true" className="pointer-events-none absolute inset-0 border-2 border-accent" />}

      {quadro !== null && (
        <MolduraDoQuadro
          canal={canal}
          aoVivo={comImagem && quadro.pausa === null}
          aviso={quadro.pausa === null && !comImagem ? AVISO[state.status] : null}
          pausa={quadro.pausa}
          congelado={quadro.congelado}
          comToque={quadro.comToque}
          rotuloNoTopo={quadro.rotuloNoTopo}
          tamanho={
            noCanto === null ? null : { rotulo: ROTULO_DO_TAMANHO[noCanto.tamanho], aoMudar: noCanto.aoMudarTamanho }
          }
          aoTrocar={() => {
            if (!acabouDeArrastar.current) quadro.aoTrocar();
          }}
          aoFechar={quadro.aoFechar}
        />
      )}

      {sobreposicao !== undefined && sobreposicao !== null && (
        <div className="absolute inset-0 overflow-y-auto bg-void">{sobreposicao}</div>
      )}
    </div>
  );
}
