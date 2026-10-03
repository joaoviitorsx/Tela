import { z } from 'zod';
import { P2P_LIMITS } from './encoding.js';

/**
 * Protocolo de sinalização do mesh.
 *
 * O servidor que fala este protocolo NÃO vê mídia — ele repassa `payload`
 * opaco entre pares e nada mais. Kilobytes por sessão, contra gigabytes por
 * hora num SFU. É essa assimetria que torna a arquitetura de custo zero
 * possível (ADR 0005).
 *
 * REGRA R8: `payload` é opaco. O servidor não parseia SDP, não inspeciona
 * ICE, não guarda histórico. Se você se pegar dando um `z.object({ sdp })`
 * nele, parou de ser mesh — e o servidor virou parte do caminho da mídia.
 * Por isso o tipo aqui é `z.unknown()` e não algo mais específico: a
 * imprecisão é a especificação.
 *
 * Topologia: estrela com o transmissor no centro. Espectador só fala com o
 * transmissor, nunca com outro espectador.
 */

export const PeerIdSchema = z.string().min(1).max(64);

/**
 * Versão do protocolo (TELA-018). Cliente sem o campo é da versão 1, que não
 * conhece convite — e é recusado com `BAD_MESSAGE`, um código que ele entende.
 * Nunca se converte uma sala privada em aberta para aceitar cliente antigo.
 *
 * A 3 trouxe a aprovação manual (ADR 0025): quem fala 2 entraria sem pedir, e
 * por isso recebe `PROTOCOL_MISMATCH` — "recarregue" — em vez de passar.
 *
 * A 4 tirou o convite do link (ADR 0026): o link é só o nome do canal, e quem
 * decide quem entra é a aprovação. Abas abertas na 3 mandariam `set-invite`,
 * que não existe mais — recarregar é mais honesto que um erro no meio do ar.
 *
 * A 5 tornou a aprovação opcional por sala, desligada por padrão (ADR 0028):
 * quem tem o link entra direto. Aba na 4 pediria apelido e esperaria um
 * aceite que não vem mais.
 *
 * A `capacidade` do `host` (ADR 0029) NÃO subiu a versão: o campo é opcional,
 * os schemas não são estritos, e ausente vale `maxViewersSemUmEncode` (5) —
 * exatamente o teto que o cliente antigo conhecia. Aba na 5 e o app desktop
 * já instalado continuam iguais; só quem declara ganha as 50 vagas.
 *
 * A mensagem `capacidade` (ADR 0030) também não subiu: o servidor vai ao ar
 * ANTES dos clientes, e cliente antigo nunca a envia — então um servidor novo
 * entende todo cliente que existe, e nenhum cliente fala com servidor que não
 * entenda. Subir a versão expulsaria toda aba aberta por uma mensagem que ela
 * nem manda.
 */
export const PROTOCOL_VERSION = 5;

export type PeerId = z.infer<typeof PeerIdSchema>;

/**
 * Chave do navegador de quem assiste (ADR 0025): 128 bits em base64url.
 *
 * É o que faz "já aprovei esta pessoa" valer na volta. O transmissor nunca vê a
 * chave, só o sha256 dela (`fingerprint`), calculado PELO SERVIDOR — um cliente
 * que mandasse o próprio fingerprint poderia se passar por quem já foi aceito.
 */
export const ViewerKeySchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);

/**
 * Como o transmissor reconhece quem pede para entrar. Não é conta (R6): não
 * tem senha, não é único por si, e o servidor só o segura enquanto a conexão
 * existe.
 *
 * S-20: o apelido é o ÚNICO texto de terceiros que o transmissor lê, então é
 * normalizado aqui, no schema, e vale igual nos dois servidores e no cliente:
 *  - NFC: a mesma letra escrita de dois jeitos vira uma só;
 *  - sem controle nem formato (`\p{C}`): sai bidi (U+202E inverte o texto de
 *    quem lê) e zero-width (nome "vazio" ou idêntico a outro). Quebra de
 *    linha e tabulação (inclusive U+2028/9) viram ESPAÇO, para não colar
 *    palavras. Em vez de recusar, limpa: colar um nome com um lixo invisível
 *    não deve virar erro;
 *  - exceção: o ZWJ (U+200D), que cola emoji compostos (família, profissão).
 *    Fica só entre dois caracteres visíveis, nunca repetido nem nas pontas;
 *  - o teto conta GRAFEMAS (o que a pessoa vê), não unidades UTF-16: um emoji
 *    valia 2 e "👨‍👩‍👧" valia 8. Um segundo teto em code points impede o
 *    empilhamento de marcas combinantes (zalgo), que é 1 grafema e mil
 *    caracteres.
 */
