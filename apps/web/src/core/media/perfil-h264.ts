/**
 * O perfil H.264 do codificador único segue o que a SALA aceita (adendo à
 * ADR 0016).
 *
 * O SDP de cada espectador já negocia Main (`profile-level-id=4d…`): o
 * `ordenarH264` prefere Main a Baseline desde a ADR 0016. Mas o caminho "um
 * encode, N envios" (ADR 0029) codificava fixo em Constrained Baseline — o
 * receptor aceitava CABAC e recebia CAVLC. Main é a mesma aceleração com um
 * codificador de entropia melhor: ~10% menos bits pela mesma imagem (medido
 * no NVENC, `docs/engenharia/estudo/1-codec.md`), sem custo de GPU.
 *
 * O quadro é UM para todos (R5): o perfil é o piso da sala. Main só quando
 * TODOS os espectadores negociaram Main ou High; basta um só-Baseline (o
 * Firefox oferece só `42e01f`) para a sala inteira ficar em Baseline. Com a
 * cascata ligada também — o anfitrião não vê o que os filhos dos
 * repassadores negociaram.
 */
export type PerfilH264 = 'baseline' | 'main';

/** O perfil que um `sdpFmtpLine` negociado aceita, ou `null` se não diz. */
export function perfilDoFmtp(fmtp: string | null | undefined): 'baseline' | 'main' | 'high' | null {
  const plid = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})/i.exec(fmtp ?? '')?.[1];
  if (plid === undefined) return null;
  const idc = plid.slice(0, 2).toLowerCase();
  if (idc === '4d') return 'main';
  if (idc === '64') return 'high';
  return 'baseline';
}

/**
 * O piso da sala. `null` = ninguém assistindo: não há o que decidir, e quem
 * chama mantém o que tinha (sem trocar de perfil — e soltar IDR — à toa).
 */
export function perfilDaSala(fmtps: readonly (string | null | undefined)[], cascataAtiva: boolean): PerfilH264 | null {
  // A cascata vem primeiro: ligada, é Baseline mesmo sem ninguém negociado ainda.
  if (cascataAtiva) return 'baseline';
  if (fmtps.length === 0) return null;
  return fmtps.every((f) => {
    const p = perfilDoFmtp(f);
    return p === 'main' || p === 'high';
  })
    ? 'main'
    : 'baseline';
}

/**
 * A string do WebCodecs. Main e não High: High não acrescentou nada medível
 * (+0,01 dB) e Main sem B-frames cabe em qualquer decoder que aceite High.
 * Nível 4.2 nos dois: cobre 1080p60.
 */
export function codecDoPerfil(p: PerfilH264): string {
  return p === 'main' ? 'avc1.4d002a' : 'avc1.42e02a';
}

/**
 * O `profile_idc` do SPS de um quadro Annex B, ou `null` sem SPS. É o perfil
 * EMITIDO — o que o encoder fez de fato, que pode não ser o pedido (o
 * OpenH264 ignora o perfil e sempre faz Baseline). Varre só até o primeiro
 * SPS: O(tamanho do cabeçalho), e só em quadro-chave.
 */
export function perfilDoSps(bytes: Uint8Array): number | null {
  for (let i = 0; i + 4 < bytes.length; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const tres = bytes[i + 2] === 1;
    const quatro = bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!tres && !quatro) continue;
    const inicio = i + (tres ? 3 : 4);
    const cabecalho = bytes[inicio];
    if (cabecalho === undefined) return null;
    if ((cabecalho & 0x1f) === 7) return bytes[inicio + 1] ?? null;
    i = inicio;
  }
  return null;
}

/** Para o console: o que o `profile_idc` quer dizer. */
export function nomeDoPerfilIdc(idc: number | null): string | null {
  if (idc === null) return null;
  if (idc === 66) return 'Baseline';
  if (idc === 77) return 'Main';
  if (idc === 100) return 'High';
  return `perfil ${idc}`;
}

/** Tipos de NAL que importam aqui (H.264 §7.4.1.2.3). */
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** Onde começa cada NAL de um quadro Annex B, até o primeiro de imagem (1–5). */
function cabecalhosAnnexB(bytes: Uint8Array): Array<{ inicio: number; dados: number; tipo: number }> {
  const nals: Array<{ inicio: number; dados: number; tipo: number }> = [];
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const tres = bytes[i + 2] === 1;
    const quatro = bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!tres && !quatro) continue;
    const dados = i + (tres ? 3 : 4);
    const cabecalho = bytes[dados];
    if (cabecalho === undefined) break;
    const tipo = cabecalho & 0x1f;
    nals.push({ inicio: i, dados, tipo });
    // A fatia de imagem vai até o fim do quadro: depois dela não há cabeçalho a ler.
    if (tipo >= 1 && tipo <= 5) break;
    i = dados;
  }
  return nals;
}

/**
 * Todo quadro-chave H.264 sai com SPS e PPS — mesmo que o encoder não os mande.
 *
 * O encoder de hardware (Media Foundation no Windows, e outros) manda SPS/PPS
 * só no primeiro IDR depois de abrir ou de mudar de tamanho; os quadros-chave
 * pedidos depois vêm sem eles. Quem já assistia guardou os parâmetros e segue
 * decodificando; quem entra ou reconecta depois NUNCA decodifica nada: recebe
 * bytes, pede quadro-chave sem parar e fica com a tela preta e o som tocando
 * (relato de 04/10). No caminho normal do WebRTC o próprio encoder do sender
 * cuida disso; no "um encode" (ADR 0029) o quadro é injetado, e cuidar é nosso.
 *
 * Guarda o SPS/PPS do último quadro-chave que os trouxe e os põe na frente de
 * quem chegou sem — depois do AUD, se houver, que tem de abrir a unidade.
 * Lê só os cabeçalhos antes da primeira fatia: O(cabeçalho), e só em quadro-chave.
 */
export class ParametrosH264 {
  private guardados: Uint8Array | null = null;

  /** O quadro-chave, com SPS/PPS garantidos quando já houve algum. */
  completar(quadro: Uint8Array): Uint8Array {
    const nals = cabecalhosAnnexB(quadro);
    const parametros = nals.filter((n) => n.tipo === NAL_SPS || n.tipo === NAL_PPS);
    if (parametros.some((n) => n.tipo === NAL_SPS)) {
      const partes = parametros.map((n) => {
        const proximo = nals[nals.indexOf(n) + 1];
        return quadro.subarray(n.inicio, proximo?.inicio ?? quadro.length);
      });
      const juntos = new Uint8Array(partes.reduce((total, p) => total + p.length, 0));
      let pos = 0;
      for (const p of partes) {
        juntos.set(p, pos);
        pos += p.length;
      }
      this.guardados = juntos;
      return quadro;
    }
    if (this.guardados === null) return quadro;
    const aud = nals[0]?.tipo === NAL_AUD ? nals[0] : undefined;
    const corte = aud === undefined ? 0 : (nals[1]?.inicio ?? quadro.length);
    const saida = new Uint8Array(quadro.length + this.guardados.length);
    saida.set(quadro.subarray(0, corte), 0);
    saida.set(this.guardados, corte);
    saida.set(quadro.subarray(corte), corte + this.guardados.length);
    return saida;
  }

  /** Troca de codec: parâmetros de H.264 não servem a AV1, nem o contrário. */
  esquecer(): void {
    this.guardados = null;
  }
}
