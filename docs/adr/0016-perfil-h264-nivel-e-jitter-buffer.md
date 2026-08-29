# ADR 0016 — Perfil H.264, nível anunciado e jitter buffer do espectador

**Data:** 2026-08-28
**Estado:** aceita
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

## Decisão 2 — Elevar o nível anunciado para 4.2

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

80ms é o menor buffer que absorve o jitter típico de Wi-Fi doméstico. O
orçamento total continua bem abaixo de 200ms glass-to-glass — o Discord opera
entre 150 e 300ms — e o que se compra são quadros com cadência constante, que é
metade da sensação de qualidade.

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
   `profile-level-id` começando em `640c` ou `4d00`, e terminando em `2a`;
2. o campo `encoderImplementation` — agora visível no próprio console da
   transmissão como "encode em hardware/software" — diz `ExternalEncoder`;
3. medir a latência glass-to-glass com câmera a 240fps antes e depois dos 80ms,
   para confirmar que o total continua abaixo de 200ms;
4. confirmar que o nível elevado não quebra a negociação em nenhum navegador de
   espectador (Firefox e Safari incluídos) — o risco é baixo pelo
   `level-asymmetry-allowed`, mas não é zero e não foi testado.
