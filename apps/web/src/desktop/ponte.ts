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

/** O que o renderer conta ao main sobre a transmissão (D4): bandeja e política de fechar. */
export type EstadoAoVivo = {
  readonly noAr: boolean;
  /** `Date.now()` de quando foi ao ar; `null` fora do ar. */
  readonly inicioMs: number | null;
  readonly assistindo: number;
  readonly capacidade: number;
  /** O link público (https), ou `null`. */
  readonly link: string | null;
};

export type AoFecharAoVivo = 'perguntar' | 'segundo-plano' | 'encerrar';

/** Os ajustes do app, guardados pelo main em `userData`. */
export type AjustesDesktop = {
  readonly iniciarComSistema: boolean;
  readonly fecharEmSegundoPlano: boolean;
  readonly sempreNoTopoNoCompacto: boolean;
  readonly aoFecharAoVivo: AoFecharAoVivo;
};

export type RespostaDeAjustes = {
  readonly ajustes: AjustesDesktop;
  /** Há ícone de bandeja neste sistema? Sem ele, "segundo plano" vira a janela compacta. */
  readonly bandeja: boolean;
  /** Gravar o autostart falhou; o ajuste voltou ao valor anterior. */
  readonly autostartFalhou: boolean;
};

export type ModoDaJanela = 'normal' | 'compacto';

/** Um aplicativo com som, para o seletor de "só o jogo" (D3). `icone` é um `data:image/png` ou `null`. */
export type AppComSom = {
  readonly id: string;
  readonly nome: string;
  /** Algum som seu está saindo agora. */
  readonly tocando: boolean;
  readonly icone: string | null;
};

export type CapacidadesDeSom = {
  /**
   * "Só o jogo" funciona neste sistema? Quando não, o motivo vai ao usuário
   * junto da opção desabilitada — nunca se troca por "Sistema" em silêncio.
   */
  readonly jogo: { readonly disponivel: boolean; readonly motivo: string | null };
};

export type ErroSomJogo = 'INDISPONIVEL' | 'APP_NAO_ENCONTRADO' | 'FALHOU' | 'OCUPADO';

/** O modo "Sistema" no Linux: `descricao` é o rótulo da fonte virtual no Chromium. */
export type RespostaSomSistema =
  | { readonly ok: true; readonly descricao: string }
  | { readonly ok: false; readonly erro: ErroSomJogo };

/**
 * `entrada` (Linux): o som chega como dispositivo de entrada (uma fonte
 * virtual); `descricao` é o que o Chromium escreve no rótulo dele. `porta` (Windows): PCM por uma
 * `MessagePort` marcada com `MARCA_DA_PORTA_SOM` e este `id`.
 */
export type RespostaSomJogo =
  | { readonly ok: true; readonly app: string; readonly via: 'entrada'; readonly descricao: string }
  | { readonly ok: true; readonly app: string; readonly via: 'porta'; readonly id: number }
  | { readonly ok: false; readonly erro: ErroSomJogo };

export type FimDoSomDoJogo = { readonly motivo: 'SINK_CAIU' | 'PROCESSO_ENCERROU' | 'COMPONENTE_CAIU' };

/** A resposta do diálogo "Continuar transmitindo em segundo plano?". */
export type RespostaDeFechar = {
  readonly acao: 'segundo-plano' | 'encerrar' | 'cancelar';
  readonly lembrar: boolean;
};

