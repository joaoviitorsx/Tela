# ADR 0016 — Perfil H.264, nível anunciado e jitter buffer do espectador

**Data:** 2026-08-28
**Estado:** aceita — Decisão 2 substituída pela ADR 0020
**Complementa:** ADR 0015 · **Mantém:** R5 (o codec continua sendo H.264)

## Contexto

A ADR 0015 conserta a malha que decidia mal a resolução. Esta trata do que
sobrava depois dela: três configurações que custam **zero bit a mais de
upload** e melhoram a imagem que chega.

A restrição é explícita do dono do produto: **cinco espectadores, e o upload
não pode crescer.** Sobra uma única categoria de alavanca — extrair mais
qualidade dos mesmos bits.

## Decisão 1 — Ordenar as variantes de H.264 por perfil

`preferVideoCodec` filtrava as capacidades só por `mimeType` e passava o
resultado a `setCodecPreferences` na ordem em que o navegador as devolve. O
Chromium devolve **Constrained Baseline** (`profile-level-id=42…`) primeiro.

Baseline não tem CABAC nem transformada 8×8. São **10 a 15% de bitrate a mais
pela mesma imagem** — e num orçamento de 3 Mbps por espectador, 15% é um degrau
inteiro da escada da ADR 0010.

A ordenação passa a ser, nesta precedência:

1. **`packetization-mode=1` antes de `0`.** O modo 0 aceita um NAL por pacote e
   proíbe fragmentação, o que em 1080p obriga o encoder a picotar o quadro em
   fatias — mais overhead, pior compressão, e uma perda de pacote custando mais
   imagem.
2. **Perfil:** High (`64`) > Main (`4d`) > Baseline (`42`).

Todo encoder de hardware dos últimos doze anos faz High. É a mesma aceleração,
com um codificador de entropia melhor. A R5 continua valendo: o codec é H.264,
e nada aqui liga VP9 ou AV1.

> **Medido (ADR 0019).** Num Chrome for Testing 151 real, `getCapabilities`
> ofereceu seis variantes de H.264 — `42…` (Constrained Baseline) e `4d…`
> (Main). **Nenhuma `64…`: High profile não é oferecido.** A ordenação
> funcionou e negociou `4d001f pm=1`, ou seja Main em vez de Baseline, o que
> ainda é um ganho — mas os 10 a 15% de CABAC prometidos acima **não foram
> medidos e podem não existir** neste caminho. Onde há encoder de hardware o
> High costuma aparecer; aqui não havia.

## Decisão 2 — Elevar o nível anunciado para 4.2

> **Substituída pela ADR 0020.** O nível do receptor não é mais reescrito por
> padrão: era capacidade fabricada, não medida. O texto abaixo fica como
> registro do raciocínio e da hipótese a medir.

O Chromium anuncia `profile-level-id=…1f` em **todas** as variantes que
oferece. `1f` é o nível 3.1, que permite 108.000 macroblocos por segundo.

1080p60 são 8160 macroblocos × 60 = **489.600 MB/s**. O nível 3.1 cobre menos
de um quarto disso. O nível 4.2 (`0x2a`) permite 522.240 — cabe.

O encoder de software do libwebrtc ignora o nível. Os caminhos de hardware
(NVENC, QSV, AMF, VideoToolbox) e vários decoders de hardware **não ignoram** —
e quem clampa entrega 720p onde foi pedido 1080p, sem erro em lugar nenhum. É o
mesmo teto que a comparação de encoders da gethopp documentou no LiveKit, que
fixa `42e01f` e para em 1280×720.

**Só o último byte muda.** `profile_idc` e `profile_iop` ficam intactos porque é
por eles que a negociação casa os dois lados; o nível pode divergir por
projeto, e é exatamente o que `level-asymmetry-allowed=1` — que o Chromium
sempre manda — autoriza.

## Decisão 3 — `x-google-start-bitrate` no SDP recebido

Sem ele o WebRTC parte de 300 kbps e sobe sondando. A subida leva dezenas de
segundos, e nesse meio-tempo o quality scaler já derrubou a resolução — que
depois só volta com QP baixo sustentado, o que pode nunca acontecer. **O começo
ruim vira o estado permanente.**

O alvo é o bitrate efetivo corrente, então **não gasta upload nenhum a mais em
regime**: é o mesmo destino, alcançado sem o mergulho inicial. Um peer que
entra no meio de uma transmissão já degradada também começa onde os outros
estão.

**`x-google-min-bitrate` ficou de fora, de propósito.** Ele obriga o encoder a
manter um piso mesmo quando o controle de congestionamento diz que o link não
comporta — gasta upload que não existe e enche justamente o cano cujo ping o
produto inteiro existe para proteger.

### Por que na descrição REMOTA

Os dois parâmetros são declarações do receptor que o transmissor obedece, então
o valor útil está no SDP que chega. E mexer na descrição local seria pior de
duas formas: o Chromium já recusa várias formas de munging em
`setLocalDescription`, e o perfect negotiation do W3C depende do
`setLocalDescription()` sem argumento — que teríamos de abandonar.

Na entrada não há nenhuma dessas objeções. `core/mesh/sdp-tuning.ts` é puro,
idempotente e testado; falhar ali devolve o SDP intacto.

## Decisão 4 — Jitter buffer de 80ms, em vez de zero

`minimizePlayoutDelay()` zerava `playoutDelayHint` e `jitterBufferTarget`. Isso
não é "buffer pequeno": é **buffer nenhum**.

