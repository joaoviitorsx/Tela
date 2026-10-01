# ADR 0027 — Tela Desktop: Electron, mídia num renderer próprio

**Data:** 2026-10-01
**Estado:** proposta — vira "aceita" ou "rejeitada" no fim da prova técnica (D0, TELA-027)
**Plano:** `docs/desktop/PLANO-desktop.md` · plano global §20
**Mantém:** R1–R8, ADR 0015–0019 (malhas), 0025 (aprovação), 0026 (link só com o nome)

## Contexto

O app desktop é o transmissor para Windows e Linux; quem assiste segue no
navegador. Ele roda em segundo plano enquanto a pessoa joga, então custo de
CPU/GPU e frame time do jogo são o critério principal — mais que memória ou
tamanho do instalador.

A R1 previa portar o núcleo para Tauri. No Linux o Tauri usa WebKitGTK, cujo
WebRTC não é o do Chromium em que as malhas de qualidade foram calibradas e
medidas (`scaleResolutionDownBy`, `qualityLimitationReason`, encoder,
`availableOutgoingBitrate`). Trocar o motor seria recomeçar a validação.

## Decisão proposta

1. **Electron**, mantendo o WebRTC do Chromium e o `core/` intacto.
2. **Três papéis de processo:** principal quase ocioso; **renderer de mídia**
   oculto, único dono da `BroadcastSession`, com `backgroundThrottling: false`;
   **renderer de interface** com throttling normal, que pode ser destruído ao
   ir para a bandeja sem derrubar a transmissão.
3. **IPC só de estado**, por `MessageChannelMain` direto entre interface e
   mídia, validado por schema; nunca quadro de vídeo. Prévia na interface por
   miniaturas de baixa taxa, sob demanda.
4. **Laço de qualidade inalterado:** `getStats` a 1 s no renderer de mídia. Só a
   cópia para a interface é agregada a 1 Hz.
5. **Encoder detectado, não deduzido.** O app pode ligar flags do Chromium
   (ex.: VA-API de encode no Linux) e mostra hardware/software/desconhecido.
6. **Captura nativa e motor próprio só com problema medido** (TELA-034).
7. Quando aceita, a R1 do AGENTS.md passa a dizer "desktop (Electron)" no lugar
   de "Tauri (Fase 3)" — a regra em si (núcleo sem React) não muda.

## Critério para aceitar

A prova técnica (D0) mede, nos ambientes da matriz do plano §8, CPU e memória
por processo, encoder, bpp/QP e o frame time do jogo com e sem o Tela. Aceita se
o orçamento do plano §5.4 for cumprido em pelo menos Windows + NVIDIA e Fedora
com encode em hardware; o resultado no Linux com encode em software decide
entre limitação publicada (padrão menor) e abrir a TELA-034.

## Alternativas

- **Um renderer só** (interface + mídia): mais simples; perde a interface
  destruível e mistura throttling. O D0 mede os dois; se a diferença for
  desprezível e a política de fechar couber, fica o simples.
- **Tauri + WebView:** descartado no Linux pelo motor WebRTC diferente.
- **Motor nativo (GStreamer/webrtcbin) desde já:** reescreve captura, encode,
  sincronismo e interoperabilidade antes de haver problema medido.
