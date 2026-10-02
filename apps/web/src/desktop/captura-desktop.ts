import { err, ok } from '../core/domain/result.js';
import type { CaptureRequest, CaptureResult, CaptureError, ScreenCapture } from '../core/ports/screen-capture.js';
import type { CapacidadesDesktop, ErroDeCapturaNativa, FimDaCapturaNativa, PonteDesktop } from './ponte.js';
import type { LigacaoNativa } from './porta-nativa.js';
import type { SeletorDeFontes } from './seletor-de-fontes.js';

/**
 * O `ScreenCapture` do app desktop (D2): o mesmo contrato que a
 * `BroadcastSession` usa na web, com três caminhos atrás dele.
 *
 * 1. **Nativo** (Linux com NVENC, `capacidades().nvenc`): o main sobe o
 *    `tela-captura`, que abre o portal do sistema e captura e codifica
 *    sozinho. Não existe `MediaStreamTrack` da imagem — a sessão recebe uma
 *    trilha-fantasma (um canvas parado) só para ter o que publicar, parar e
 *    observar. Parar a fantasma para o processo; o processo morrer encerra a
 *    fantasma como uma trilha real encerra (`ended` → `CAPTURE_ENDED`).
 * 2. **Seletor próprio** (Windows, Linux X11): a interface mostra telas e
 *    janelas com miniatura; a escolha vai ao main, que a entrega ao
 *    `getDisplayMedia` seguinte. Cancelar é `DENIED`, como fechar o seletor
 *    do navegador.
 * 3. **Portal** (Wayland sem NVENC): o `getDisplayMedia` de sempre, e o
 *    diálogo é do sistema.
 *
 * Se o nativo falhar ao subir (portal ausente, plugin faltando), cai no 2 ou
 * no 3 em silêncio e não tenta de novo nesta execução; o diagnóstico mostra
 * `WebCodecs·…` em vez de `nativo·NVENC`, e `motivoDoFallback` diz por quê.
 */
export type DepsDaCapturaDesktop = {
  readonly ponte: Pick<PonteDesktop, 'capacidades' | 'escolherFonte' | 'capturaNativa'>;
  readonly seletor: Pick<SeletorDeFontes, 'abrir'>;
  /** O `getDisplayMedia` de sempre (`adapters/browser-screen-capture.ts`). */
  readonly navegador: ScreenCapture;
  readonly ligacao: Pick<LigacaoNativa, 'aguardar' | 'ligar' | 'desligar'>;
  /** A trilha que a sessão recebe no caminho nativo. */
  readonly criarTrilhaFantasma: () => MediaStreamTrack;
};

export type CapturaDesktop = ScreenCapture & {
  /** A trilha é uma fantasma do caminho nativo (quem codifica precisa saber). */
  ehNativa(track: MediaStreamTrack): boolean;
  /** Por que o caminho nativo foi abandonado nesta execução, se foi. */
  motivoDoFallback(): ErroDeCapturaNativa | null;
};

/**
 * O fps que um `MediaTrackConstraints` pede, como inteiro que o processo
 * entende (1–240), ou `null` se não pede nenhum. `exact` > `max` > `ideal`: é
 * a ordem em que o navegador os honraria como TETO.
 */
export function fpsPedido(constraints: MediaTrackConstraints | undefined): number | null {
  const f = constraints?.frameRate;
  const valor = typeof f === 'number' ? f : f === undefined ? undefined : (f.exact ?? f.max ?? f.ideal);
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  return Math.min(240, Math.max(1, Math.round(valor)));
}

const SEM_CAPACIDADES: CapacidadesDesktop = { nvenc: false, nvencDetalhe: 'SEM_PONTE', seletorProprio: false };