export const APELIDO_MAX = 24;
/** Folga de 3 code points por grafema: cabe emoji composto, não cabe zalgo. */
export const APELIDO_MAX_CODEPOINTS = APELIDO_MAX * 3;

export function normalizarApelido(bruto: string): string {
  const semInvisiveis = bruto
    .normalize('NFC')
    // Quebra de linha e tabulação separam palavras: "Ana\nLima" é "Ana Lima", não "AnaLima".
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(/[\p{C}\u2028\u2029]/gu, (c) => (c === '\u200d' ? c : ''));
  const zwj = semInvisiveis
    .replace(/\u200d+/g, '\u200d')
    .replace(/(^|\s)\u200d|\u200d(\s|$)/g, '$1$2');
  return zwj.replace(/\s+/gu, ' ').trim();
}

export function tamanhoDoApelido(nome: string): { grafemas: number; codePoints: number } {
  const codePoints = [...nome].length;
  // Sem Segmenter (runtime muito antigo) cai em code points: pior só para emoji.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter === 'undefined') {
    return { grafemas: codePoints, codePoints };
  }
  const grafemas = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(nome)].length;
  return { grafemas, codePoints };
}

export const ApelidoSchema = z
  .string()
  .max(512) // antes de normalizar: não gastar CPU em lixo gigante
  .transform(normalizarApelido)
  .pipe(
    z
      .string()
      .min(1)
      .refine((nome) => {
        const t = tamanhoDoApelido(nome);
        return t.grafemas <= APELIDO_MAX && t.codePoints <= APELIDO_MAX_CODEPOINTS;
      }),
  );

/**
 * Apelido que ainda não está em uso na sala (S-20, fluxo de aprovação).
 *
 * Sem unicidade, quem entra como "Maria" quando já há uma "Maria" aprovada se
 * passa por ela diante do dono. Não dá para recusar (código novo de erro
 * quebraria todo `Record<AppError, …>` e abas abertas): o servidor acrescenta
 * " (2)", " (3)"... e o transmissor vê dois nomes diferentes. A comparação
 * ignora caixa e compatibilidade Unicode (NFKC: "ＭＡＲＩＡ" = "maria"); NÃO
 * pega homóglifos entre alfabetos (cirílico "а" x latino "a") — isso exigiria
 * tabela de confundíveis, e o transmissor já vê a impressão digital.
 */
export function apelidoUnico(nome: string, ocupados: Iterable<string>): string {
  const chave = (n: string) => n.normalize('NFKC').toLocaleLowerCase('en-US');
  const usados = new Set([...ocupados].map(chave));
  if (!usados.has(chave(nome))) return nome;
  for (let n = 2; n < 1000; n += 1) {
    const sufixo = ` (${n})`;
    // Corta o nome (por grafema) para o sufixo caber no teto.
    const base = [...nome].slice(0, Math.max(1, APELIDO_MAX - sufixo.length)).join('');
    const candidato = `${base}${sufixo}`;
    if (!usados.has(chave(candidato))) return candidato;
  }
  return nome;
}

export const SignalingErrorCodeSchema = z.enum([
  'SLUG_TAKEN', // já existe transmissão nesse slug, de outro dono
  'SLUG_INVALID',
  'NOT_HOSTING', // ninguém transmitindo nesse slug
  'CHANNEL_FULL', // MAX_PEERS atingido
  'RATE_LIMITED',
  'OWNER_INVALID',
  'BAD_MESSAGE',
  /** Cliente e servidor falam versões diferentes: recarregar resolve. */
  'PROTOCOL_MISMATCH',
  /** O transmissor tirou este espectador. Não tentar de novo sozinho. */
  'REMOVED',
  /** O transmissor recusou o pedido. Pedir de novo é escolha da pessoa. */
  'DENIED',
  'HELLO_TIMEOUT', // conectou e não se apresentou
  /**
   * O canal nem chegou a abrir.
   *
   * Nunca vem do servidor — é o cliente reportando que não conseguiu falar
   * com ele. Existe porque tratar isso como `NOT_HOSTING` transformava todo
   * problema de rede, proxy ou bloqueio de navegador em "ninguém está
   * transmitindo", e o usuário ficava esperando por uma transmissão que
   * estava no ar o tempo todo.
   */
  'SIGNAL_UNREACHABLE',
]);
export type SignalingErrorCode = z.infer<typeof SignalingErrorCodeSchema>;

