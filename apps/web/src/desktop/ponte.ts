/**
 * A ponte entre o renderer e o processo principal do Tela Desktop.
 *
 * O preload (`apps/desktop/src/preload/preload.cts`) expõe exatamente isto em
 * `window.telaDesktop`, por `contextBridge`. Operações nomeadas, nada de acesso
 * genérico a Node nem a `ipcRenderer` (PLANO-desktop §3.3–3.4). Este arquivo é
 * o CONTRATO: os dois lados seguem os nomes daqui.
 *
 * Na web `window.telaDesktop` não existe — quem precisa dela está em
 * `src/desktop/`, que só entra no build do app.
 */
export type PlataformaDesktop = 'win32' | 'linux' | 'darwin';

/** O que o main descobriu ao abrir, antes de a pessoa apertar TRANSMITIR (D2). */
export type CapacidadesDesktop = {
  /**
   * `tela-captura --sondar` respondeu que o NVENC abre: a transmissão no Linux
   * captura e codifica fora do Chromium (D0c). `false` = WebCodecs.
   */
  readonly nvenc: boolean;
  /** Por que não, ou a versão do GStreamer quando sim — para o diagnóstico. */
  readonly nvencDetalhe: string;
  /**
   * O app mostra o próprio seletor (Windows e Linux X11). No Wayland o portal
   * do sistema é quem pergunta, e `getDisplayMedia` já abre o diálogo dele.
   */
  readonly seletorProprio: boolean;
};

export type TipoDeFonte = 'tela' | 'janela';

/** Uma tela ou janela que a pessoa pode escolher no seletor próprio. */
export type FonteDeCaptura = {
  readonly id: string;
  readonly nome: string;
  readonly tipo: TipoDeFonte;
  /** `data:image/jpeg;base64,…`, ou `null` quando o sistema não entregou. */
  readonly miniatura: string | null;
  /** Ícone do aplicativo dono da janela, ou `null`. */
  readonly icone: string | null;
};

export type PedidoDeCapturaNativa = {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

export type ErroDeCapturaNativa =
  | 'CANCELADO'
  | 'SEM_NVENC'
  | 'SEM_COMPONENTE'
  | 'PORTAL'
  | 'PIPELINE'
  | 'MORREU'
  | 'INDISPONIVEL'
  | 'OCUPADO';

export type RespostaDeCapturaNativa =
  | {
      readonly ok: true;
      /** Identifica a sessão do processo: vai em `parar`, na porta e no fim. */
      readonly id: number;
      readonly fonte: { readonly width: number; readonly height: number };
      /** `dmabuf` ou `sistema`: diagnóstico. */
      readonly memoria: string;
    }
  | { readonly ok: false; readonly erro: ErroDeCapturaNativa };

export type FimDaCapturaNativa = {
  readonly id: number;
  readonly motivo: 'FONTE_ENCERRADA' | 'PIPELINE' | 'PORTAL' | 'MORREU';
  readonly codigo: number | null;
};

export interface PonteDesktop {
  readonly plataforma: PlataformaDesktop;
  /** Versão do app (`app.getVersion()`), para o diagnóstico. */
  readonly versao: string;
  /**
   * A janela apareceu ou sumiu (minimizada, escondida, restaurada). Com
   * `backgroundThrottling: false` a página não fica sabendo sozinha, então o
   * main avisa (§3.2). Devolve a função que cancela a assinatura.
   */
  aoMudarVisibilidade(ouvinte: (visivel: boolean) => void): () => void;
  /** Abre um link `https:` no navegador do sistema. O main valida e recusa o resto. */
  abrirNoNavegador(url: string): void;
  /**
   * Chegou um `tela://assistir/<canal>` (clique no link com o app instalado).
   * O main já validou o slug; a página valida DE NOVO e decide se pode
   * navegar — ao vivo, não pode. Links que chegaram antes da assinatura (o app
   * abriu pelo link) são entregues ao primeiro ouvinte.
   */
  aoAbrirCanal(ouvinte: (slug: string) => void): () => void;

  capacidades(): Promise<CapacidadesDesktop>;

  /**
   * Telas e janelas com miniaturas. Custa uma captura de cada janela: só
   * enquanto o seletor está aberto, e não mais de uma vez a cada ~2 s.
   */
  listarFontes(): Promise<readonly FonteDeCaptura[]>;
  /**
   * Guarda a escolha para o PRÓXIMO `getDisplayMedia`, que a consome. `null`
   * cancela: o `getDisplayMedia` seguinte é recusado. O main só aceita um id
   * da última listagem; devolve `false` quando recusa.
   */
  escolherFonte(id: string | null): Promise<boolean>;

  /** O `tela-captura` (Linux com NVENC). Só existe quando `capacidades().nvenc`. */
  readonly capturaNativa: {
    /**
     * Sobe o processo, que abre o portal do sistema; resolve quando a captura
     * está entregando (`pronto`) ou com o motivo. A porta com os quadros
     * chega por `window.postMessage` marcada com `MARCA_DA_PORTA` e o `id`.
     */
    iniciar(pedido: PedidoDeCapturaNativa): Promise<RespostaDeCapturaNativa>;
    parar(id: number): void;
    /** O processo morreu enquanto capturava (a janela fechou, a GPU caiu…). */
    aoEncerrar(ouvinte: (fim: FimDaCapturaNativa) => void): () => void;
  };
}

/** Nomes dos canais IPC. Os dois lados importam daqui ou copiam igual. */
export const CANAIS = {
  /** main → renderer, `boolean` */
  visibilidade: 'tela:visibilidade',
  /** renderer → main, `string` (URL) */
  abrirNoNavegador: 'tela:abrir-no-navegador',
  /** renderer → main (invoke) → `CapacidadesDesktop` */
  capacidades: 'tela:capacidades',
  /** renderer → main (invoke) → `FonteDeCaptura[]` */
  listarFontes: 'tela:listar-fontes',
  /** renderer → main (invoke), `string | null` → `boolean` */
  escolherFonte: 'tela:escolher-fonte',
  /** renderer → main (invoke), `PedidoDeCapturaNativa` → `RespostaDeCapturaNativa` */
  capturaNativaIniciar: 'tela:captura-nativa-iniciar',
  /** renderer → main, `number` (id) */
  capturaNativaParar: 'tela:captura-nativa-parar',
  /** main → renderer, `{ id }` com a `MessagePort` dos quadros em `ports[0]` */
  capturaNativaPorta: 'tela:captura-nativa-porta',
  /** main → renderer, `FimDaCapturaNativa` */
  capturaNativaEncerrou: 'tela:captura-nativa-encerrou',
  /** main → renderer, `string` (slug já validado) */
  abrirCanal: 'tela:abrir-canal',
} as const;

/**
 * A porta dos quadros não passa pelo `contextBridge`: o preload a repassa ao
 * mundo da página com `window.postMessage({ tipo: MARCA_DA_PORTA, id }, '*',
 * [porta])`, o jeito documentado pelo Electron para portas atravessarem o
 * isolamento de contexto. `porta-nativa.ts` é quem escuta.
 */
export const MARCA_DA_PORTA = 'tela:porta-nativa';

declare global {
  interface Window {
    readonly telaDesktop?: PonteDesktop;
  }
}
