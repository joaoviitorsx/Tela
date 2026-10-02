import { P2P_LIMITS } from '@tela/shared';

/**
 * Limites do servidor de sinalização. Todos em um lugar, todos configuráveis
 * por env, todos com um motivo escrito.
 */
export type Limits = {
  /**
   * Teto de espectadores por canal que ESTE servidor aceita. O transmissor
   * declara a própria `capacidade` ao reivindicar; o teto do canal é o menor
   * dos dois (ADR 0029).
   */
  readonly maxPeers: number;
  /** Mensagens por conexão de ESPECTADOR, por janela. */
  readonly messageLimit: number;
  /** Mensagens por conexão de TRANSMISSOR, por janela: ele fala com todos. */
  readonly hostMessageLimit: number;
  readonly messageWindowMs: number;
  /** Tentativas de `host` por IP, por janela. Barra squatting em massa. */
  readonly hostLimit: number;
  readonly hostWindowMs: number;
  /**
   * Aberturas de WebSocket por IP, por janela (TELA-019). Generoso de
   * propósito: um grupo inteiro atrás do mesmo CGNAT, com reconexões, cabe
   * folgado. O que ele barra é um cliente abrindo sockets em laço.
   */
  readonly openLimit: number;
  readonly openWindowMs: number;
  /**
   * Pedidos esperando o transmissor responder, por canal (ADR 0025). Sem teto,
   * quem tem o link enche a fila dele de pedidos e esconde os amigos de verdade.
   */
  readonly maxPending: number;
  /**
   * S-01: reivindicações FALHAS (token de dono errado) por IP, por janela. Só
   * estas contam; quem chega com o token certo nunca passa por aqui.
   */
  readonly falhaHostLimit: number;
  /** S-01: o mesmo, por slug (um atacante com muitos IPs contra UM alvo). */
  readonly falhaHostSlugLimit: number;
  /** S-01/S-02: slugs NOVOS reivindicados por IP numa janela longa (squatting). */
  readonly slugsNovosPorHoraLimit: number;
  readonly slugsNovosJanelaMs: number;
  /** S-02: entradas de espectador (cada uma emite TURN) por IP, por janela. */
  readonly watchIpLimit: number;
  readonly watchIpWindowMs: number;
  /** S-02: `refresh-ice` por conexão e por IP, na mesma janela longa. */
  readonly refreshIceSocketLimit: number;
  readonly refreshIceIpLimit: number;
  readonly refreshIceWindowMs: number;
  /** S-07: espectadores simultâneos de UM canal vindos do mesmo IP. */
  readonly viewersPorIp: number;
  /** S-07: maior frame `signal` que um ESPECTADOR manda ao host, em bytes. */
  readonly viewerSignalMaxBytes: number;
  /** S-07: bytes de `signal` que um espectador manda ao host por `messageWindowMs`. */
  readonly viewerSignalBytesPorJanela: number;
};