/** Por que o main mandou parar: `sair` (Sair/Ctrl+Q/bandeja) ou `suspensao` (o sistema vai dormir). */
export type MotivoDeParada = 'sair' | 'suspensao';

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
   * Segundo plano (D4). O estado da transmissão, para a bandeja e para a
   * política de fechar. O renderer manda no máximo 1 Hz e só na mudança; o
   * main valida e ignora o que não for um estado.
   */
  enviarEstadoAoVivo(estado: EstadoAoVivo): void;
  ajustes(): Promise<RespostaDeAjustes>;
  /** Só os campos que mudaram; o main valida, grava, aplica o autostart e devolve o resultado. */
  salvarAjustes(parcial: Partial<AjustesDesktop>): Promise<RespostaDeAjustes>;
  /** Pede o modo compacto ou o normal. O main decide e responde por `aoMudarModo`. */
  pedirModo(modo: ModoDaJanela): void;
  /**
   * O modo da janela. Entrega o valor atual na hora, se já se sabe — a janela
   * pode ter nascido compacta ou ter recarregado depois de uma queda.
   */
  aoMudarModo(ouvinte: (modo: ModoDaJanela) => void): () => void;
  /** A janela foi fechada ao vivo e não há escolha lembrada: perguntar. */
  aoPerguntarFechar(ouvinte: () => void): () => void;
  responderFechar(resposta: RespostaDeFechar): void;
  /** "Encerrar transmissão" da bandeja: roda o fluxo de encerrar da própria interface, com a confirmação. */
  aoPedirEncerrar(ouvinte: () => void): () => void;
  /** Parar SEM perguntar (sair, suspensão): `stop()` da sessão, e então `paradaConcluida()`. */
  aoPedirParar(ouvinte: (motivo: MotivoDeParada) => void): () => void;
  paradaConcluida(): void;

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

  /** O som da transmissão (D3, `docs/desktop/D3-som.md`). */
  readonly som: {
    capacidades(): Promise<CapacidadesDeSom>;
    /** Aplicativos com som agora. Vazio quando não há como listar (o motivo está em `capacidades`). */
    listarApps(): Promise<readonly AppComSom[]>;
    /**
     * "Só o jogo": o main isola o som do app escolhido. O id só vale se veio
     * da última listagem. O som é desfeito por `pararSom` — ou sozinho, se o
     * app morrer.
     */
    iniciarJogo(appId: string): Promise<RespostaSomJogo>;
    /** Devolve o roteamento ao que era. Idempotente. */
    pararSom(): void;
    /**
     * Linux, modo "Sistema": cria a fonte virtual do monitor da saída padrão
     * (o Chromium não lista monitores). `parar` a remove. No Windows o
     * "Sistema" é o `loopback` junto da tela e isto devolve `INDISPONIVEL`.
     */
    iniciarSistema(): Promise<RespostaSomSistema>;
    /** O som do jogo parou sem ninguém pedir (o sink caiu, o jogo fechou, o componente morreu). */
    aoEncerrar(ouvinte: (fim: FimDoSomDoJogo) => void): () => void;
  };

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
  /** renderer → main (invoke) → `CapacidadesDeSom` */
  somCapacidades: 'tela:som-capacidades',
  /** renderer → main (invoke) → `AppComSom[]` */
  somListarApps: 'tela:som-listar-apps',
  /** renderer → main (invoke), `string` (id do app) → `RespostaSomJogo` */
  somIniciarJogo: 'tela:som-iniciar-jogo',
  /** renderer → main */
  somParar: 'tela:som-parar',
  /** renderer → main (invoke) → `RespostaSomSistema` */
  somIniciarSistema: 'tela:som-iniciar-sistema',
  /** main → renderer, `FimDoSomDoJogo` */
  somJogoEncerrou: 'tela:som-jogo-encerrou',
  /** main → renderer, `{ id }` com a `MessagePort` do PCM em `ports[0]` (Windows) */
  somJogoPorta: 'tela:som-jogo-porta',
  /** main → renderer, `string` (slug já validado) */
  abrirCanal: 'tela:abrir-canal',
  /** renderer → main, `EstadoAoVivo` */
  estadoAoVivo: 'tela:estado-ao-vivo',
  /** renderer → main (invoke) → `RespostaDeAjustes` */
  ajustes: 'tela:ajustes',
  /** renderer → main (invoke), `Partial<AjustesDesktop>` → `RespostaDeAjustes` */
  salvarAjustes: 'tela:salvar-ajustes',
  /** renderer → main, `ModoDaJanela` */
  pedirModo: 'tela:pedir-modo',
  /** main → renderer, `ModoDaJanela` */
  modo: 'tela:modo',
  /** main → renderer */
  perguntarFechar: 'tela:perguntar-fechar',
  /** renderer → main, `RespostaDeFechar` */
  responderFechar: 'tela:responder-fechar',
  /** main → renderer */
  pedirEncerrar: 'tela:pedir-encerrar',
  /** main → renderer, `MotivoDeParada` */
  parar: 'tela:parar',
  /** renderer → main */
  paradaConcluida: 'tela:parada-concluida',
} as const;

/**
 * A porta dos quadros não passa pelo `contextBridge`: o preload a repassa ao
 * mundo da página com `window.postMessage({ tipo: MARCA_DA_PORTA, id }, '*',
 * [porta])`, o jeito documentado pelo Electron para portas atravessarem o
 * isolamento de contexto. `porta-nativa.ts` é quem escuta.
 */
export const MARCA_DA_PORTA = 'tela:porta-nativa';

/** A mesma ideia para a porta do PCM do "só o jogo" no Windows (D3). */
export const MARCA_DA_PORTA_SOM = 'tela:porta-som';

declare global {
  interface Window {
    readonly telaDesktop?: PonteDesktop;
  }
}
