/**
 * Ajustes cirúrgicos no SDP que CHEGA, antes de `setRemoteDescription`.
 *
 * # Por que na descrição REMOTA, e não na local
 *
 * Os parâmetros aqui são declarações do RECEPTOR sobre o que ele aceita, e é
 * o transmissor que as obedece. `x-google-start-bitrate` diz por onde o
 * encoder deve começar; o `fmtp` do Opus diz se ele aceita estéreo. Nos dois casos o valor útil está no SDP que recebemos, não no que
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
 * Nível mínimo que 1080p60 exige em H.264 — e por que ele NÃO é mais aplicado
 * por padrão (ADR 0020, TELA-014).
 *
 * Com `level-asymmetry-allowed=1`, o `profile-level-id` que o receptor manda
 * é o que o DECODER dele aceita. Reescrevê-lo na entrada é afirmar, em nome
 * de outra máquina, uma capacidade que ninguém mediu. A ADR 0016 fazia isso
 * em todo SDP; a elevação agora só acontece quando quem chama passa
 * `nivelH264` explicitamente — um workaround por capacidade, com teste e
 * reversível, e hoje nenhum chamador o liga.
 *
 * O raciocínio original, que continua valendo como hipótese a medir:
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
 * Só o último byte mudaria. `level-asymmetry-allowed=1` permite que os níveis
 * dos dois SENTIDOS divirjam; não autoriza fingir que o receptor decodifica
 * um nível que ele não anunciou.
 */
export const NIVEL_1080P60 = 0x2a;

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
  /**
   * Nível H.264 a assumir para o receptor, SÓ quando há evidência de que ele
   * decodifica isso (ADR 0020). `null`/ausente preserva o SDP recebido.
   *
   * Tem de ser o mesmo para todos os peers: formato negociado diferente é
   * encoder diferente, e a R5 existe para impedir isso.
   */
  readonly nivelH264?: number | null | undefined;
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
    .map((secao) => {
      if (secao.startsWith('m=video')) return afinarVideo(secao, opcoes);
      if (secao.startsWith('m=audio')) return afinarAudio(secao);
      return secao;
    })
    .join('');
}

/**
 * Liga o estéreo do Opus, que o Chromium não oferece por padrão.
 *
 * Capturamos em estéreo de verdade — `channelCount: 2`, com os três
 * processamentos de voz desligados — e pagamos 128 kbps por espectador. Mas o
 * libwebrtc negocia mono a menos que o `fmtp` peça o contrário:
 *
 *     inline constexpr int kOpusDefaultStereo = 0;
 *     int GetChannelCount(format) { return param == "1" ? 2 : 1; }
 *
 * Ou seja: os 128 kbps estavam comprando um canal só. O comentário em
 * `mesh-topology` diz "preserva música e efeitos", e preservava — em mono.
 *
 * `stereo=1` diz que queremos receber estéreo; `sprop-stereo=1` diz que o que
 * mandamos é estéreo. Os dois, senão o casamento é assimétrico.
 *
 * Custo: zero bit a mais. O bitrate já estava pago.
 *
 * # Por que reescrever o SDP remoto aqui não é inventar capacidade
 *
 * `stereo=1` no SDP do receptor diz "prefiro receber estéreo". O receptor é
 * sempre o espectador do próprio Tela, e essa É a preferência dele; e todo
 * decoder Opus decodifica estéreo (RFC 7587 §7.1: o parâmetro é preferência,
 * não capacidade). É diferente do nível H.264 da ADR 0020, que afirmava uma
 * capacidade de decoder que ninguém mediu. Se um dia outro cliente entrar na
 * sala, o lugar certo desta preferência passa a ser a descrição LOCAL dele.
 */