export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServerConfig = z.infer<typeof IceServerSchema>;
export const RelayStatusSchema = z.enum(['available', 'not-configured', 'unavailable']);
export type RelayStatus = z.infer<typeof RelayStatusSchema>;

/* ───────────────────── cliente → servidor ───────────────────── */

export const ClientMessageSchema = z.discriminatedUnion('type', [
  /** Reivindica o canal. O ownerToken é comparado, nunca logado nem devolvido. */
  z.object({
    type: z.literal('host'),
    /** Ausente = cliente da versão 1. */
    protocol: z.number().int().min(1).max(1000).optional(),
    slug: z.string().min(1).max(64),
    ownerToken: z.string().min(43).max(256),
    /**
     * Aprovar cada espectador (ADR 0025). Ausente = sala aberta: quem tem o
     * link entra direto (ADR 0028). O dono decide ao reivindicar.
     */
    approval: z.boolean().optional(),
    /**
     * Quantos espectadores ESTE transmissor aguenta (ADR 0029). O teto do
     * servidor é o do produto; o do canal é o menor dos dois, e é ele que
     * volta em `hosting.maxPeers`. Quem codifica uma vez por espectador
     * declara `P2P_LIMITS.maxViewersSemUmEncode`; quem tem um encode e N
     * envios declara `P2P_LIMITS.maxViewers`. Ausente = teto do servidor.
     */
    capacidade: z.number().int().min(1).max(P2P_LIMITS.maxViewers).optional(),
  }),
  z.object({
    type: z.literal('watch'), slug: z.string().min(1).max(64),
    protocol: z.number().int().min(1).max(1000).optional(),
    /** Identidade efêmera de alta entropia; quem a conhece pode retomar a vaga. */
    participantId: z.string().min(16).max(128).optional(),
    /** Nova PC = nova tentativa; reconexão apenas do socket preserva este ID. */
    attemptId: z.string().min(16).max(128).optional(),
    /** Exigidos só em sala com aprovação (ADR 0025/0028); quem exige é o servidor. */
    name: ApelidoSchema.optional(),
    viewerKey: ViewerKeySchema.optional(),
  }),
  /**
   * Só o transmissor: responde a um `join-request`. `admit` segue a entrada
   * normal (vaga, credencial, `watching`); `deny` fecha com `DENIED`.
   */
  z.object({ type: z.literal('admit'), peerId: PeerIdSchema }),
  z.object({ type: z.literal('deny'), peerId: PeerIdSchema }),
  /**
   * Só o transmissor: quantos espectadores o link dele paga AGORA (ADR 0030).
   *
   * A `capacidade` do `host` é o que a máquina codifica; esta é o que a banda
   * carrega, e muda ao longo da transmissão. O teto do canal passa a ser o
   * menor dos três — servidor, máquina, banda. Baixar nunca expulsa ninguém:
   * quem já está fica, e só a próxima pessoa recebe `CHANNEL_FULL`.
   */
  z.object({ type: z.literal('capacidade'), valor: z.number().int().min(1).max(P2P_LIMITS.maxViewers) }),
  z.object({ type: z.literal('refresh-ice'), requestId: z.string().min(1).max(64) }),
  /**
   * Só o transmissor: tira um espectador, ou todos sem `peerId`. Não é
   * banimento: quem sai pode pedir de novo, e o dono decide de novo.
   */
  z.object({ type: z.literal('remove-viewers'), peerId: PeerIdSchema.optional() }),
  /** `to` opcional: espectador só tem um destino possível, o transmissor. */
  z.object({
    type: z.literal('signal'),
    to: PeerIdSchema.optional(),
    payload: z.unknown(),
  }),
  z.object({ type: z.literal('leave') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ───────────────────── servidor → cliente ───────────────────── */

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hosting'),
    peerId: PeerIdSchema,
    /**
     * Credencial de TURN. Nunca vai no bundle do front: quem a entrega é o
     * servidor, no momento em que ela é necessária, com validade curta —
     * exceto a senha FIXA de plano grátis, aceita só com `TURN_ESTATICO`
     * (ADR 0036), que não vence e por isso vem sem `expiresAt`.
     */
    iceServers: z.array(IceServerSchema),
    /** Estado público; a causa detalhada permanece apenas no servidor. */
    relayStatus: RelayStatusSchema.optional(),
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    maxPeers: z.number().int().min(1),
  }),
  z.object({
    type: z.literal('watching'),
    peerId: PeerIdSchema,
    hostId: PeerIdSchema,
    iceServers: z.array(IceServerSchema),
    relayStatus: RelayStatusSchema.optional(),
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    /** Valor inicial; depois disso, mensagens `viewers` mantêm atualizado. */
    viewers: z.number().int().min(1),
  }),
  /**
   * Quantos estão assistindo AGORA, mandado a quem assiste.
   *
   * Contagem e não lista: o espectador quer saber se está sozinho ou se a
   * galera chegou, e não tem por que receber o identificador dos outros. O
   * transmissor continua recebendo `peer-joined`/`peer-left`, porque ele
   * precisa dos ids para negociar mídia com cada um.
   */
  z.object({ type: z.literal('viewers'), count: z.number().int().min(0) }),
  z.object({
    type: z.literal('ice-servers'), requestId: z.string().min(1).max(64),
    iceServers: z.array(IceServerSchema), relayStatus: RelayStatusSchema,
    issuedAt: z.number().int().nonnegative().optional(),
    expiresAt: z.number().int().nonnegative().optional(),
  }),
  /**
   * Para o espectador: pedido na mão do transmissor. Nada de vaga nem
   * credencial TURN ainda — isso só depois do `admit` (ADR 0025).
   */
  z.object({ type: z.literal('awaiting-approval') }),
  /**
   * Para o transmissor: alguém pede para entrar. `peerId` é o que
   * ele terá ao entrar; `fingerprint` é o sha256 da chave do navegador dele.
   */
  z.object({
    type: z.literal('join-request'),
    peerId: PeerIdSchema,
    name: ApelidoSchema,
    fingerprint: z.string().min(16).max(128),
  }),
  /** Para o transmissor: o pedido sumiu (a pessoa desistiu ou caiu). */
  z.object({ type: z.literal('join-cancelled'), peerId: PeerIdSchema }),
  z.object({
    type: z.literal('peer-joined'),
    peerId: PeerIdSchema,
    attemptId: z.string().optional(),
    /** Quem é, para a lista do transmissor sobreviver a um F5 dele. */
    name: ApelidoSchema.optional(),
    fingerprint: z.string().min(16).max(128).optional(),
  }),
  z.object({ type: z.literal('peer-left'), peerId: PeerIdSchema }),
  z.object({ type: z.literal('signal'), from: PeerIdSchema, payload: z.unknown() }),
  z.object({
    type: z.literal('error'),
    code: SignalingErrorCodeSchema,
    /**
     * Só em `CHANNEL_FULL`: o teto REAL do canal, que é o do transmissor e não
     * o do servidor. Sem ele a tela de "sem vaga" só poderia mostrar o número
     * do produto — e "sem vaga · 50" numa sala de cinco é mentira.
     */
    maxPeers: z.number().int().min(1).optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ───────────────────── limites do protocolo ───────────────────── */

/** Cliente tem este tempo para mandar `host` ou `watch` antes do socket cair. */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * Keepalive. O ping parte do SERVIDOR — o browser responde pong sozinho, sem
 * que a página precise fazer nada. JavaScript não consegue enviar frame de
 * ping, então a direção oposta exigiria uma mensagem de aplicação inútil.
 */
export const SIGNAL_PING_INTERVAL_MS = 30_000;

/** Frame acima disso derruba a conexão. SDP grande é legítimo; megabyte não é. */
export const MAX_FRAME_BYTES = 64 * 1024;