export const DEFAULT_LIMITS: Limits = {
  /**
   * O teto do produto, não um número próprio: `MAX_PEERS` no ambiente pode
   * baixar, nunca passar disto. Mantido no mesmo lugar que o front lê para os
   * dois não divergirem de novo — já aconteceu, com o `wrangler.toml` preso em
   * 3 enquanto o front prometia 5.
   */
  maxPeers: P2P_LIMITS.maxViewers,

  /**
   * Teto de mensagens por conexão de espectador, por janela.
   *
   * Era 30 por 10s e derrubava o caso de uso CENTRAL do produto: colar o link
   * no Discord e três amigos clicarem ao mesmo tempo. Cada espectador custa ao
   * transmissor uma oferta mais um candidato ICE por vez — medido em 11
   * mensagens num ambiente isolado, onde só existem candidatos de host. Em
   * rede real, com STUN e TURN, cada peer gera candidatos para IPv4 e IPv6,
   * UDP e TCP, e o número sobe muito. Três entradas simultâneas estouravam o
   * teto e o servidor FECHAVA o socket do transmissor no meio da negociação.
   *
   * A troca de ICE é inerentemente em rajada: qualquer teto pensado para
   * tráfego constante está errado aqui. 240 por 10s ainda limita um abusador
   * a 24 mensagens por segundo sustentadas, e deixa folga de uma ordem de
   * grandeza para o uso legítimo de UM espectador, que só fala com um peer.
   */
  messageLimit: 240,
  /**
   * O transmissor fala com TODOS, e a rajada dele escala com o teto.
   *
   * Os 240 foram dimensionados para cinco vagas (48 por vaga); com cinquenta
   * o mesmo teto fecharia o socket do transmissor no pior momento possível —
   * o F5 dele, que reoferta para a plateia inteira de uma vez: 50 peers × ~15
   * mensagens de ICE em rede real são 750 numa janela. 48 por vaga × 50
   * vagas = 2.400, com 3× de folga para esse caso. Dimensionado pelo teto do
   * PRODUTO, não pelo configurado: um `MAX_PEERS` menor só o deixa folgado.
   */
  hostMessageLimit: 48 * P2P_LIMITS.maxViewers,
  messageWindowMs: 10_000,

  /**
   * Tentativas de `host` por IP.
   *
   * Sobe de 5 para 20: atrás de CGNAT vários usuários compartilham o mesmo IP,
   * e cinco recarregamentos de página trancavam a pessoa fora do próprio
   * canal. Continua barrando quem tenta reservar centenas de slugs.
   */
  hostLimit: 20,
  hostWindowMs: 60_000,

  /**
   * 120 por minuto era 24× a plateia de cinco. Com cinquenta, uma operadora
   * brasileira com CGNAT pode pôr boa parte da sala atrás de UM IP, e uma
   * piscada de rede faz todos reconectarem juntos. 600 ainda é 10 por segundo
   * sustentado — o laço de sockets que isto existe para barrar faz centenas.
   */
  openLimit: 600,
  openWindowMs: 60_000,

  /**
   * Era 8, para uma sala de 5. Com 50 vagas, oito pedidos em espera deixam o
   * nono amigo de fora com `RATE_LIMITED` antes de o dono ver a fila. Tantos
   * pedidos quantas vagas: mais que isso continua sendo gente escondendo os
   * amigos de verdade.
   */
  maxPending: P2P_LIMITS.maxViewers,

  /*
    S-01. Falha de dono é rara na vida real (token errado só acontece com
    cliente quebrado ou ataque), então 20/min por IP é folgado e barra quem
    adivinha. O token é de 256 bits: o limite não existe para impedir adivinhar,
    existe para a tentativa não custar hash, storage e ruído de graça.
  */
  falhaHostLimit: 20,
  falhaHostSlugLimit: 20,
  /*
    60 slugs NOVOS por hora por IP: quem transmite cria um canal por vez e
    reaproveita o seu; um grupo atrás de CGNAT, mesmo grande, não passa de
    dezenas por hora. Complementa o `hostLimit` (rajada) com o freio do
    acúmulo lento: sem ele, 20/min ainda seriam 28 mil slugs por dia.
  */
  slugsNovosPorHoraLimit: 60,
  slugsNovosJanelaMs: 3_600_000,

  /*
    S-02. 120 entradas por minuto por IP: 50 amigos atrás de um CGNAT
    entrando juntos, mais reconexões em massa, cabem; um script que gasta TURN
    em laço (cada entrada é um POST pago) não.
  */
  watchIpLimit: 120,
  watchIpWindowMs: 60_000,
  /*
    A credencial vale 10 min e o cliente renova uma vez por ciclo; 6 em 10 min
    é 3× o necessário por conexão. Por IP, 120 em 10 min cobre os 50 amigos
    do mesmo CGNAT com folga. Medido antes: UM socket emitia 230.
  */
  refreshIceSocketLimit: 6,
  refreshIceIpLimit: 120,
  refreshIceWindowMs: 600_000,

  /*
    S-07. 3 por IP e canal: uma casa (PC + celular + TV) ou um casal cabe;
    uma família grande atrás do mesmo IPv4 de CGNAT corre risco, mas o dono
    pode ligar a aprovação (ADR 0025) e o limite vale só para a SALA ABERTA
    e para pedidos pendentes — quem o dono admite à mão não é cortado. É o
    freio contra UM script ocupando as 50 vagas; contra botnet só a
    aprovação resolve, e isso está documentado na revisão.
  */
  viewersPorIp: 3,
  /*
    Estimativa, não medição em navegador real (ver relatório): a resposta SDP
    de um espectador recvonly de vídeo+áudio tem 1–3 KB e cada candidato ICE
    ~0,3 KB. 16 KB por frame deixa 5× de folga para o SDP e é 4× menor que os
    64 KB de antes. Por janela de 10 s, 192 KB comportam ~12 SDPs ou ~600
    candidatos: um ICE restart inteiro, nunca um laço. No pior caso, 50
    espectadores somam ~1 MB/s ao host (eram 77 MB/s).
  */
  viewerSignalMaxBytes: 16 * 1024,
  viewerSignalBytesPorJanela: 192 * 1024,
};

/**
 * Balde de fichas por janela fixa, em memória.
 *
 * A varredura é preguiçosa e no máximo uma por janela: só o teto de tamanho
 * faria a limpeza O(n) rodar em toda mensagem sob carga, que é exatamente
 * quando ela não pode custar nada.
 */
export class RateBuckets {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweepAt = 0;

  constructor(
    private readonly now: () => number,
    private readonly sweepThreshold = 10_000,
    private readonly sweepIntervalMs = 60_000,
  ) {}

  /** `true` quando a ação é permitida. */
  take(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    this.sweep(now);

    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  private sweep(now: number): void {
    if (this.buckets.size < this.sweepThreshold) return;
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

const codificador = new TextEncoder();

/** Tamanho em BYTES de um frame de texto (`length` conta unidades UTF-16 e subestima até 3×). */
export function bytesDe(raw: string): number {
  return codificador.encode(raw).length;
}
