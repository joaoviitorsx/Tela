/**
 * Ajustes cirúrgicos no SDP que CHEGA, antes de `setRemoteDescription`.
 *
 * # Por que na descrição REMOTA, e não na local
 *
 * Os dois parâmetros aqui são declarações do RECEPTOR sobre o que ele aceita,
 * e é o transmissor que as obedece. `profile-level-id` diz até onde o decoder
 * do outro lado vai; `x-google-start-bitrate` diz por onde o encoder deve
 * começar. Nos dois casos o valor útil está no SDP que recebemos, não no que
 * mandamos.
 *
 * Mexer na descrição LOCAL seria pior de duas formas: o Chromium já recusa
 * várias formas de munging em `setLocalDescription`, e o padrão de perfect
 * negotiation do W3C depende do `setLocalDescription()` sem argumento — que é
 * exatamente o que teríamos de abandonar. Na entrada não há nenhuma dessas
 * objeções, e o efeito é o mesmo.
 *
 * # O que NÃO está aqui, de propósito
 *
 * `x-google-min-bitrate` seria a terceira linha óbvia, e está fora. Ele obriga
 * o encoder a manter um piso mesmo quando o controle de congestionamento diz
 * que o link não comporta — ou seja, gasta upload que não existe, e enche
 * justamente o cano cujo ping o produto inteiro existe para proteger.
 */

/**
 * Nível mínimo que 1080p60 exige em H.264.
 *
 * A conta: 1920×1080 são 8160 macroblocos, a 60fps são 489.600 MB/s. O nível
 * 4.2 (`0x2a`) permite 522.240 — cabe. O 3.1 (`0x1f`), que é o que o Chromium
 * anuncia por padrão em TODOS os perfis que oferece, permite 108.000. É menos
 * de um quarto do necessário.
 *
 * Na prática o encoder de software do libwebrtc ignora o nível, mas os
 * caminhos de hardware (NVENC, QSV, AMF, VideoToolbox) e vários decoders de
 * hardware não ignoram — e quem clampa entrega 720p onde foi pedido 1080p, sem
 * erro nenhum em lugar nenhum. É o mesmo teto que a comparação de encoders da
 * gethopp documentou no LiveKit, que fixa `42e01f` e para em 1280×720.
 *
 * Só o último byte muda. `profile_idc` e `profile_iop` ficam intactos porque é
 * por eles que a negociação casa os dois lados; o nível pode divergir por
 * projeto, e é o que `level-asymmetry-allowed=1` — que o Chromium sempre manda
 * — autoriza explicitamente.
 */
const NIVEL_MINIMO = 0x2a;

/** Só a seção de vídeo. Áudio e datachannel passam intocados. */
const SECAO = /^m=/m;

export type AfinacaoSdp = {
  /**
   * Por onde o encoder do outro lado deve COMEÇAR, em bits/s.
   *
   * Sem isto o WebRTC parte de 300 kbps e sobe sondando. A subida leva
   * dezenas de segundos, e nesse meio-tempo o *quality scaler* já derrubou a
   * resolução — que depois só volta com QP baixo sustentado, o que pode nunca
   * acontecer. O começo ruim vira o estado permanente.
   *
   * Não gasta upload nenhum a mais em regime: é o mesmo alvo, alcançado sem o
   * mergulho inicial. `null` deixa o padrão do navegador.
   */
  readonly startBitrateBps?: number | null | undefined;
};

/**
 * Aplica as afinações num SDP inteiro, preservando tudo que não for vídeo.
 *
 * Idempotente: rodar duas vezes no mesmo SDP dá o mesmo resultado.
 */
export function afinarSdp(sdp: string, opcoes: AfinacaoSdp = {}): string {
  if (typeof sdp !== 'string' || sdp.length === 0) return sdp;

  const partes = dividirSecoes(sdp);
  return partes
    .map((secao) => (secao.startsWith('m=video') ? afinarVideo(secao, opcoes) : secao))
    .join('');
}

/** Preâmbulo mais uma entrada por `m=`, com as quebras de linha preservadas. */
function dividirSecoes(sdp: string): string[] {
  const linhas = sdp.split(/(?<=\n)/);
  const secoes: string[] = [];
  let atual = '';
  for (const linha of linhas) {
    if (SECAO.test(linha) && atual.length > 0) {
      secoes.push(atual);
      atual = '';
    }
    atual += linha;
  }
  if (atual.length > 0) secoes.push(atual);
  return secoes;
}

function afinarVideo(secao: string, opcoes: AfinacaoSdp): string {
  const kbps =
    opcoes.startBitrateBps !== undefined &&
    opcoes.startBitrateBps !== null &&
    Number.isFinite(opcoes.startBitrateBps) &&
    opcoes.startBitrateBps > 0
      ? Math.round(opcoes.startBitrateBps / 1000)
      : null;

  return secao
    .split(/(?<=\n)/)
    .map((linha) => {
      if (!linha.startsWith('a=fmtp:')) return linha;
      const quebra = linha.slice(linha.length - 2) === '\r\n' ? '\r\n' : linha.endsWith('\n') ? '\n' : '';
      const corpo = quebra.length > 0 ? linha.slice(0, -quebra.length) : linha;
      return afinarFmtp(corpo, kbps) + quebra;
    })
    .join('');
}

function afinarFmtp(linha: string, kbps: number | null): string {
  let saida = elevarNivel(linha);
  if (kbps !== null && saida.includes('profile-level-id=')) {
    saida = definirParametro(saida, 'x-google-start-bitrate', String(kbps));
  }
  return saida;
}

/** Sobe só o byte de nível, e só quando está abaixo do que 1080p60 exige. */
function elevarNivel(linha: string): string {
  return linha.replace(/profile-level-id=([0-9a-fA-F]{6})/g, (inteiro, id: string) => {
    const nivel = Number.parseInt(id.slice(4), 16);
    if (!Number.isFinite(nivel) || nivel >= NIVEL_MINIMO) return inteiro;
    return `profile-level-id=${id.slice(0, 4)}${NIVEL_MINIMO.toString(16).padStart(2, '0')}`;
  });
}

/** Escreve `chave=valor` no fmtp, substituindo se já existir (idempotência). */
function definirParametro(linha: string, chave: string, valor: string): string {
  const separador = linha.indexOf(' ');
  if (separador === -1) return linha;

  const prefixo = linha.slice(0, separador + 1);
  const params = linha
    .slice(separador + 1)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith(`${chave}=`));

  params.push(`${chave}=${valor}`);
  return prefixo + params.join(';');
}
