/**
 * Rodízio de leitura de `getStats()` do transmissor (complexidade.md, B2).
 *
 * # O problema
 *
 * Uma leitura por peer por segundo é O(N) chamadas, cada uma serializando
 * dezenas de objetos dentro do Chromium — na máquina que está com o jogo
 * aberto. A 50 espectadores são 50 relatórios por segundo, para estimar uma
 * coisa que o encoder único (R5) torna quase igual em todos os caminhos.
 *
 * # A regra
 *
 * Até `PEERS_SEM_RODIZIO` peers, nada muda: lê todo mundo, todo tique. Acima
 * disso o período R cresce com N (`periodoDoRodizio`) e cada tique lê os
 * ⌈N/R⌉ peers com a leitura mais antiga — um orçamento quase constante de
 * `PEERS_POR_TIQUE` leituras por segundo, não importa o tamanho da sala. A
 * leitura mais recente de cada peer é RETIDA e reentregue aos consumidores.
 *
 * # Quem NUNCA espera a vez
 *
 * A detecção de colapso não pode ficar R vezes mais lenta justamente para
 * quem está em apuros (R5: perder resolução cedo, nunca framerate). Lê-se todo
 * tique, além da cota:
 *
 * - quem ainda não tem leitura, ou está no aquecimento por caminho (ADR 0030:
 *   contado em LEITURAS reais, não em tiques — a retida não é amostra nova);
 * - quem na última leitura mostrava `qualityLimitationReason` diferente de
 *   `none` ou perda de pacotes.
 *
 * A estimativa de banda por si só (sem limitação nem perda) pode cair entre
 * duas leituras e só aparece na vez do peer: no pior caso, R tiques depois.
 * É o preço do rodízio, medido em `e2e/malhas.sim.mjs`.
 */

/** Salas até este tamanho leem todo peer todo tique: sem mudança de comportamento. */
export const PEERS_SEM_RODIZIO = 5;

/** Orçamento de leituras por tique acima de `PEERS_SEM_RODIZIO` (≈ o que 5 espectadores já pagam hoje). */
export const PEERS_POR_TIQUE = 5;

/** Nenhum peer espera mais que isto entre duas leituras. */
export const PERIODO_MAXIMO = 6;

/**
 * O mesmo número de `AQUECIMENTO_POR_CAMINHO` (core/media/uplink-governor.ts).
 * Duplicado de propósito: `core/mesh` não importa `core/media`. Um teste
 * garante que os dois não se afastem.
 */
export const LEITURAS_DE_AQUECIMENTO = 8;

/**
 * Quantos dos caminhos MAIS FRACOS (menor estimativa na última leitura) leem
 * todo tique. O governador decide pelo MÍNIMO dos caminhos (R5: o pior manda),
 * então o que decide a sala é justamente quem está perto do fundo — e esse é
 * o último que se pode deixar esperando R tiques. Medido no simulador: sem
 * isto, salas com um espectador fraco passavam mais de 10 % do tempo pedindo
 * mais do que o link tinha.
 */
export const PIORES_CAMINHOS = 3;

/** Perda a partir da qual o peer deixa de esperar a vez. */
const PERDA_URGENTE = 0.01;

/** R: de quantos em quantos tiques cada peer é lido (1 = sem rodízio). */
export function periodoDoRodizio(peers: number): number {
  if (peers <= PEERS_SEM_RODIZIO) return 1;
  return Math.min(PERIODO_MAXIMO, Math.ceil(peers / PEERS_POR_TIQUE));
}

/**
 * O que o relatório diz do caminho: está em apuros? Já tem par ICE medindo?
 * Só lê campos que as malhas já leem.
 *
 * `medido` espelha a condição com que o `StatsSampler` conta amostras do
 * caminho (par nominado com estimativa): um relatório vazio de peer que ainda
 * conecta não pode gastar o aquecimento.
 */
export function examinar(report: RTCStatsReport): { apuro: boolean; medido: boolean; banda: number } {
  let apuro = false;
  let medido = false;
  let banda = 0;
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    const tipo = stat['type'];
    if (tipo === 'outbound-rtp' && stat['kind'] === 'video') {
      const motivo = stat['qualityLimitationReason'];
      if (typeof motivo === 'string' && motivo !== 'none') apuro = true;
    } else if (tipo === 'remote-inbound-rtp' && stat['kind'] === 'video') {
      if (Number(stat['fractionLost'] ?? 0) >= PERDA_URGENTE) apuro = true;
    } else if (
      tipo === 'candidate-pair' && stat['state'] === 'succeeded' && stat['nominated'] !== false &&
      Number(stat['availableOutgoingBitrate'] ?? 0) > 0
    ) {
      medido = true;
      banda = Math.max(banda, Number(stat['availableOutgoingBitrate']));
    }
  });
  return { apuro, medido, banda };
}

type Estado = {
  /** Tiques desde a última leitura real; `Infinity` = nunca foi lido. */
  espera: number;
  leituras: number;
  apuro: boolean;
  /** Estimativa de banda da última leitura; `Infinity` = ainda sem. */
  banda: number;
};

export class RodizioDeLeitura {
  private readonly peers = new Map<string, Estado>();

  /** Decide quem lê neste tique. Chamar uma vez por tique, com os peers vivos. */
  escolher(ids: readonly string[]): ReadonlySet<string> {
    const vivos = new Set(ids);
    for (const id of [...this.peers.keys()]) if (!vivos.has(id)) this.peers.delete(id);
    for (const id of ids) {
      const estado = this.peers.get(id);
      if (estado === undefined) this.peers.set(id, { espera: Number.POSITIVE_INFINITY, leituras: 0, apuro: false, banda: Number.POSITIVE_INFINITY });
      else estado.espera += 1;
    }

    const periodo = periodoDoRodizio(ids.length);
    if (periodo === 1) return new Set(ids);

    const escolhidos = new Set<string>();
    for (const id of ids) {
      const e = this.peers.get(id)!;
      // `espera >= periodo` garante o piso de "ao menos a cada R tiques" mesmo
      // quando gente entra e sai e a cota deslizaria.
      if (e.apuro || e.leituras <= LEITURAS_DE_AQUECIMENTO || e.espera >= periodo) escolhidos.add(id);
    }
    // Quem está no fundo da fila decide a sala: não espera a vez.
    const fundo = [...ids]
      .filter((id) => Number.isFinite(this.peers.get(id)!.banda))
      .sort((a, b) => this.peers.get(a)!.banda - this.peers.get(b)!.banda)
      .slice(0, PIORES_CAMINHOS);
    for (const id of fundo) escolhidos.add(id);
    // A cota do rodízio: os mais antigos primeiro. Empate pela ordem de entrada.
    const cota = Math.ceil(ids.length / periodo);
    const porIdade = ids
      .filter((id) => !escolhidos.has(id))
      .sort((a, b) => this.peers.get(b)!.espera - this.peers.get(a)!.espera);
    for (const id of porIdade) {
      if (escolhidos.size >= Math.max(cota, 1)) break;
      escolhidos.add(id);
    }
    return escolhidos;
  }

  /** Uma leitura real chegou. */
  registrar(id: string, report: RTCStatsReport): void {
    const estado = this.peers.get(id);
    if (estado === undefined) return;
    const { apuro, medido, banda } = examinar(report);
    estado.espera = 0;
    if (medido) {
      estado.leituras += 1;
      estado.banda = banda;
    }
    estado.apuro = apuro;
  }

  esquecer(id: string): void {
    this.peers.delete(id);
  }
}
