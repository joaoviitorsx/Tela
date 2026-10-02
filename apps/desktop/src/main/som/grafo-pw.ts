/**
 * O grafo do PipeWire, lido do `pw-dump` (D3, PLANO-desktop §4).
 *
 * Tudo puro: recebe o JSON já decodificado e devolve os fatos de que o "só o
 * jogo" precisa — quem está tocando, para onde, e qual é a saída padrão.
 * Quem executa o `pw-dump` é `som-jogo-linux.ts`; os testes daqui usam dumps
 * reais desta família de máquinas (`fixtures/`), com nomes trocados.
 *
 * Por que `pw-dump` e não `pactl`: o `pactl` vem do pacote `pulseaudio-utils`,
 * que o Fedora com PipeWire não instala; `pw-dump`, `pw-metadata` e
 * `pw-loopback` vêm todos do próprio PipeWire (`pipewire-utils`). Um único
 * conjunto de ferramentas, e o JSON é um contrato estável.
 */

export type NoPw = {
  readonly id: number;
  readonly nome: string;
  readonly descricao: string | null;
  /** `Stream/Output/Audio` (um app tocando), `Audio/Sink` (uma saída)… */
  readonly classe: string;
  readonly estado: string;
  readonly app: string | null;
  readonly binario: string | null;
  readonly pid: number | null;
  readonly midia: string | null;
  readonly papel: string | null;
  readonly icone: string | null;
  readonly clienteId: number | null;
};

export type LinkPw = { readonly saida: number; readonly entrada: number };

export type MetadadoPw = { readonly sujeito: number; readonly chave: string; readonly valor: unknown; readonly tipo: string | null };

export type ClientePw = {
  readonly id: number;
  readonly app: string | null;
  readonly binario: string | null;
  readonly pid: number | null;
};

export type GrafoPw = {
  readonly nos: readonly NoPw[];
  readonly links: readonly LinkPw[];
  readonly clientes: ReadonlyMap<number, ClientePw>;
  /** Só os metadados do objeto `default` (alvos de stream e saída padrão). */
  readonly metadados: readonly MetadadoPw[];
};

/** Um app que está tocando (ou já tocou e segue aberto) — o que o seletor mostra. */
export type AppComSom = {
  /** `pid:1234`, ou `app:nome|binário` quando o app não informa o pid. */
  readonly id: string;
  readonly nome: string;
  readonly binario: string | null;
  readonly pid: number | null;
  /** Algum stream está `running` agora. */
  readonly tocando: boolean;
  /** Os nós de stream do app: tudo que o "só o jogo" precisa mover. */
  readonly streams: readonly number[];
};

/**
 * Nossos nós. Os prefixos são como os resíduos de uma execução que caiu são
 * reconhecidos; nada fora deles é tocado.
 *
 * Por que há uma ENTRADA além do sink: o Chromium NÃO lista monitores de sink
 * em `enumerateDevices` (verificado no Electron 44: só "Default" e o
 * microfone). O que ele lista são fontes de verdade (`Audio/Source`). Então o
 * monitor do sink alimenta uma fonte virtual — `Tela-Jogo-Entrada` — e é ela
 * que a página captura. A fonte é uma cópia 1:1 do monitor (conferido: o pico
 * medido nos dois é idêntico).
 */
export const PREFIXO_DO_SINK = 'tela_jogo';
export const PREFIXO_DO_SISTEMA = 'tela_sistema';
export const NOME_DO_SINK = 'tela_jogo';
export const DESCRICAO_DO_SINK = 'Tela-Jogo';
export const NOME_DO_RETORNO = 'tela_jogo_retorno';
/** A fonte virtual do modo "só o jogo": o que a página captura. */
export const NOME_DA_ENTRADA_DO_JOGO = 'tela_jogo_mic';
export const NOME_DA_CAPTURA_DO_JOGO = 'tela_jogo_mic_cap';
export const DESCRICAO_DA_ENTRADA_DO_JOGO = 'Tela-Jogo-Entrada';
/** A fonte virtual do modo "sistema": o monitor do sink do sistema, como fonte. */
export const NOME_DA_ENTRADA_DO_SISTEMA = 'tela_sistema_mic';
export const NOME_DA_CAPTURA_DO_SISTEMA = 'tela_sistema_cap';
export const DESCRICAO_DA_ENTRADA_DO_SISTEMA = 'Tela-Sistema-Entrada';
/** O sink do modo "sistema": recebe tudo que toca na saída padrão, menos a call. */
export const NOME_DO_SINK_DO_SISTEMA = 'tela_sistema';
export const DESCRICAO_DO_SINK_DO_SISTEMA = 'Tela-Sistema';
export const NOME_DO_RETORNO_DO_SISTEMA = 'tela_sistema_retorno';
export const CLASSE_DE_FONTE = 'Audio/Source';
export const CLASSE_DE_STREAM = 'Stream/Output/Audio';
export const CLASSE_DE_SINK = 'Audio/Sink';

