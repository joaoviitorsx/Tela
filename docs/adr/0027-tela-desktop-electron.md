# ADR 0027 — Tela Desktop: Electron, janela única com modo escondido

**Data:** 2026-10-01
**Estado:** proposta — vira "aceita" ou "rejeitada" no fim da prova técnica (D0, TELA-027)
**Plano:** `docs/desktop/PLANO-desktop.md` · plano global §20
**Mantém:** R1–R8, ADR 0015–0019 (malhas), 0026 (link só com o nome), 0028 (sala aberta)

## Contexto

O app desktop é o transmissor para Windows e Linux; quem assiste segue no
navegador. Ele roda em segundo plano enquanto a pessoa joga. O dono definiu o
diferencial do produto: **qualidade da stream e leveza** — custo de CPU/GPU e
frame time do jogo pesam mais que memória ou tamanho do instalador.

A R1 previa portar o núcleo para Tauri. No Linux o Tauri usa WebKitGTK, cujo
WebRTC não é o do Chromium em que as malhas de qualidade foram calibradas e
medidas (`scaleResolutionDownBy`, `qualityLimitationReason`, encoder,
`availableOutgoingBitrate`). Trocar o motor seria recomeçar a validação.

## Decisão proposta

1. **Electron**, mantendo o WebRTC do Chromium e o `core/` intacto.
2. **Janela única** (decisão do dono): interface e `BroadcastSession` no mesmo
   renderer, com `backgroundThrottling: false`. Fechar esconde a janela, não a
   destrói; há modo compacto na mesma janela.
3. **Modo escondido explícito:** como o throttling está desligado, o main avisa
   a página quando a janela some; a página pausa animações, solta a prévia,
   descarta o 3D e para relógios visuais. Captura, encode, envio e o laço de
   qualidade nunca param.
4. **Laço de qualidade inalterado:** `getStats` a 1 s. Só a cópia para a
   interface é agregada.
5. **Encoder detectado, não deduzido.** O app liga flags do Chromium que a web
   não pode (ex.: VA-API de encode no Linux) e mostra hardware/software/
   desconhecido; o padrão de resolução segue o encoder real.
6. **Som escolhido pelo usuário:** sistema, só o jogo, ou sem som. No Windows,
   "só o jogo" usa um addon nativo (WASAPI process loopback) num
   `utilityProcess`, entregando PCM a um `AudioWorklet`; no Linux, roteamento
   PipeWire gerenciado, sem ponte nativa.
7. **Captura e encoder nativos só com problema medido** (TELA-034).
8. Quando aceita, a R1 do AGENTS.md passa a dizer "desktop (Electron)" no lugar
   de "Tauri (Fase 3)" — a regra em si (núcleo sem React) não muda.

## Critério para aceitar

A prova técnica (D0) mede, na matriz do plano §9 (Windows do dono com jogos e o
Fedora do dono), CPU e memória por processo com a janela aberta e escondida,
encoder, bpp/QP e o frame time do jogo com e sem o Tela. Aceita se o orçamento
do plano §1.2 for cumprido no Windows e no Linux com encode em hardware; o
resultado no Linux com encode em software decide entre limitação publicada
(padrão menor) e abrir a TELA-034.

## Alternativas

- **Renderer de mídia separado da interface:** custo zero da interface fora da
  tela por construção e isolamento de crash; recusado pelo dono em favor de um
  processo a menos. O modo escondido cobre o custo; o risco de crash é
  mitigado e registrado.
- **Tauri + WebView:** descartado no Linux pelo motor WebRTC diferente.
- **Motor nativo (GStreamer/webrtcbin) desde já:** reescreve captura, encode,
  sincronismo e interoperabilidade antes de haver problema medido.
