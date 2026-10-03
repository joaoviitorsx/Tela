import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { nomeDoPerfilIdc, perfilDoSps } from '../core/media/perfil-h264.js';
import { janelaDeChaveMs } from '../core/media/fila-de-injecao.js';
import type { CodificadorUnico, DepsDoCodificador, EstatisticasDoCodificador } from './codificador-unico.js';

/**
 * Codificador único que mora FORA do Chromium: um processo nativo captura a
 * tela e codifica na GPU (o `tela-captura` do desktop no Linux, D0c), e manda
 * cada quadro H.264 por uma porta. Aqui só se traduz o protocolo — a captura,
 * a escala e o NVENC são dele.
 *
 * A trilha que o transporte entrega em `iniciar` não é a imagem: o processo
 * escolhe a fonte pelo portal do sistema. Por isso o tamanho vem do evento
 * `pronto`, por `fonte()`.
 */

/** O que chega pela porta (ver apps/desktop/d0/protocolo-captura.mjs). */
export type MensagemDoNativo =
  | {
      readonly tipo: 'quadro';
      readonly chave: boolean;
      readonly width: number;
      readonly height: number;
      readonly dados: ArrayBuffer;
    }
  | { readonly tipo: 'evento'; readonly evento: EventoDoNativo }
  /**
   * Quadro capturado que o processo descartou pela contrapressão. Move a isca
   * como no WebCodecs (`aoCapturar` a cada quadro capturado): sem isso a fila
   * dos senders não anda, a contrapressão não cede e só passam os IDRs.
   */
  | { readonly tipo: 'captura' };

export type EventoDoNativo =
  | { readonly evento: 'pronto'; readonly fonte: { readonly width: number; readonly height: number } }
  | { readonly evento: 'stats'; readonly msPorQuadro: number | null; readonly descartados: number }
  | { readonly evento: 'erro'; readonly codigo: string };

/** Uma linha do protocolo de ordens (`alvo`, `chave`, `atraso`, `parar`). */
export type MensagemParaNativo = { readonly tipo: 'ordem'; readonly linha: string };

/** O mínimo de um `MessagePort` que isto usa. */
export type PortaDoNativo = {
  postMessage(m: MensagemParaNativo): void;
  onmessage: ((e: { readonly data: MensagemDoNativo }) => void) | null;
};

/** Variação de bitrate abaixo disto não vale uma ordem. */
const MUDANCA_DE_BITRATE = 0.05;

export class CodificadorExterno implements CodificadorUnico {
  private ativo = false;
  private seq = 0;
  private enviado: AlvoDoCodificador | null = null;
  private tamanhoDaFonte: { width: number; height: number } | null = null;
  private ultimaChave = -Infinity;
  private idrs = 0;
  private readonly pedidos: Record<string, number> = {};
  private quadros = 0;
  private marca = { t: 0, quadros: 0 };
  private ultimo = { width: 0, height: 0 };
  private msPorQuadro: number | null = null;
  private falhou: string | null = null;
  /** `profile_idc` do último SPS que o helper mandou: o perfil de FATO. */
  private perfilEmitido: number | null = null;
  /** Bytes que o helper mandou desde a última leitura de estatísticas. */
  private bytesProduzidos = 0;

  /** O `rc-mode` enviado ao helper por último. */
  private taxaEnviada: 'vbr' | 'cbr' | null = null;

  constructor(
    private readonly porta: PortaDoNativo,
    private readonly deps: DepsDoCodificador,
    private readonly agora: () => number = () => performance.now(),
    /** Experimental: VBR economiza com a tela parada. Ausente = CBR, como sempre. */
    private readonly modoDeTaxa: () => 'vbr' | 'cbr' = () => 'cbr',
  ) {
    porta.onmessage = (e) => this.chegou(e.data);
  }

