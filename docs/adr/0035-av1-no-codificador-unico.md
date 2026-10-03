# ADR 0035 — AV1 no codificador único, só com hardware dos dois lados

**Data:** 2026-10-03
**Estado:** aceita (o dono pediu a implementação, 2026-10-03)
**Altera:** R5 em um ponto (`videoCodec: 'h264'` deixa de ser o único) · **Mantém:** "um encode, N envios" (ADR 0029), parâmetros idênticos para todos, H.264 como piso

## Contexto

AV1 entrega a mesma imagem com ~30–40% menos bits que H.264. Num produto
cujo gargalo é o upload de casa dividido por N, isso vale um degrau inteiro
da escada. A R5 fixou H.264 porque era o único com encode por hardware
universal. Hoje RTX 40, Arc e RX 7000 codificam AV1 por hardware, e boa
parte das máquinas decodifica AV1 por hardware.

Medido no Chromium 151 (headless):
- `encodings[0].codec` troca o codec do sender sem renegociar.
- WebCodecs codifica AV1 por software; por hardware não há AV1 nesta máquina
  Linux.

## Decisão

1. **O codec é da SALA, como o perfil H.264** (`core/media/codec-da-sala.ts`).
   O quadro é um só (R5). A sala vira AV1 quando:
   - o encoder desta máquina faz AV1 por **hardware**
     (`isConfigSupported` em `prefer-hardware` e a classe medida é
     hardware);
   - **todos** os senders negociaram AV1;
   - a cascata (ADR 0031) está desligada — o anfitrião não vê o que os
     filhos dos repassadores decodificam.

   Senão, H.264.
2. **O espectador recusa AV1 que não decodifica bem.** Antes de responder,
   ele pergunta ao `mediaCapabilities.decodingInfo` (`webrtc`, AV1,
   1080p60). Se a resposta não vier `powerEfficient` E `smooth`, ele tira o
   AV1 da resposta (`setCodecPreferences`), e a regra 1 deixa a sala inteira
   em H.264. Até a resposta chegar, ele recusa. Quase todo navegador
   ANUNCIA AV1, inclusive celular que só o decodifica por software, e um
   celular fraco decodificando 1080p60 AV1 em software não aguenta.
3. **Troca de codec sem renegociar.** O transporte alinha
   `encodings[0].codec` de cada sender ao codec da sala, e quem entra numa
   sala em AV1 é alinhado ao chegar. O worker só injeta um quadro num sender
   cuja isca é do MESMO codec. Na transição, o sender volta a esperar o
   quadro-chave do codec certo.
4. **A chave da isca guardada.** No H.264 o receptor decide se um quadro é
   chave lendo o NAL IDR do conteúdo. No AV1 ele lê o bit N do cabeçalho de
   agregação, que o pacotizador põe pelo tipo da ISCA. Na primeira versão,
   o IDR real caía numa vaga de delta e chegava como delta. O receptor
   pedia chave, a isca gerava chave, e o worker descartava essa chave
   enquanto esperava o IDR real. O e2e mediu o laço: **80 chaves da isca em
   30 s e 12,8 fps**. Agora a chave da isca que chega com o sender esperando
   fica guardada, e o IDR real sai dentro dela. Depois disso o e2e mediu
   **1 chave e 30 fps** nos dois espectadores.
5. O codificador externo (NVENC nativo do app) não faz AV1
   (`suportaAv1` ausente = não). Só o caminho WebCodecs pode ativar.

## Medido

- `e2e/um-encode.e2e.mjs` com `AV1=1` (o anfitrião força AV1 por software,
  só para teste): 2 espectadores em 1280x720, 30 fps decodificados, 0
  rajadas, `video/AV1` na recepção, 1 chave da isca.
- `AV1=1 AV1_ESPECTADOR=0`: os espectadores recusam AV1, e a sala fica em
  H.264 Baseline, a 30 fps.
- H.264 sem mudança: `um-encode` com 3 espectadores e `mesh.e2e` passam.

## Não medido (humano)

| O quê | Como |
|---|---|
| AV1 por hardware ativando de fato | RTX 40 / Arc / RX 7000 no Windows, abrir a transmissão pelo navegador: o console da transmissão mostra "AV1" no encoder |
| Custo no jogo | MangoHud, comparar FPS do jogo em H.264 e em AV1 com 3 espectadores |
| Ganho real de qualidade | mesmo link, mesma cena: bpp e nitidez vistos pelo espectador nos dois codecs |
| Celular recusando | Android de entrada: `chrome://webrtc-internals` mostra H.264 na recepção |