/**
 * Os quatro nós de um modo: o sink para onde os streams vão, o retorno dele
 * para a saída real (o jogador segue ouvindo) e a fonte virtual que a página
 * captura. "Só o jogo" e "Sistema" montam o MESMO grafo, com nomes próprios —
 * quem olha o pavucontrol vê qual dos dois está no ar.
 */
export type NosDoModo = {
  readonly sink: string;
  readonly descricaoDoSink: string;
  readonly retorno: string;
  readonly entrada: string;
  readonly captura: string;
  readonly descricaoDaEntrada: string;
};

export const NOS_DO_JOGO: NosDoModo = {
  sink: NOME_DO_SINK,
  descricaoDoSink: DESCRICAO_DO_SINK,
  retorno: NOME_DO_RETORNO,
  entrada: NOME_DA_ENTRADA_DO_JOGO,
  captura: NOME_DA_CAPTURA_DO_JOGO,
  descricaoDaEntrada: DESCRICAO_DA_ENTRADA_DO_JOGO,
};

export const NOS_DO_SISTEMA: NosDoModo = {
  sink: NOME_DO_SINK_DO_SISTEMA,
  descricaoDoSink: DESCRICAO_DO_SINK_DO_SISTEMA,
  retorno: NOME_DO_RETORNO_DO_SISTEMA,
  entrada: NOME_DA_ENTRADA_DO_SISTEMA,
  captura: NOME_DA_CAPTURA_DO_SISTEMA,
  descricaoDaEntrada: DESCRICAO_DA_ENTRADA_DO_SISTEMA,
};

type Registro = Record<string, unknown>;

const ehRegistro = (x: unknown): x is Registro => typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
const inteiro = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * O JSON do `pw-dump` como grafo. `null` quando não é um dump (a saída de um
 * erro, texto qualquer): quem chama trata como "PipeWire não respondeu".
 */
export function lerGrafo(json: unknown): GrafoPw | null {
  if (!Array.isArray(json)) return null;
  const nos: NoPw[] = [];
  const links: LinkPw[] = [];
  const clientes = new Map<number, ClientePw>();
  const metadados: MetadadoPw[] = [];

  for (const obj of json as unknown[]) {
    if (!ehRegistro(obj)) continue;
    const id = inteiro(obj['id']);
    const tipo = texto(obj['type']);
    if (id === null || tipo === null) continue;
    const info = ehRegistro(obj['info']) ? obj['info'] : {};
    const props = ehRegistro(info['props']) ? info['props'] : {};

    if (tipo.endsWith(':Node')) {
      const classe = texto(props['media.class']);
      const nome = texto(props['node.name']);
      if (classe === null || nome === null) continue;
      nos.push({
        id,
        nome,
        descricao: texto(props['node.description']),
        classe,
        estado: texto(info['state']) ?? 'desconhecido',
        app: texto(props['application.name']),
        binario: texto(props['application.process.binary']),
        pid: inteiro(props['application.process.id']),
        midia: texto(props['media.name']),
        papel: texto(props['media.role']),
        icone: texto(props['application.icon-name']),
        clienteId: inteiro(props['client.id']),
      });
    } else if (tipo.endsWith(':Link')) {
      const saida = inteiro(props['link.output.node']);
      const entrada = inteiro(props['link.input.node']);
      if (saida !== null && entrada !== null) links.push({ saida, entrada });
    } else if (tipo.endsWith(':Client')) {
      clientes.set(id, {
        id,
        app: texto(props['application.name']),
        binario: texto(props['application.process.binary']),
        pid: inteiro(props['application.process.id']),
      });
    } else if (tipo.endsWith(':Metadata')) {
      const props2 = ehRegistro(obj['props']) ? obj['props'] : {};
      if (props2['metadata.name'] !== 'default' || !Array.isArray(obj['metadata'])) continue;
      for (const e of obj['metadata'] as unknown[]) {
        if (!ehRegistro(e)) continue;
        const sujeito = inteiro(e['subject']);
        const chave = texto(e['key']);
        if (sujeito === null || chave === null) continue;
        metadados.push({ sujeito, chave, valor: e['value'], tipo: texto(e['type']) });
      }
    }
  }
  return { nos, links, clientes, metadados };
}