function afinarAudio(secao: string): string {
  /*
    Opus identificado pelo PAYLOAD TYPE do `a=rtpmap` (TELA-011, §6.5). Antes a
    linha era escolhida por conter `minptime`, `useinbandfec` ou "opus" no
    `fmtp` — o que casaria qualquer codec que um dia usasse esses nomes, e não
    casaria um Opus cujo `fmtp` não os tivesse. `red/48000/2` (`fmtp:63
    111/111`) e `telephone-event` ficam intocados.
  */
  const linhas = secao.split(/(?<=\n)/);
  const opus = new Set<string>();
  for (const linha of linhas) {
    const m = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?\s*$/i.exec(linha);
    if (m?.[1] !== undefined) opus.add(m[1]);
  }
  if (opus.size === 0) return secao;
  return linhas
    .map((linha) => {
      const m = /^a=fmtp:(\d+) /.exec(linha);
      if (m?.[1] === undefined || !opus.has(m[1])) return linha;
      const { corpo, quebra } = partir(linha);
      let saida = definirParametro(corpo, 'stereo', '1');
      saida = definirParametro(saida, 'sprop-stereo', '1');
      return saida + quebra;
    })
    .join('');
}

/**
 * O RECEPTOR pedindo estéreo na própria resposta (TELA-011).
 *
 * Medido em Chrome real: com `stereo=1` só na descrição remota do
 * transmissor, ele CODIFICA estéreo — e o espectador decodifica em mono,
 * porque o decoder do libwebrtc lê o `stereo` da descrição LOCAL de quem
 * recebe. Um tom só na esquerda chegava igual nos dois canais (0,35 e 0,35).
 *
 * Aqui é o lugar honesto dessa preferência: quem diz "quero estéreo" é o
 * próprio receptor, na resposta dele. Só `stereo` — `sprop-stereo` descreve o
 * que se ENVIA, e o espectador não envia áudio.
 */
export function pedirEstereo(sdp: string): string {
  if (typeof sdp !== 'string' || sdp.length === 0) return sdp;
  return dividirSecoes(sdp)
    .map((secao) => (secao.startsWith('m=audio') ? pedirEstereoNaSecao(secao) : secao))
    .join('');
}

function pedirEstereoNaSecao(secao: string): string {
  const linhas = secao.split(/(?<=\n)/);
  const opus = new Set<string>();
  for (const linha of linhas) {
    const m = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?\s*$/i.exec(linha);
    if (m?.[1] !== undefined) opus.add(m[1]);
  }
  return linhas
    .map((linha) => {
      const m = /^a=fmtp:(\d+) /.exec(linha);
      if (m?.[1] === undefined || !opus.has(m[1])) return linha;
      const { corpo, quebra } = partir(linha);
      return definirParametro(corpo, 'stereo', '1') + quebra;
    })
    .join('');
}

/** Separa a linha do terminador, preservando CRLF. */
function partir(linha: string): { corpo: string; quebra: string } {
  const quebra = linha.endsWith('\r\n') ? '\r\n' : linha.endsWith('\n') ? '\n' : '';
  return { corpo: quebra.length > 0 ? linha.slice(0, -quebra.length) : linha, quebra };
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
  const nivel =
    typeof opcoes.nivelH264 === 'number' &&
    Number.isInteger(opcoes.nivelH264) &&
    opcoes.nivelH264 > 0 &&
    opcoes.nivelH264 <= 0xff
      ? opcoes.nivelH264
      : null;
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
      const { corpo, quebra } = partir(linha);
      return afinarFmtp(corpo, kbps, nivel) + quebra;
    })
    .join('');
}

function afinarFmtp(linha: string, kbps: number | null, nivel: number | null): string {
  let saida = nivel === null ? linha : elevarNivel(linha, nivel);
  if (kbps !== null && saida.includes('profile-level-id=')) {
    saida = definirParametro(saida, 'x-google-start-bitrate', String(kbps));
  }
  return saida;
}

/** Sobe só o byte de nível, e só quando está abaixo do pedido. Nunca desce. */
function elevarNivel(linha: string, minimo: number): string {
  return linha.replace(/profile-level-id=([0-9a-fA-F]{6})/g, (inteiro, id: string) => {
    const nivel = Number.parseInt(id.slice(4), 16);
    if (!Number.isFinite(nivel) || nivel >= minimo) return inteiro;
    return `profile-level-id=${id.slice(0, 4)}${minimo.toString(16).padStart(2, '0')}`;
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
