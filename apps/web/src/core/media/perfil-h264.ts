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
  if (fmtps.length === 0) return null;
  if (cascataAtiva) return 'baseline';
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