/** O valor de um metadado que o PipeWire guarda como JSON em texto ou já decodificado. */
function nomeDoValor(valor: unknown): string | null {
  if (typeof valor === 'string') {
    try {
      const j: unknown = JSON.parse(valor);
      return ehRegistro(j) ? texto(j['name']) : null;
    } catch {
      return null;
    }
  }
  return ehRegistro(valor) ? texto(valor['name']) : null;
}

/** O nome do sink padrão (`default.audio.sink`), ou `null` se o gerenciador de sessão não o definiu. */
export function sinkPadrao(g: GrafoPw): string | null {
  const m = g.metadados.find((e) => e.sujeito === 0 && e.chave === 'default.audio.sink');
  return m === undefined ? null : nomeDoValor(m.valor);
}

/** A saída padrão como o Chromium a rotula: o nome do sink e a descrição legível. */
export function saidaPadrao(g: GrafoPw): { readonly nome: string; readonly descricao: string } | null {
  const nome = sinkPadrao(g);
  if (nome === null) return null;
  const no = g.nos.find((n) => n.classe === CLASSE_DE_SINK && n.nome === nome);
  return { nome, descricao: no?.descricao ?? nome };
}

/** Pid de um stream: o do próprio nó, senão o do cliente que o criou. */
function pidDoNo(g: GrafoPw, n: NoPw): number | null {
  if (n.pid !== null) return n.pid;
  return n.clienteId === null ? null : (g.clientes.get(n.clienteId)?.pid ?? null);
}

function nomeDoNo(g: GrafoPw, n: NoPw): string {
  const cliente = n.clienteId === null ? undefined : g.clientes.get(n.clienteId);
  return n.app ?? cliente?.app ?? n.binario ?? cliente?.binario ?? n.nome;
}

function binarioDoNo(g: GrafoPw, n: NoPw): string | null {
  const cliente = n.clienteId === null ? undefined : g.clientes.get(n.clienteId);
  return n.binario ?? cliente?.binario ?? null;
}

/**
 * A identidade de um app: o pid quando há, senão nome e binário. É o que
 * agrupa os vários streams de um jogo (música, efeitos, voz) num item só, e é
 * o que o renderer devolve ao escolher — o main confere contra uma listagem
 * NOVA antes de mover qualquer coisa.
 */
export function idDoApp(g: GrafoPw, n: NoPw): string {
  const pid = pidDoNo(g, n);
  return pid !== null ? `pid:${pid}` : `app:${nomeDoNo(g, n)}|${binarioDoNo(g, n) ?? ''}`;
}

/** Um `id` de app como o renderer pode mandar: forma conhecida e tamanho limitado. */
export function idDeAppValido(x: unknown): x is string {
  return typeof x === 'string' && /^(pid:\d{1,10}|app:[^\0]{1,200})$/.test(x);
}

/** O que não é "um app para escolher": o retorno do nosso sink e os próprios processos do Tela. */
const ehNomeNosso = (nome: string): boolean => nome.startsWith(PREFIXO_DO_SINK) || nome.startsWith(PREFIXO_DO_SISTEMA);

function ehNosso(n: NoPw, excluirPids: ReadonlySet<number>, pid: number | null): boolean {
  if (ehNomeNosso(n.nome)) return true;
  return pid !== null && excluirPids.has(pid);
}

/**
 * Os apps com stream de áudio, agrupados; quem toca agora primeiro, depois por
 * nome. Fora daqui: nosso retorno e os processos do próprio Tela (o áudio do
 * app não é o jogo).
 */
