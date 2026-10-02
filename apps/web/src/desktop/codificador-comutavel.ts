import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';

/**
 * O codificador único do app, que escolhe entre dois na hora de iniciar:
 * o externo (NVENC pelo `tela-captura`) quando a trilha que chegou é a
 * trilha-fantasma da captura nativa, e o WebCodecs quando é uma captura de
 * verdade do Chromium.
 *
 * Por que decidir tão tarde: o transporte nasce com o codificador antes de a
 * pessoa escolher o que transmitir, e é só na captura que se sabe se o
 * processo nativo subiu. Se ele falhar (portal ausente, GStreamer sem um
 * plugin), a captura cai no `getDisplayMedia` e o codificador cai no
 * WebCodecs — ninguém acima fica sabendo, e `encoderImplementation` conta.
 *
 * Genérico sobre a forma do codificador real: `src/desktop/` não importa
 * `adapters/` (lint), e o container é quem passa as fábricas de verdade.
 */
export interface CodificadorMinimo {
  iniciar(track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void>;
  configurar(alvo: AlvoDoCodificador): void;
  trocarFonte(track: MediaStreamTrack): void;
  pedirChave(motivo?: string, senders?: number): void;
  definirAtraso(quadros: number): void;
  estatisticas(): unknown;
  fonte(): { readonly width: number; readonly height: number } | null;
  parar(): void;
}

export type Caminho = 'nativo' | 'webcodecs';

export type DepsDoComutavel<C extends CodificadorMinimo> = {
  readonly nativo: () => C;
  readonly webcodecs: () => C;
  /** A trilha é a fantasma da captura nativa (`captura-desktop.ts`). */
  readonly ehNativa: (track: MediaStreamTrack) => boolean;
};

export class CodificadorComutavel<C extends CodificadorMinimo> implements CodificadorMinimo {
  private atual: C;
  private caminho: Caminho;
  private alvo: AlvoDoCodificador | null = null;
  private atraso = 0;
  private iniciado = false;

  constructor(private readonly deps: DepsDoComutavel<C>) {
    // O externo nasce já: ele é quem escuta a porta, e o `pronto` da captura
    // chega antes de `iniciar`.
    this.atual = deps.nativo();
    this.caminho = 'nativo';
  }

  /** Qual dos dois está no ar — diagnóstico e testes. */
  get caminhoAtual(): Caminho {
    return this.caminho;
  }

  async iniciar(track: MediaStreamTrack, alvo: AlvoDoCodificador): Promise<void> {
    this.alvo = alvo;
    const caminho = this.caminhoDe(track);
    if (caminho !== this.caminho) {
      // O que não vai ser usado solta a porta (o externo) antes de sair de cena.
      this.atual.parar();
      this.trocarPara(caminho);
    }
    this.iniciado = true;
    await this.atual.iniciar(track, alvo);
    if (this.atraso !== 0) this.atual.definirAtraso(this.atraso);
  }

  configurar(alvo: AlvoDoCodificador): void {
    this.alvo = alvo;
    this.atual.configurar(alvo);
  }

  /**
   * Trocar de fonte ao vivo pode trocar de caminho (o nativo caiu e a captura
   * voltou ao Chromium, ou o contrário). Aí o codificador antigo para e o
   * novo começa do zero, no mesmo alvo: o próximo quadro é IDR de qualquer
   * jeito.
   */
  trocarFonte(track: MediaStreamTrack): void {
    const caminho = this.caminhoDe(track);
    if (caminho === this.caminho || !this.iniciado) {
      this.atual.trocarFonte(track);
      return;
    }
    this.atual.parar();
    this.trocarPara(caminho);
    if (this.alvo !== null) {
      void this.atual.iniciar(track, this.alvo).then(() => {
        if (this.atraso !== 0) this.atual.definirAtraso(this.atraso);
      });
    }
  }

  pedirChave(motivo?: string, senders?: number): void {
    this.atual.pedirChave(motivo, senders);
  }

  definirAtraso(quadros: number): void {
    this.atraso = quadros;
    this.atual.definirAtraso(quadros);
  }

  estatisticas(): ReturnType<C['estatisticas']> {
    return this.atual.estatisticas() as ReturnType<C['estatisticas']>;
  }

  fonte(): { readonly width: number; readonly height: number } | null {
    return this.atual.fonte();
  }

  parar(): void {
    this.iniciado = false;
    this.atual.parar();
  }

  private caminhoDe(track: MediaStreamTrack): Caminho {
    return this.deps.ehNativa(track) ? 'nativo' : 'webcodecs';
  }

  private trocarPara(caminho: Caminho): void {
    this.caminho = caminho;
    this.atual = caminho === 'nativo' ? this.deps.nativo() : this.deps.webcodecs();
  }
}
