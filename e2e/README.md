# E2E — dois browsers de verdade

```bash
pnpm dev          # num terminal
pnpm e2e          # noutro
```

Os 208 testes unitários provam a lógica com fakes. Este prova que a lógica
fala com o WebRTC que realmente existe: SDP real, ICE real, encoder real e
frames de vídeo atravessando uma `RTCPeerConnection` entre dois contextos de
browser separados.

**O que ele cobre:** carga do front, estado offline do espectador, o mesh
completo (host publica → espectador conecta sozinho → frames chegam),
estatísticas agregadas com bitrate medido, troca de qualidade ao vivo sem
derrubar quem assiste, teto de espectadores e a saída do transmissor.

**O que ele NÃO cobre:** `getDisplayMedia`. O picker de tela é do sistema
operacional e não existe em headless — a captura aqui é um canvas animado.
Tudo a jusante da trilha de vídeo é exercitado de verdade.

Ele já encontrou um bug que os testes com fake não pegavam: dois `open()`
concorrentes (React em StrictMode) faziam a tentativa obsoleta derrubar o
transporte da viva, e "canal cheio" chegava ao usuário como "não está
transmitindo".

---

# Simulador das malhas — `malhas.sim.mjs`

```bash
node e2e/malhas.sim.mjs              # 1200 cenários x 300s simulados (~5s)
node e2e/malhas.sim.mjs --premissas  # onde o modelo pode estar errado
node e2e/malhas.sim.mjs --trace=<id> # série temporal de um cenário
```

Não precisa de browser nem de servidor. Monta `BroadcastSession`,
`UplinkGovernor`, `MeshTopology` e `StatsSampler` REAIS — importados de
`apps/web/src/` via `tsx` — contra um modelo de rede que reproduz o
`AimdRateControl` do libwebrtc, incluindo o teto de `1,5 × acked + 10 kbps`
que é a origem do defeito da ADR 0018.

Varre upload × espectadores × espectador fraco × pressão de CPU × entrada
escalonada × semente da sessão anterior, e reporta, por cenário: degrau final,
bitrate, bits por pixel **pedido e entregue**, tempo até estabilizar,
reconfigurações de encoder, e quanto ficou abaixo do que o link pagava.

`e2e/malhas.sim.json` é artefato de execução, não fonte.

---

## Qualidade — o que os testes com fake não conseguem provar

```bash
pnpm dev                       # num terminal
node e2e/qualidade.e2e.mjs     # dois Chrome reais, H.264 real
node e2e/malhas.sim.mjs        # 1200 cenários × 300s nas classes reais
```

`qualidade.e2e.mjs` mede em browser: quais codecs existem, qual foi negociado,
se o munging de SDP chega e AGE, se `scaleResolutionDownBy` tira pixel de
verdade, a série do `availableOutgoingBitrate`, os bits por pixel ao longo do
tempo, e se os parâmetros dos senders são idênticos entre peers (R5).

`malhas.sim.mjs` roda a matriz de cenários — upload, espectadores, espectador
fraco, pressão de CPU, entrada escalonada, semente da sessão anterior — com o
teto `1,5 × acked` do `AimdRateControl` modelado. `--premissas` lista onde o
modelo pode estar errado; `--clamp-duro` usa a leitura estrita do libwebrtc.

Os dois juntos já pegaram uma regressão que 275 testes verdes não pegavam: a
semente da sessão anterior calava as duas malhas de controle ao mesmo tempo, e
a transmissão passava 300 segundos a 0,0068 bit por pixel (ADR 0019).

## Custo da interface — o que fica rodando sem ninguém ver

```bash
pnpm dev                              # num terminal
node e2e/custo-interface.e2e.mjs      # CPU por tela parada, animações, sessões
```

Mede o `TaskDuration` do CDP em cada tela parada, lista as animações infinitas
(separando as que estão numa camada invisível) e confere que TRANSMITIR pede a
captura uma vez só e que cada página tem no máximo um socket de sinalização
(TELA-026). WebGL é SwiftShader: o número da TV 3D não é custo real, a
comparação visível × oculta é.