export function makeCapturaDesktop(deps: DepsDaCapturaDesktop): CapturaDesktop {
  let capacidades: Promise<CapacidadesDesktop> | null = null;
  let fallback: ErroDeCapturaNativa | null = null;
  /** Toda fantasma já criada, viva ou não: o codificador pergunta pela trilha. */
  const fantasmas = new WeakSet<MediaStreamTrack>();
  /** As sessões nativas vivas, pela trilha que as representa. */
  const vivas = new Map<number, MediaStreamTrack>();

  const capacidadesDoApp = (): Promise<CapacidadesDesktop> => {
    capacidades ??= deps.ponte.capacidades().then(
      (c) => c ?? SEM_CAPACIDADES,
      () => SEM_CAPACIDADES,
    );
    return capacidades;
  };

  // O processo morreu com a captura no ar: a fantasma encerra como uma trilha
  // de verdade encerraria, e a sessão para com `CAPTURE_ENDED`.
  deps.ponte.capturaNativa.aoEncerrar((fim: FimDaCapturaNativa) => {
    const trilha = vivas.get(fim.id);
    if (trilha === undefined) return;
    vivas.delete(fim.id);
    deps.ligacao.desligar(fim.id);
    trilha.stop();
    trilha.dispatchEvent(new Event('ended'));
  });

  const pelaCapturaNativa = async (options: CaptureRequest): Promise<CaptureResult | CaptureError | 'FALLBACK'> => {
    const resposta = await deps.ponte.capturaNativa.iniciar({
      width: options.width,
      height: options.height,
      fps: options.frameRate,
    });
    if (!resposta.ok) {
      if (resposta.erro === 'CANCELADO') return 'DENIED';
      if (resposta.erro === 'OCUPADO') return 'FAILED';
      fallback = resposta.erro;
      return 'FALLBACK';
    }
    const { id } = resposta;
    const porta = await deps.ligacao.aguardar(id);
    deps.ligacao.ligar(id, porta);
    const trilha = deps.criarTrilhaFantasma();
    fantasmas.add(trilha);
    vivas.set(id, trilha);
    // Parar a fantasma é parar o processo — inclusive quando a sessão desiste
    // antes de publicar (`stale`) e ninguém mandaria a ordem `parar`.
    const pararTrilha = trilha.stop.bind(trilha);
    trilha.stop = () => {
      pararTrilha();
      if (vivas.get(id) !== trilha) return;
      vivas.delete(id);
      deps.ligacao.desligar(id);
      deps.ponte.capturaNativa.parar(id);
    };
    // A ociosidade da sessão (`track.applyConstraints({ frameRate: 5 })`) é
    // dirigida ao `<video>` de uma captura do Chromium; aqui ela precisa virar
    // o `teto` do processo, senão ele captura e codifica a 60 fps sem ninguém.
    // Não chama o original: a trilha-fantasma é um canvas e rejeitaria
    // `width`/`height` com OverconstrainedError, e a sessão leria a rejeição
    // como "o navegador recusa" e desistiria da economia.
    let tetoEnviado: number | null = null;
    trilha.applyConstraints = (constraints) => {
      const fps = fpsPedido(constraints);
      if (fps !== null && fps !== tetoEnviado && vivas.get(id) === trilha) {
        tetoEnviado = fps;
        porta.postMessage({ tipo: 'ordem', linha: `teto ${fps}` });
      }
      return Promise.resolve();
    };
    // O portal não diz se foi monitor ou janela; no Linux o som não vem da
    // captura, então a superfície não muda o que a pessoa recebe.
    return { video: trilha, audio: null, surface: 'desconhecido' };
  };

  const peloSeletorProprio = async (options: CaptureRequest) => {
    const fonte = await deps.seletor.abrir();
    if (fonte === null) {
      await deps.ponte.escolherFonte(null);
      return err<CaptureError>('DENIED');
    }
    // O main só aceita um id da última listagem; recusar aqui é bug ou corrida.
    if (!(await deps.ponte.escolherFonte(fonte.id))) return err<CaptureError>('FAILED');
    const r = await deps.navegador.request(options);
    if (!r.ok) return r;
    // Em Electron o `displaySurface` da trilha não vem; a escolha diz a verdade.
    return ok({ ...r.value, surface: fonte.tipo === 'tela' ? ('monitor' as const) : ('window' as const) });
  };

  return {
    isSupported: () => true,

    async request(options) {
      const c = await capacidadesDoApp();
      if (c.nvenc && fallback === null) {
        const r = await pelaCapturaNativa(options);
        if (r !== 'FALLBACK') return typeof r === 'string' ? err(r) : ok(r);
      }
      if (c.seletorProprio) return peloSeletorProprio(options);
      return deps.navegador.request(options);
    },

    ehNativa: (track) => fantasmas.has(track),
    motivoDoFallback: () => fallback,
  };
}