export function appsComSom(g: GrafoPw, excluirPids: ReadonlySet<number> = new Set()): readonly AppComSom[] {
  const grupos = new Map<string, { app: AppComSom; streams: number[]; tocando: boolean }>();
  for (const n of g.nos) {
    if (n.classe !== CLASSE_DE_STREAM) continue;
    const pid = pidDoNo(g, n);
    if (ehNosso(n, excluirPids, pid)) continue;
    const id = idDoApp(g, n);
    const existente = grupos.get(id);
    const tocando = n.estado === 'running';
    if (existente === undefined) {
      grupos.set(id, {
        app: { id, nome: nomeDoNo(g, n), binario: binarioDoNo(g, n), pid, tocando, streams: [n.id] },
        streams: [n.id],
        tocando,
      });
    } else {
      existente.streams.push(n.id);
      existente.tocando ||= tocando;
    }
  }
  return [...grupos.values()]
    .map((x) => ({ ...x.app, tocando: x.tocando, streams: x.streams }))
    .sort((a, b) => Number(b.tocando) - Number(a.tocando) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Os nós de stream de um app, agora — vazio se ele parou de tocar ou saiu. */
export function streamsDoApp(g: GrafoPw, appId: string, excluirPids: ReadonlySet<number> = new Set()): readonly number[] {
  return appsComSom(g, excluirPids).find((a) => a.id === appId)?.streams ?? [];
}

/**
 * O modo "sistema": os streams que vão para o sink do Tela — tudo que toca na
 * SAÍDA PADRÃO, menos a call (`ehVoz`), o próprio Tela e os nossos nós.
 *
 * - quem já está no nosso sink (`sinkNosso`) continua na conta: foi movido
 *   por nós, e sair dela seria devolvê-lo no meio da transmissão;
 * - quem ainda não está ligado a nada e não tem alvo fixado vai para a
 *   padrão de qualquer jeito, então entra;
 * - quem a pessoa mandou para OUTRA saída fica onde está: mover o levaria para
 *   a saída padrão no ouvido de quem joga. É a mesma fronteira do modo antigo,
 *   que capturava o monitor da saída padrão.
 */
export function streamsDoSistema(
  g: GrafoPw,
  sinkNosso: string,
  excluirPids: ReadonlySet<number>,
  ehVoz: (nome: string | null, binario: string | null) => boolean,
): readonly number[] {
  const padrao = sinkPadrao(g);
  const saida: number[] = [];
  for (const n of g.nos) {
    if (n.classe !== CLASSE_DE_STREAM) continue;
    if (ehNosso(n, excluirPids, pidDoNo(g, n))) continue;
    const cliente = n.clienteId === null ? undefined : g.clientes.get(n.clienteId);
    // O nome do nó ("WEBRTC VoiceEngine") e o do cliente ("Discord") contam os dois.
    if (ehVoz(n.app, binarioDoNo(g, n)) || ehVoz(cliente?.app ?? null, cliente?.binario ?? null)) continue;
    const onde = saidaAtual(g, n.id);
    if (onde === sinkNosso || (onde !== null && onde === padrao) || (onde === null && alvoFixado(g, n.id) === null)) saida.push(n.id);
  }
  return saida;
}

/** O sink onde o stream toca agora (pelos links), ou `null` se não está ligado a nenhum. */
export function saidaAtual(g: GrafoPw, streamId: number): string | null {
  for (const l of g.links) {
    if (l.saida !== streamId) continue;
    const destino = g.nos.find((n) => n.id === l.entrada);
    if (destino?.classe === CLASSE_DE_SINK) return destino.nome;
  }
  return null;
}

/**
 * O alvo que alguém já tinha fixado para o stream (`target.object`), com o tipo
 * original — restaurar é gravar de volta o mesmo par, ou apagar a chave se não
 * havia nada. Sem isto, devolver o app ao "padrão" desfaria a escolha manual
 * de quem rotulou o jogo para uma saída específica no pavucontrol.
 */
export function alvoFixado(g: GrafoPw, streamId: number): { readonly valor: string; readonly tipo: string } | null {
  const m = g.metadados.find((e) => e.sujeito === streamId && e.chave === 'target.object');
  if (m === undefined) return null;
  const valor = typeof m.valor === 'string' || typeof m.valor === 'number' ? String(m.valor) : null;
  return valor === null ? null : { valor, tipo: m.tipo ?? 'Spa:String' };
}

/** O nó do nosso sink, se existe agora. */
export function noDoSink(g: GrafoPw): NoPw | undefined {
  return g.nos.find((n) => n.classe === CLASSE_DE_SINK && n.nome === NOME_DO_SINK);
}

/** A fonte virtual `nome` existe e a captura dela (`captura`) está ligada a algo — pronta para a página capturar. */
export function entradaPronta(g: GrafoPw, nome: string, captura: string): boolean {
  const fonte = g.nos.find((n) => n.classe === CLASSE_DE_FONTE && n.nome === nome);
  const cap = g.nos.find((n) => n.nome === captura);
  return fonte !== undefined && cap !== undefined && g.links.some((l) => l.entrada === cap.id);
}

/**
 * O que ficou de uma execução anterior: os streams que ainda apontam para um
 * dos nossos sinks pelo metadado. Os PROCESSOS órfãos NÃO saem daqui (S-12): o pid de
 * um cliente é propriedade que ele mesmo declara, então nunca vira alvo de
 * sinal — ver `filhos-registrados.ts`.
 */
export function residuos(g: GrafoPw): { readonly streamsApontando: readonly number[] } {
  const nossos: readonly unknown[] = [NOME_DO_SINK, NOME_DO_SINK_DO_SISTEMA];
  const apontando = g.metadados
    .filter((e) => e.chave === 'target.object' && nossos.includes(e.valor) && e.sujeito !== 0)
    .map((e) => e.sujeito);
  return { streamsApontando: apontando };
}