Todo pacote que chega fora de ordem ou atrasado — o que acontece em qualquer
Wi-Fi, a qualquer momento — é descartado. O quadro fica incompleto, o decoder
pede keyframe, e keyframe de quadro de gameplay custa muitos bits de uma vez. O
resultado é um ciclo de pulsos de nitidez e mancha, com cadência irregular que
se lê como travamento mesmo a 58ms de RTT.

80ms é o menor buffer que absorve o jitter típico de Wi-Fi doméstico, e o que
se compra são quadros com cadência constante — metade da sensação de qualidade.

> **Correção (ADR 0019).** Esta seção dizia "o Discord opera entre 150 e
> 300ms". **Não existe fonte publicada para isso**: Discord, Meet e Zoom não
> divulgam jitter buffer nem latência absoluta. Era um número inventado.
>
> O que o Discord publicou é o MECANISMO, e ele sustenta a decisão melhor do
> que o número inventado: em *From Blocky to Brilliant* eles medem que um
> keyframe custa **6 a 10 vezes** um quadro delta, e que a imagem quadriculada
> vinha de keyframe demais. É o ciclo que este buffer corta.
>
> E `jitterBufferTarget` é um PISO, não um alvo: o buffer real é
> `max(alvo, o que o estimador calcular)`. Só custa latência com a rede calma.
>
> **E o número calibrado apareceu depois (ADR 0020).** Carrascosa & Bellalta
> instrumentaram o **Stadia** — que é WebRTC quase de estoque — e mediram o
> jitter buffer dele: **58,42 ms em 720p, 45,34 ms em 1080p, 35,35 ms em 4K**
> (arXiv:2009.09786, Computer Communications 188/2022). Dois a três quadros, e
> encolhendo conforme a resolução sobe.
>
> É a régua que faltava, e ela é revisada por pares em vez de inventada. Os
> 80ms fixos eram 1,8× o que o Stadia opera em 1080p.

O áudio continua fora: ele nunca teve o buffer mexido, e continua não tendo.

## Consequências

Nenhuma destas mudanças aumenta o upload. Somam, na melhor das hipóteses, algo
como 10–15% de eficiência de compressão (perfil), o fim de um clamp silencioso
de resolução (nível), o fim do mergulho inicial (start bitrate) e cadência
estável (buffer).

Trocam-se **80ms de latência** por estabilidade de quadro. É a única troca
negativa do conjunto, e é deliberada.

## O que continua sem verificação

Tudo isto precisa de humano com máquina e rede reais:

1. `chrome://webrtc-internals` → o codec negociado é `H264` com
   `profile-level-id` terminando em `2a`. **Metade disto já foi medida**
   (ADR 0019): num Chrome real a descrição aplicada trouxe `4d002a`, ou seja o
   nível elevado chegou e Main foi escolhido. Falta só confirmar num navegador
   que ofereça High (`640c…`), que o Chromium de teste não oferece;
2. ~~o campo `encoderImplementation` diz `ExternalEncoder`~~ — **este item
   caiu.** Medido na ADR 0019: o campo só existe no `getStats()` enquanto há
   captura de câmera ou microfone VIVA. Numa página que só captura tela, a
   chave nem aparece no relatório, e o mesmo vale para `decoderImplementation`
   no espectador. O indicador "hardware/software" do console lê `null` no
   caminho real do produto. Como reportar encode em hardware sem depender desse
   campo continua em aberto;
3. medir a latência glass-to-glass com câmera a 240fps antes e depois dos 80ms,
   para confirmar que o total continua abaixo de 200ms;
4. confirmar que o nível elevado não quebra a negociação em nenhum navegador de
   espectador (Firefox e Safari incluídos) — o risco é baixo pelo
   `level-asymmetry-allowed`, mas não é zero e não foi testado.

## Adendo (2026-10-03) — o codificador único segue o perfil da sala

O caminho "um encode, N envios" (ADR 0029) codificava fixo em Constrained
Baseline (`avc1.42e02a`), enquanto o SDP de cada espectador já negociava Main
(`4d…`) pela Decisão 1 acima: o receptor aceitava CABAC e recebia CAVLC.

Agora o perfil é o **piso da sala** (`core/media/perfil-h264.ts`): Main só
quando TODOS os senders conectados negociaram Main ou High; um só-Baseline
(Firefox: `42e01f`) ou a cascata ligada (o anfitrião não vê o que os filhos
dos repassadores negociaram) seguram a sala em Baseline. O quadro continua
um só para todos — R5 intacta.

No codificador WebCodecs (`adapters/webcodecs-codificador.ts`):
- Main é perguntado POR MODO de aceleração (`isConfigSupported`) antes de
  ser usado: um `configure` recusado viraria "a GPU morreu" para a política
  de aceleração.
- Trocar de perfil reconfigura com IDR, como trocar de tamanho.
- Timestamp de saída voltando (B-frames) proíbe Main até o fim da sessão.
- O perfil EMITIDO sai do SPS do quadro-chave e aparece no console
  (`WebCodecs·hardware · H.264 Main`) — o pedido não é prova.

**Medido** (`ESPECTADORES=3 node e2e/um-encode.e2e.mjs`, Chromium headless):
o encoder de software emitiu Main (SPS `profile_idc` 77) e os três
espectadores decodificaram a 29,8 fps, sem reconectar, 3 quadros-chave em
30 s. `qualidade.e2e.mjs` e `malhas.sim.mjs --portao` sem regressão.

**Não medido aqui:** o ganho de bits em gameplay real (os ~10% vêm de PSNR em
fonte sintética no NVENC), o Media Foundation do Windows honrando Main sem
B-frames (conferir o console), e o NVENC nativo do Linux, que continua em
Baseline (`tela-captura.c`; mudar exige o protocolo do binário).