  async iniciar(_track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void> {
    this.ativo = true;
    this.marca = { t: this.agora(), quadros: this.quadros };
    this.configurar(alvo);
    this.pedirChave('entrada');
  }

  configurar(alvo: AlvoDoCodificador): void {
    const e = this.enviado;
    const mudouTamanho = e === null || e.width !== alvo.width || e.height !== alvo.height || e.fps !== alvo.fps;
    const mudouBitrate = e === null || Math.abs(e.bitrate - alvo.bitrate) / Math.max(1, e.bitrate) > MUDANCA_DE_BITRATE;
    // O piso de perfil da sala (adendo à ADR 0016). O helper recicla a
    // codificação e recomeça num IDR; um helper antigo ignora a ordem.
    if (e === null || e.perfil !== alvo.perfil) this.ordem(`perfil ${alvo.perfil}`);
    // O padrão do helper é CBR: só manda quando o ajuste pede outra coisa (ou volta).
    const taxa = this.modoDeTaxa();
    if (taxa !== (this.taxaEnviada ?? 'cbr')) this.ordem(`taxa ${taxa}`);
    this.taxaEnviada = taxa;
    if (!mudouTamanho && !mudouBitrate) {
      this.enviado = { ...(e ?? alvo), perfil: alvo.perfil };
      return;
    }
    this.enviado = alvo;
    this.ordem(`alvo ${alvo.width} ${alvo.height} ${alvo.fps} ${Math.round(alvo.bitrate)}`);
  }

  /** A fonte é escolhida no portal do sistema, não por trilha. */
  trocarFonte(_track: MediaStreamTrack): void {
    this.pedirChave('outro');
  }

  /** Mesma regra do WebCodecs: um IDR por `janelaDeChaveMs(senders, motivo)`. */
  pedirChave(motivo = 'outro', senders = 0): void {
    this.pedidos[motivo] = (this.pedidos[motivo] ?? 0) + 1;
    const agora = this.agora();
    if (agora - this.ultimaChave < janelaDeChaveMs(senders, motivo)) return;
    this.ultimaChave = agora;
    this.ordem('chave');
  }

  /**
   * Todo aviso vira ordem, repetido ou não: o helper DRENA o próprio atraso a
   * cada quadro pulado (`tela-captura.c`, `ao_capturar`), então o valor dele
   * diverge do último que mandamos — um "2" repetido é o que o devolve à
   * contrapressão. ~10 linhas curtas por segundo no stdin.
   */
  definirAtraso(quadros: number): void {
    this.ordem(`atraso ${quadros}`);
  }

  estatisticas(): EstatisticasDoCodificador {
    const agora = this.agora();
    const dt = Math.max(0.001, (agora - this.marca.t) / 1000);
    const fps = (this.quadros - this.marca.quadros) / dt;
    this.marca = { t: agora, quadros: this.quadros };
    const bitrateProduzido = (this.bytesProduzidos * 8) / dt;
    this.bytesProduzidos = 0;
    const alvo = this.enviado;
    return {
      width: this.ultimo.width,
      height: this.ultimo.height,
      fps,
      msPorQuadro: this.msPorQuadro,
      bitrateAlvo: alvo?.bitrate ?? 0,
      hardware: true,
      // Um quadro levando mais que o período inteiro: a GPU não dá conta.
      sobrecarregado: this.msPorQuadro !== null && alvo !== null && this.msPorQuadro > 1000 / alvo.fps,
      // O helper aplica o `atraso` lá dentro e não conta o que pulou.
      segurados: 0,
      idrs: this.idrs,
      bitrateProduzido,
      pedidosDeChave: { ...this.pedidos },
      implementacao:
        this.falhou !== null
          ? `nativo·falhou(${this.falhou})`
          : nomeDoPerfilIdc(this.perfilEmitido) === null
            ? 'nativo·NVENC'
            : `nativo·NVENC · H.264 ${nomeDoPerfilIdc(this.perfilEmitido)}`,
    };
  }

  fonte(): { readonly width: number; readonly height: number } | null {
    return this.tamanhoDaFonte;
  }

  parar(): void {
    this.ativo = false;
    this.ordem('parar');
    this.porta.onmessage = null;
  }

  private ordem(linha: string): void {
    this.porta.postMessage({ tipo: 'ordem', linha });
  }

  private chegou(m: MensagemDoNativo): void {
    if (m.tipo === 'evento') {
      const e = m.evento;
      if (e.evento === 'pronto') {
        this.tamanhoDaFonte = { width: e.fonte.width, height: e.fonte.height };
        this.deps.aoMudarFonte();
      } else if (e.evento === 'stats') {
        this.msPorQuadro = e.msPorQuadro;
      } else if (e.evento === 'erro') {
        this.falhou = e.codigo;
      }
      return;
    }
    // Antes de `iniciar` não há sender para receber: o quadro só envelheceria.
    if (!this.ativo) return;
    if (m.tipo === 'captura') {
      this.deps.aoCapturar();
      return;
    }
    this.quadros += 1;
    this.bytesProduzidos += m.dados.byteLength;
    if (m.chave) {
      this.idrs += 1;
      // Antes de transferir: depois o buffer é do worker.
      this.perfilEmitido = perfilDoSps(new Uint8Array(m.dados)) ?? this.perfilEmitido;
    }
    this.ultimo = { width: m.width, height: m.height };
    this.deps.aoCapturar();
    this.deps.entregar(
      { seq: this.seq++, chave: m.chave, dados: m.dados, width: m.width, height: m.height },
      [m.dados],
    );
  }
}
