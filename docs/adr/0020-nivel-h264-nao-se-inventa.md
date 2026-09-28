# ADR 0020 — O nível H.264 do receptor não se inventa

**Data:** 2026-09-28
**Estado:** aceita
**Substitui:** Decisão 2 da ADR 0016 · **Tarefa:** TELA-014 · **Mantém:** R5

## Contexto

A ADR 0016 reescrevia, em todo SDP recebido, o último byte de
`profile-level-id` para `2a` (nível 4.2), porque o Chromium anuncia `1f`
(3.1) e 1080p60 não cabe em 3.1. A justificativa era que encoders e decoders
de hardware podem clampar pelo nível e entregar 720p em silêncio.

O plano global (§7.1) aponta o problema: com `level-asymmetry-allowed=1`, o
nível que o receptor manda descreve o que o DECODER dele aceita. Reescrevê-lo
é afirmar, em nome de outra máquina, uma capacidade que ninguém mediu.
`level-asymmetry-allowed` deixa os níveis dos dois sentidos divergirem; não
autoriza fingir o do outro lado.

Nenhuma das duas afirmações foi medida neste projeto: nem que o hardware clampa
em 3.1 (a ADR 0016 cita a comparação da gethopp, não um ensaio nosso), nem que
a elevação é inócua em todos os receptores.

## Decisão

1. O SDP recebido chega ao `setRemoteDescription` com o nível que o receptor
   anunciou. `afinarSdp` deixou de elevar por padrão.
2. A elevação continua existindo como **workaround por capacidade**, isolado
   em `core/mesh/sdp-tuning.ts`: só roda com `nivelH264` explícito, é coberta
   por teste e é reversível sem tocar em mais nada. Hoje nenhum chamador a liga.
3. Se um dia for ligada, será para **todos os peers com o mesmo valor**:
   formato negociado diferente é encoder diferente, e a R5 existe para impedir
   N encoders disputando a GPU com o jogo.
4. A UI continua mostrando a resolução MEDIDA (`frameWidth`/`frameHeight` do
   `outbound-rtp`), não o rótulo do preset. Se algum encoder clampar, o número
   na tela vai dizer.

## Consequência

Onde o encoder de hardware respeita o nível do receptor, 1080p60 pode sair em
resolução menor. Isso agora é visível e medido, em vez de escondido por uma
capacidade fabricada.

## Medido nesta mudança

`e2e/qualidade.e2e.mjs`, Chromium 1234 headless, Linux, encoder de software:
o SDP remoto chegou com `profile-level-id=4d001f` intacto (Main, nível 3.1), e
o `outbound-rtp` reportou 1920×1080. O encoder de software ignora o nível,
como a ADR 0016 já dizia — este ensaio não diz nada sobre hardware. Os três
senders seguiram com parâmetros idênticos (R5).

## Para religar

Só com evidência, na matriz da TELA-016:

- transmissor com encoder de hardware identificado, receptor identificado;
- resolução de saída medida com e sem a elevação;
- decodificação confirmada no receptor com o nível elevado — por exemplo
  `navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video: {
  contentType: 'video/H264; profile-level-id=640c2a', width: 1920, height:
  1080, framerate: 60, bitrate } })` devolvendo `supported`.

Com isso, a capacidade entra por um canal honesto (o receptor declara), e
`nivelH264` é passado a partir dela.
