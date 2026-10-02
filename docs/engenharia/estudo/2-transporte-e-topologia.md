# Estudo 2 — Transporte e topologia

**Data:** 2026-10-02 · **Escopo:** camadas de transporte (controle de congestionamento, perda, pacing) e de topologia (cascata de repasse por espectadores) · **Não altera nenhum arquivo existente.**

**Ferramentas novas** (sem navegador, Node; as duas importam a escada REAL de `packages/shared`):

```bash
node e2e/bench/estudo-transporte.mjs [--parte=rampa|pacing|perda] [--idr=8]
node e2e/bench/estudo-topologia.mjs  [--dmax=3 --salto=40 --salas=1000 --folga-rele=0.5 --kmax=6 --permanencia=45 --json]
```

## Convenções de leitura

Cada afirmação não óbvia leva uma etiqueta:

- **[F]** fato verificado hoje (2026-10-02) numa fonte primária: código do libwebrtc `main` (googlesource), RFC, rascunho IETF, spec do W3C. Link na seção Referências.
- **[I]** inferência minha, derivada de [F] mais aritmética. Pode estar errada; o experimento que a derruba está escrito.
- **[H]** hipótese: plausível, não verificada, e com experimento proposto.
- **[A]** premissa de modelo (calculadora ou simulador).

**Aviso de versão.** O código lido é o `main` do libwebrtc de hoje. O Electron 44 do desktop traz Chromium 152 (`docs/desktop/D0b-um-encode-n-envios.md`) e o Chrome dos espectadores é o que cada um tiver; os *field trials* ativos em cada versão variam. Tudo marcado [F] vale para o `main`; que valha para o binário do usuário é [I] até a medição E1 (§5).

---

## 0. Resumo executivo e tabela ranqueada

O que o estudo conclui, em cinco linhas:

1. **A única proposta que muda a ordem de grandeza é a cascata de repasse.** Com 50 espectadores, a malha pura entrega 0,1 / 0,7 / 1,5 / 4,5 Mbps por cabeça em hosts de 10 / 50 / 100 / 300 Mbps (e a porta da ADR 0030 só admite ≈ 3 / 17–19 / 35–39 / 50 pessoas, no piso de 360p60: `⌊b·N/p⌋` com e sem a folga de admissão de 10 %). Com uma árvore de profundidade ≤ 3 e repassadores que cedem metade da subida, a **mediana** das salas sorteadas sobe para 2,2–3,6 / 9–16,2 / 12–16,2 / 12–16,2 Mbps (1080p60 no teto nas distribuições típica e fibra), com o host usando 7–70 Mbps em vez de 0,75·U inteiro. Custo: +80 a +120 ms de latência de ponta a ponta, subárvores que caem 1–2,6 vezes por hora e exposição de IP entre espectadores.
2. **O transporte já está perto do que o libwebrtc consegue dar a partir do JavaScript.** O que falta é medição: não sabemos se as sondas de banda do GCC rodam nos caminhos do Tela (o código diz que, por padrão, elas ficam presas em 5 Mbps, §1.4). É a pergunta barata com maior valor de informação.
3. **FEC não compra nada que o jitter buffer não compre mais barato**, e o libwebrtc desliga o ULPFEC para H.264 quando há NACK [F]. O que compra é um piso do jitter buffer atrelado ao RTT medido: com RTT 80 ms e perda de 1 %, J = 60 ms dá ~710 soluços/min; J = 100 ms, ~17; FEC de 10 %, ~0,5 (a +10 % de banda).
4. **Pacing:** o pico de fila por alinhamento de N senders é `ρ·T_quadro` = 12,5 ms para quadros P (analítico, independente de N e U) e 33–59 ms para um IDR. É pequeno; escalonar não vale o custo, exceto, talvez, o IDR. O problema grande de pacing é outro: **o IDR leva 80–120 ms para sair de cada sender** (independe de U e N), mais que o jitter buffer inicial de 60 ms. É assunto de encoder (Estudo 1).
5. **Na cascata, a perda se acumula por salto.** Com 1 % de perda e RTT 40 ms por salto, esconder os soluços exige J ≈ 100 / 140 / 180 ms para d = 1 / 2 / 3 saltos. A latência extra da árvore sob perda real é maior que os 25–50 ms por salto do caso limpo.

### Propostas, em ordem de prioridade

Prioridade = ganho × confiança ÷ custo. "Ganho" é para a grade do pedido (N = 5…50, host 10–300 Mbps).

| # | Proposta | Ganho quantificado | Custo / risco | R5 / ADR | Validação | Prioridade |
|---|---|---|---|---|---|---|
| T1 | **Medir a rampa e as sondas por caminho** (série de `availableOutgoingBitrate` a 5 Hz desde a conexão, em Chrome real, com e sem `x-google-max-bitrate`) | Informação: decide T6 e calibra o simulador (hoje modelado só como 8 %/s) | Muito baixo (um e2e) | Neutro | E1 (§5.2) | **Já** |
| T2 | **Cascata de repasse, fase 1:** profundidade ≤ 2, repassadores opt-in/medidos, árvore montada pelo host | N = 50: mediana de b de 0,1–4,5 para 2,2–16,2 Mbps; admissão de 3–50 para 50 pessoas | Alto (nova sessão no core, worker, simulador, ADR); +80 ms; IP exposto entre espectadores; 1–2 quedas/h/espectador | R5 preservada (b único; reparentar antes de descer); R8 preservada (host é o hub de sinalização); ADR nova | §4.9, E2–E5 | **Alta, atrás de E2** |
| T3 | **Piso do `JitterGovernor` atrelado ao RTT** (J ≥ RTT + 25 ms; ≥ 2·RTT + 35 ms em perda ≥ 1 %), e +≈RTT por salto na cascata | RTT 80 ms, p = 1 %: 710 → 17 soluços/min por +40 ms | Baixo (uma regra em `jitter-governor.ts`; RTT já está em `getStats`) | Neutro (não é uma das quatro de R5) | E6 | **Alta** |
| T4 | **Classificar o caminho: limitado por capacidade × por perda**, e não deixar um Wi-Fi com perda aleatória arrastar a sala | Não quantificado; depende da frequência de Wi-Fi ruim na base | Médio; risco de esconder um colapso verdadeiro | Estende R5 (o caminho "por perda" deixa de votar no mínimo, com prazo) | Simulador com perda por caminho (§5.1) | Média |
| T5 | **Registrar a decisão "sem FEC"** e tirar `red`/`ulpfec`/`flexfec` das preferências de codec | Zero bit; elimina ambiguidade de SDP | Nenhum | Neutro | `e2e/mesh.e2e.mjs` | Média (efeito nulo hoje, barata) |
| T6 | `x-google-max-bitrate` no SDP remoto, **só se E1 mostrar sondas limitadas a 5 Mbps** e E4 mostrar que a sonda de entrada não derruba a sala | Rampa de 24 s para ~0,5 s (1,9 → 12 Mbps, modelo) em caminho novo | Risco: sondas de 3×/6× do início somam 4–97 Mbps por 100–200 ms sobre os N caminhos vizinhos | Neutro em R5; afeta ADR 0030 | E1 + simulador com sondas | Baixa, **condicional** |
| T7 | Escalonar o IDR entre os senders na janela `S_idr/R` | Fila de IDR 33–59 ms → 1–19 ms | Dobra a latência de IDR dos últimos senders (80–120 ms a mais) | Neutro | E5 | Baixa |
| T8 | *Field trials* no Electron (`--force-fieldtrials`): `WebRTC-BweBackOffFactor`, `WebRTC-Bwe-ProbingConfiguration`, `WebRTC-Bwe-LossBasedBweV2`, `WebRTC-AlrDetectorParameters` | Desconhecido | Frágil entre versões do Chromium; só vale no host desktop | Neutro | E7 | Baixa (só com defeito medido) |
| T9 | Stripes via camadas temporais SVC (L1T2/L1T3) para atingir r\* onde nenhum nó banca uma cópia inteira | Só nas distribuições "pobre": 3,6 → até 7,4 Mbps no host de 10 Mbps | Muito alto; fere "60 fps sempre" e "parâmetros idênticos" | Exigiria ADR que mexe em R5 | Fora do escopo | Pesquisa |
| T10 | SCReAMv2 / L4S | Nenhum em 2026 | — | — | Monitorar | Nenhuma ação |

---

## 1. Controle de congestionamento

### 1.1 Estado atual (arquivo e função)

| Peça | Onde | O que faz |
|---|---|---|
| Leitura do BWE por caminho | `core/media/stats-sampler.ts` (suaviza, aquece 8 amostras, voto só depois de aquecido, ADR 0030) | Transforma `availableOutgoingBitrate` em orçamento por caminho |
| Governador | `core/media/uplink-governor.ts` (`UPLINK_SHARE` 0,75, `SUAVIZACAO` 0,25, `SUBIR` 0,06, `CORTAR` 0,30, `AQUECIMENTO_AMOSTRAS` 8, `ABSURDO_POR_CAMINHO` 0,6) | Orçamento = mínimo entre caminhos, com histerese assimétrica calibrada pelo teto de `1,5×acked` (ADR 0018) |
| Malha de banda | `core/media/malha-de-banda.ts` (`AMOSTRAS_DE_COLAPSO` 3, `SONDA_ESPERA_INICIAL` 15 s … 240 s, `SONDA_FOLGA` 1,3) | Evidência de colapso e sonda de subida própria (ADR 0023, 0030) |
| Alvo do codificador único | `core/media/alvo-do-codificador.ts` (`FOLGA_DA_ESTIMATIVA` 0,85, `BITRATE_MINIMO` 300 kbps) | Orçamento até o teto útil de bpp, freio pela pior estimativa |
| Início do BWE por caminho | `core/mesh/sdp-tuning.ts` `afinarSdp` → `x-google-start-bitrate`, chamado de `peer-link.ts:535` com `mesh-topology.ts` `bitrateInicial()` | O caminho novo nasce no que enviamos aos outros |
| Atuação no sender | `core/mesh/mesh-topology.ts` ~l.600–650 | `scaleResolutionDownBy`, `maxBitrate`, `maxFramerate`, `networkPriority: 'medium'`, `degradationPreference` |
| Porta pela banda | `core/media/capacidade-pela-banda.ts` | `⌊b·N/p⌋` com `min(b, 0,75·enviado)` |

### 1.2 O que o libwebrtc faz, hoje, caminho por caminho

Leitura do `main` (arquivos em Referências). Cada `RTCPeerConnection` é um `Call` com seu próprio controlador, pacer e estimador, ou seja, **N caminhos = N controladores independentes que desconhecem estarem no mesmo gargalo** [F: um `RtpTransportControllerSend` por `Call`; inferência de que não há coordenação entre eles, não vi código de coordenação entre `Call`s].

**Estimador por atraso (delay-based).**
- Trendline: suavização 0,9 e ganho de limiar 4,0 [F: `trendline_estimator.cc` `kDefaultTrendlineSmoothingCoeff`, `kDefaultTrendlineThresholdGain`]; adaptação do limiar com passo máximo de 15 ms [F: `kMaxAdaptOffsetMs`]; sinal de sobreuso só depois de 10 (ms) acima do limiar [F: `kOverUsingTimeThreshold`].
- Agrupa pacotes enviados em janelas de 5 ms antes de calcular o gradiente [F: `delay_based_bwe.cc` `kSendTimeGroupLength`]. É por isso que um burst de um quadro (todos os pacotes dentro de 5 ms) conta como um grupo só.
- AIMD: aumento multiplicativo `1,08^min(Δt, 1 s)` (ou aditivo perto do máximo conhecido), recuo `0,85 × acked`, e o **aumento é limitado a `1,5 × acked + 10 kbps`** [F: `aimd_rate_control.cc` `MultiplicativeRateIncrease`, `kDefaultBackoffFactor`, `increase_limit`]. É a tampa que a ADR 0018 chama de "1,5×acked", e está lá exatamente como descrita.
- Uma **sonda concluída ignora o AIMD e a tampa**: `DelayBasedBwe::MaybeUpdateEstimate` chama `rate_control_.SetEstimate(*probe_bitrate)` e, em `goog_cc_network_control.cc`, `SetSendBitrate(result.target_bitrate)` [F].

**Estimador por perda.**
- Legado: perda ≤ 2 % → sobe 8 % sobre o **mínimo da última 1 s**; 2–10 % → nada; > 10 % → `rate × (1 − 0,5·perda)`, no máximo uma vez por 300 ms + RTT [F: `send_side_bandwidth_estimation.cc`, `kDefaultLowLossThreshold`, `kDefaultHighLossThreshold`, `kBweDecreaseInterval`]. Depois dos 2 s da fase inicial (`kStartPhase`), e **enquanto o `LossBasedBweV2` não está em uso**, é este ramo que sobe o alvo, a no máximo 8 %/s sobre o mínimo do último segundo, qualquer que seja a estimativa por atraso [F: o estimador por atraso só entra como limite superior; as sondas escapam via `SetSendBitrate`]. Com o V2 ativo, a subida é regida por `MaxIncreaseFactor` 1,3 e pela tampa `BwRampupUpperBoundFactor` 1,5 [F nos valores, H em qual dos dois vale no Chrome do usuário].
- `LossBasedBweV2`: parâmetros-padrão do `main` incluem `BwRampupUpperBoundFactor` 1,5 (outra tampa em múltiplo do `acked`!), `MaxIncreaseFactor` 1,3, `InherentLossLowerBound` 1e-3, janela de 15 observações, uso na fase inicial ligado [F: `loss_based_bwe_v2.cc` l.408–478]. Se está ativo no Chrome do usuário depende do *field trial* `WebRTC-Bwe-LossBasedBweV2` [F: nome do trial; I: o estado no Chrome estável é desconhecido].

**Sondas (`probe_controller.cc`).**
- Inicial: dois clusters a `3 × S` e `6 × S` (S = o start bitrate), 100 ms cada, e continua a `2×` o resultado enquanto o resultado ≥ 0,7× o alvo [F: `first_exponential_probe_scale` 3, `second_exponential_probe_scale` 6, `initial_probe_duration` 100 ms, `further_probe_threshold` 0,7, `step_size` 2].
- **Todas as sondas são limitadas por `max_bitrate_`, que vale 5 Mbps (`kDefaultMaxProbingBitrate`) quando a aplicação não especificou máximo** [F: comentário "Applied only when the application didn't specify max bitrate", e `SetBitrates`: `max_bitrate.IsFinite() ? max_bitrate : kDefaultMaxProbingBitrate`]. O máximo vem de `x-google-max-bitrate` no `fmtp` ou de `b=AS` no SDP [F: `webrtc_video_engine.cc` `GetBitrateConfigForCodec`, `SetSdpBitrateParameters`]. Não achei nenhum dos dois em `sdp-tuning.ts`.
- Se há "total alocado" (soma dos máximos do encoder), o teto de sonda é `min(max, 2 × alocado)` [F]. Com a isca de 160×90 e `maxBitrate` explícito do `setParameters`, qual é o valor alocado ao sender é **[H]**: `encoder_stream_factory.cc` limita o máximo por resolução (`GetMaxDefaultVideoBitrateKbps`: 600 kbps para ≤ 320×240) a menos que haja `max_bitrate` configurado.
- Quando uma sonda re-dispara depois: subir `max_bitrate_` do Call (renegociação), aumento do total alocado (`probe_max_allocation`, padrão ligado) e sonda periódica em ALR (a cada 5 s, 2×) — esta só é pedida para conteúdo de tela [F: `alr_probing_interval` 5 s, `alr_probe_scale` 2]. O `contentHint = 'motion'` do Tela não é conteúdo de tela; o modo `nitidez` (`detail`) talvez seja [I].

**Pacer (`pacing_controller.cc`, `goog_cc_network_control.cc`).**
- Ritmo = `max(alocado mínimo, alvo atual por perda) × 1,1` depois do primeiro feedback; **× 2,5 antes** [F: `kDefaultPaceMultiplierWithSendSideBwe`, `kDefaultPaceMultiplier`]. Janela de burst de 40 ms com teto de 63 KB por burst [F: `PacerConfig::kDefaultTimeInterval`, `kMaxBurstSize`]. Não é configurável pelo JavaScript.

**Em síntese, o que o host "vê" por caminho** (campos de `getStats()` que o produto já lê ou pode ler): `availableOutgoingBitrate` do `candidate-pair` (é o **alvo** do controlador depois de combinar atraso, perda e limites — não é capacidade); `currentRoundTripTime`; no `outbound-rtp`: `nackCount`, `pliCount`, `retransmittedBytesSent`, `qualityLimitationReason`; no `remote-inbound-rtp`: `fractionLost`, `jitter`, `roundTripTime`. Nenhum campo diz se o alvo está limitado por atraso, por perda ou pela tampa de `1,5×acked`. O governador deduz a tampa por `enviado` (ADR 0018/0030).

### 1.3 O que os padrões oferecem, e o que isso muda para o Tela

| | GCC (rascunho rmcat) | libwebrtc hoje | NADA (RFC 8698) | SCReAM v1 (RFC 8298) | SCReAMv2 + L4S |
|---|---|---|---|---|---|
| Sinal | gradiente de atraso (filtro de Kalman) + perda | trendline + perda (legado/V2) + sondas | atraso de fila agregado + perda + ECN | atraso de fila + cwnd; ECN | atraso/ECN, janela; marcação L4S (RFC 9330/9331) |
| Subida | `η = 1,08^min(Δt,1)`; `A < 1,5·R` | idem + sondas 3×/6× | modo "ramp-up acelerado" γ = min(0,5; QBOUND/(RTT+DELTA+DFILT)) por feedback de 100 ms | `RAMP_UP_SPEED` 200 kbps/s | por janela (`ref_wnd`); sem constante de rampa fixa |
| Descida | `β = 0,85` (0,8–0,95) | idem | proporcional ao nível de congestionamento | `BETA_LOSS` 0,8; `BETA_ECN` 0,9 | `l4s_alpha/2` |
| Configurável de JS | — | **não** (só SDP/`setParameters`) | — | — | — |

[F] GCC: `draft-ietf-rmcat-gcc-02`, constantes `η = 1,08`, `A < 1,5·R`, `β = 0,85` (tabela do rascunho). NADA: RFC 8698 §4.3, tabela de parâmetros (`QBOUND` 50 ms, `DELTA` 100 ms, `DFILT` 120 ms, `GAMMA_MAX` 0,5). SCReAM v1: RFC 8298 §4.1.2, `RAMP_UP_SPEED` (200000 bps/s), `BETA_LOSS` (0,8), `BETA_ECN` (0,9).

**Tempo de rampa por modelo** (`estudo-transporte.mjs --parte=rampa`, RTT 40 ms, capacidade do caminho = 2×alvo [A]):

| S0 → T (Mbps) | só AIMD 8 %/s | sondas com teto padrão 5 Mbps + AIMD | sondas livres | NADA | SCReAM v1 |
|---|---|---|---|---|---|
| 0,3 → 12 | 47,9 s | 12,1 s | 1,0 s | 2,1 s | 59 s |
| 1,9 → 12 | 23,9 s | 11,6 s | 0,5 s | 1,0 s | 51 s |
| 1,9 → 6 | 14,9 s | 2,6 s | 0,2 s | 0,7 s | 21 s |
| 6 → 12 | 9,0 s | 9,2 s | 0,2 s | 0,4 s | 30 s |
| 12 → 16,2 | 3,9 s | 4,1 s | 0,2 s | 0,2 s | 21 s |

Dois fatos que o quadro mostra: (a) **a rampa pelo AIMD de 8 %/s é a mesma coisa, qualquer que seja a grade**: subir de 0,5·b para b leva sempre ln 2 / ln 1,08 = 9,0 s; (b) o teto padrão de sonda de 5 Mbps só ajuda abaixo de 5 Mbps. O modelo de sondas é aproximado (um cluster = 100 ms + 100 ms de feedback + RTT; não modela o tempo real do transport-cc nem a espera de 1 s de `kMaxWaitingTimeForProbingResult`).

**Conclusões práticas sobre os padrões.**
- *Trocar o algoritmo não é uma opção de JS.* O libwebrtc `main` já tem `ScreamV2` e uma `Ect1Policy` ("currently in development and not all features are yet implemented", `scream_v2.h`) e o feedback RFC 8888 atrás do trial `WebRTC-RFC8888CongestionControlFeedback` [F]. Não há como escolher o controlador de uma conexão a partir do JavaScript, e residências brasileiras não têm roteadores marcando ECN que eu possa citar [H]. **Nenhuma ação em 2026 (T10).**
- *O melhor padrão para o nosso caso não é um algoritmo, é um arranjo:* a **RFC 8699** (Coupled Congestion Control for RTP Media) trata exatamente de N fluxos com o mesmo remetente no mesmo gargalo, e propõe um estado compartilhado (FSE) para que o conjunto se comporte como um fluxo só. A R5 ("adaptação é coletiva") e o `UplinkGovernor` são a versão do Tela dessa ideia, só que ao nível de aplicação e sobre um **único encoder**. A RFC 8382 (detecção de gargalo compartilhado) dá o critério para saber quando dois caminhos compartilham o gargalo; no mesh, o gargalo do host é compartilhado por construção.

### 1.4 Como as malhas devem ler o BWE (e as alavancas de JavaScript)

**Regra de leitura (já é a do produto; o estudo a confirma contra o código).**

1. `availableOutgoingBitrate` é um *alvo*, igual a `min(estimativa por atraso, estimativa por perda, limites)`, e suas subidas são limitadas por `1,5 × acked` (AIMD) e, com o estimador de perda legado, por 8 %/s [F]. Dois limites diferentes: o primeiro vale para o estimador por atraso, o segundo para o alvo final. A ADR 0018 só tratou o primeiro; o segundo reforça a conclusão dela (a medição é limitada pela atuação) e explica por que a subida real é ≈ 8 %/s mesmo com a tampa de 1,5 folgada. **[I]** A hipótese é compatível com o que a ADR 0030 mediu ("o AIMD sobe 8 %/s e só encosta no teto de `1,5×acked` seis segundos depois").
2. O orçamento é um **mínimo entre caminhos** (R5), e um caminho recém-nascido só vota depois de aquecido (ADR 0030). Mantém-se.
3. Três regimes devem ser distinguíveis, e hoje só dois o são: *limitado por capacidade* (RTT sobe, `qualityLimitationReason = 'bandwidth'`), *limitado pela nossa atuação* (`enviado ≈ maxBitrate`; guarda `limitadosPorPixel`/`encoderOcioso`), e **limitado por perda aleatória** (`fractionLost` > 2 % com RTT plano). No terceiro, o alvo do caminho cai por causa do ramo de perda (acima de 10 %) ou do V2, **sem que a capacidade tenha mudado**, e o mínimo da R5 arrasta a sala inteira.

**Proposta T4 (classificar o caminho).** Marcar o caminho como "perda aleatória" quando, por ≥ 5 s, `remote-inbound-rtp.fractionLost` > 2 % **e** `currentRoundTripTime − RTT_mín` < 15 ms **e** `enviado ≥ 0,9 × maxBitrate`. Caminho assim: continua suavizado, **deixa de votar no mínimo por até 30 s**, e a sessão pede ao espectador mais J (T3) em vez de baixar a sala. Passou dos 30 s, vota de novo (um Wi-Fi ruim permanente é o caso "ou ele aguenta ou todos descem", como diz a R5). Risco: confundir perda por gargalo raso (buffer de roteador minúsculo, perda sem RTT inflado) com perda aleatória; por isso o `enviado ≥ 0,9 × maxBitrate`. **Não quantifiquei o ganho**: depende de quantos espectadores têm perda aleatória, que não sei. O simulador não modela perda por caminho; o experimento é acrescentá-la (§5.1).

**Alavancas disponíveis de JavaScript, e o que cada uma faz no código.**

| Alavanca | Efeito [F] | Efeito sobre rampa e oscilação | Risco / R5 |
|---|---|---|---|
| `x-google-start-bitrate` no `fmtp` remoto (já usado) | `start_bitrate_bps` do `Call` → início do estimador e base das sondas iniciais (3×, 6×) | O caminho nasce em S e não em 300 kbps; **S alto + teto de 5 Mbps = sondas iniciais cortadas ao teto** (S = 12 Mbps → sonda de 5 Mbps, inferior ao início; na prática, sem sonda) | Nenhum (idêntico entre peers) |
| `x-google-max-bitrate` / `b=AS` | `max_bitrate_bps` do `Call` → `max_bitrate_` do `ProbeController`; também clampa o alvo | Habilita sondas iniciais acima de 5 Mbps. **Custo:** um newcomer sonda a `3×S` e `6×S` por 100 ms cada. Em U = 100 Mbps, N = 10, S = 7,5 Mbps, a sonda soma até 45 Mbps durante 100 ms e provoca ~20 ms de fila nos vizinhos; um gradiente de 0,2 ms/ms é lido pelo trendline como sobreuso (`60 × 0,2 × 4 = 48 ms` > limiar de 12,5 ms) [I] | Idêntico entre peers → compatível com R5. Mas é uma **mudança de comportamento da ADR 0030** (a "porta" e o aquecimento por caminho foram calibrados sem sondas) |
| `x-google-min-bitrate` | piso do alvo | Mantém tráfego sobre um link que não comporta | Já rejeitada em `sdp-tuning.ts` (e bem) |
| `setParameters({maxBitrate})` | aloca ao encoder; **aumento do total alocado dispara sonda a 1× e 2× o alocado, no máximo 2× a estimativa atual** (`probe_max_allocation`) [F] | É o gatilho natural de uma "sonda de subida" sem SDP novo | Com a isca de 160×90 o "alocado" talvez seja minúsculo [H]. Medir em E1 |
| `networkPriority` | marcação DSCP | Nenhum sobre BWE | ADR já fixou `medium` (Wi-Fi AC_BK) |
| `priority`/`bitrate_priority` | peso entre senders **do mesmo `Call`** | Nenhum (cada `Call` tem 1 vídeo) | — |
| `degradationPreference`, `contentHint` | R5 | `detail` pode ligar a sonda periódica em ALR (5 s, 2×) [I] | R5 (modo `nitidez`) |
| *Field trials* via `--force-fieldtrials` (só Electron) | tudo o que está em `probe_controller.cc`, `aimd_rate_control.cc`, `alr_detector.cc`, `loss_based_bwe_v2.cc` | Granular: `WebRTC-BweBackOffFactor/Enabled-0.9/`, `WebRTC-Bwe-ProbingConfiguration/p1:2,p2:4,...`, `WebRTC-AlrDetectorParameters/...` | **Só o host desktop**: vale para os senders (que são o lado que estima). Frágil entre versões; precisa de teste que leia o efeito (E7). Que o Electron aceite os trials do WebRTC por linha de comando é **[H]** |

### 1.5 Convergência e oscilação: N controladores independentes no mesmo gargalo

- Cada um dos N caminhos lê o gradiente de atraso da **fila compartilhada** do roteador do host. Um pico de fila que um caminho vê (um IDR de outro, uma sonda) todos veem. [I] Isso sincroniza os recuos (`× 0,85` em todos no mesmo instante) e depois as subidas (8 %/s em todos): a soma oscila ±7,5 % com período ≈ `ln(1/0,85)/ln(1,08)` ≈ 2,1 s no AIMD puro. O `UplinkGovernor` (suavização 0,25, histerese de subir 6 % e cortar 30 %) amortece, e os "ciclos de ~30 s" que a ADR 0030 relata no `up5-n5` podem ser o efeito de segunda ordem desse laço **[H]**.
- **Mitigar sem tocar em R5:** (1) manter `enviado` abaixo de `0,75 U` (já feito; a folga é o amortecedor); (2) evitar picos de fila correlacionados (§3); (3) não somar sondas em hora de sala cheia (T6).

### 1.6 Ganho para a grade

O ramo "rampa de caminho novo" não depende de (N, U): depende de S e T. O que depende da grade é o tamanho do salto que o governador pede quando o orçamento sobe, e a duração da subida, 9 s para dobrar. A tabela de §1.3 vale para qualquer célula. **O ganho de T6 está em quanto da rampa de 24 s sobraria depois que a sonda cortasse os primeiros degraus**, e **o custo é o impacto nos vizinhos**; sem E1 não sabemos nem se as sondas estão ligadas. Por isso T1 vem antes de T6.

---

## 2. Resiliência a perda

### 2.1 O que o libwebrtc faz [F]

- **NACK/RTX:** até 100 tentativas, lista de até 1000 pacotes, histórico com idade máxima de 10 000 números de sequência (`nack_requester.cc`); histórico de retransmissão no sender com no mínimo 1 s e `3 × max(1 s, 3·RTT)` (`rtp_packet_history.h`). Um pacote é re-pedido depois de ≥ 1 RTT.
- **ULPFEC:** `rtp_video_sender.cc` `ShouldDisableRedAndUlpfec`: com NACK ligado e ULPFEC configurado, **desliga RED+ULPFEC se o codec não "suporta pular pacotes de FEC"**, e `PayloadTypeSupportsSkippingFecPackets` devolve verdadeiro **só para VP8 e VP9**. Para H.264 com NACK, o ULPFEC fica desligado ("is a waste of bandwidth since FEC packets still have to be transmitted").
- **FlexFEC** tem prioridade sobre ULPFEC quando configurado, e não sofre a restrição acima (o código diz "Note that this is not the case with FlexFEC") — mas exige o *field trial* nas duas pontas (anunciado, `WebRTC-FlexFEC-03-Advertised`; recebido, `WebRTC-FlexFEC-03`) [F: nomes dos trials do `main`, confirmados por memória do código e não por leitura nesta sessão: **[H]** para os nomes exatos].
- **RED para vídeo** no libwebrtc é apenas o invólucro do ULPFEC (`kRedForFecHeaderLength`, `rtp_sender_video.cc`); **não existe RED de vídeo com redundância de payload**. RED só é redundância de payload no áudio (Opus RED, RFC 2198; `red/48000/2` já aparece nos comentários de `sdp-tuning.ts`).
- **Detalhe da injeção:** com "um encode, N envios", o `RTCRtpScriptTransform` troca o `data` do quadro antes da pacotização, então a pacotização, NACK, RTX e (se houvesse) FEC continuam no sender [I; é onde o Encoded Transform está no pipeline, spec W3C]. NACK/RTX funcionam como hoje; **nenhuma FEC é possível sem trial**.

### 2.2 Custo em banda × latência (`estudo-transporte.mjs --parte=perda`)

Modelo (premissas [A], escritas no código): pacote de 1200 B, quadro P de ~26 KB = 22 pacotes, IDR = 8× = 173 pacotes; perda iid ou em rajada (Gilbert-Elliott, rajada média 3); detecção do buraco no pacote seguinte (cauda do quadro: +6 ms); NACK a cada RTT + 10 ms; **soluço = o quadro completa mais de J ms tarde**, e como é P→P, atrasa o seguinte; FEC = código MDS ideal por quadro (cota superior).

Soluços por minuto a 60 fps, quadro P, **J = 60 ms** (padrão), um salto, perda iid; [+x %] = banda extra:

| RTT | perda | NACK | NACK + FEC 10 % | NACK + FEC 25 % |
|---|---|---|---|---|
| 20 | 1 % | 0,8 [+1] | 0 [+10,3] | 0 [+25,3] |
| 20 | 5 % | 38 [+5] | 4,6 [+11,5] | 0 [+26,5] |
| 40 | 1 % | 16,7 [+1] | 0 [+10,3] | 0 [+25,3] |
| 40 | 2 % | 64 [+2] | 0,8 [+10,6] | 0 [+25,6] |
| 40 | 5 % | 376 [+5] | 46 [+11,5] | 0,7 [+26,5] |
| 80 | 1 % | 721 [+1] | 0,2 [+10,3] | 0 [+25,3] |
| 80 | 5 % | 2447 [+5] | 128 [+11,5] | 1,1 [+26,5] |

Com perda em **rajada** (mais próxima de Wi-Fi), o FEC por quadro perde boa parte do valor: RTT 40 ms, p = 2 %: NACK 63; FEC 10 % 34; FEC 25 % 15 soluços/min.

**O jitter buffer compra o mesmo que o FEC, sem banda.** NACK puro, quadro P, perda iid:

| RTT | perda | J = 60 | 80 | 100 | 130 | 160 | FEC 10 % com J = 60 |
|---|---|---|---|---|---|---|---|
| 40 | 1 % | 17,3 | 12,9 | 0,6 | 0,5 | 0 | 0,1 |
| 40 | 2 % | 63,4 | 47,3 | 3,3 | 2,3 | 0,1 | 1,4 |
| 80 | 1 % | 709,6 | 151,2 | 17,3 | 17,3 | 12,9 | 0,5 |
| 80 | 2 % | 1283,2 | 331,9 | 63,4 | 63,4 | 47,3 | 5,6 |

A regra que a tabela deixa à mostra: **uma rodada de NACK cabe em J só se J > RTT + ~25 ms; duas rodadas (a retransmissão também se perde) só se J > 2·RTT + ~35 ms.** Com RTT 80 ms e J = 60, *toda* perda vira soluço (neste modelo, 710/min a 1 %). O `JitterGovernor` hoje sobe depois de congelamento (`PASSO_SUBIDA_MS` 40, `PERDA_POR_AMOSTRA` 3), reativo; o RTT é conhecido de antemão.

**IDR.** Um IDR de 173 pacotes com perda iid de 1 %: 0,9 % dos IDRs soluçam com RTT 40, 28 % com RTT 80. Como o IDR do encoder único vai a **todos** os senders (ver §3), um soluço por IDR é um soluço da sala inteira.

### 2.3 Recomendações para 1080p60 gameplay

1. **NACK/RTX, sem FEC (T5).** O ULPFEC já está desligado para H.264 [F]; FlexFEC é inviável sem trial nos dois lados (o espectador é um navegador qualquer). Para não depender do comportamento do Chrome do dia, retirar `red`, `ulpfec` e `flexfec` das preferências de codec do transceptor (`setCodecPreferences` já é usado em `peer-link.ts:185`): custo zero de banda, ambiguidade zero de SDP.
2. **Piso do jitter buffer por RTT medido (T3):** `J_mín = RTT + 25 ms`; `J_mín = 2·RTT + 35 ms` quando `fractionLost` ≥ 1 %. É o mesmo mecanismo do `JitterGovernor`, só com o piso previsto. Custo: o RTT das conexões brasileiras na faixa 20–40 ms já cabem em 60–115 ms; só RTT ≥ 60 ms paga latência (≈ +30–50 ms), e é exatamente onde, sem isso, cada perda vira soluço.
3. **FEC só entraria** para RTT ≥ 80 ms e perda ≥ 1 %, e só se `J` não pudesse crescer; isso exigiria *field trial* de FlexFEC e não é viável para espectadores web. Fica registrado como "não".
4. **Quadros-chave:** o custo de perda em IDR (28 % de soluço com RTT 80 e 1 % de perda) é mais um argumento para IDRs raros e pequenos (Estudo 1) e para que a cascata atenda a PLI localmente (§4.7).

---

## 3. Pacing, MTU e bursts de IDR com N senders no mesmo uplink

### 3.1 Estado e premissa

- Cada `RTCPeerConnection` tem seu próprio pacer (§1.2). O `um-encode` entrega o **mesmo quadro** a todos os senders na mesma tarefa do worker, portanto os N pacers recebem o quadro dentro de poucos microssegundos. **[H]** Que disparem juntos, na prática, é o caso provável, mas não está medido: depende do agendamento das tarefas de pacing no Chromium.
- O pacer deixa sair `B0 = min(63 KB, 40 ms × R, S)` de uma vez, e o resto a `R = fator × estimativa`, com fator 1,1 (≈ 1,65 quando a estimativa está na tampa de `1,5×acked`) [F para os parâmetros do pacer; A para o fator 1,65].
- Pacote: o AIMD assume pacotes de 1200 B [F: `kPacketSize` em `aimd_rate_control.cc`]; o limite real de payload RTP de vídeo no `main` é próximo disso, valor exato **[H]**. O MTU não é parâmetro configurável de JS.

### 3.2 Fila no gargalo (`estudo-transporte.mjs --parte=pacing`, modelo fluido, N senders alinhados)

Quando o orçamento é usado por inteiro (N·b ≈ 0,75·U), o pico de fila do **quadro P** é **analiticamente** `N·S_P/U = (N·b/60)/U = 0,75/60 s = 12,5 ms`, independente de N e de U, e é o que a simulação dá (12,2–12,4 ms em todas as células em que b não bate no teto de 1080p). Para o **IDR** o burst fica limitado pela janela de 40 ms: `0,75 · 40 ms · fator` = 33 ms (fator 1,1) a 59 ms (fator 1,65). Onde o teto de 63 KB manda (host de 300 Mbps com poucos espectadores), o pico cai para `N·63 KB·8/U` (8–17 ms).

Exemplos (IDR = 8×P; fila de pico em ms):

| U | N | b (Mbps) | P alinhado | P, janela de 4 ms | P, janela de 16,7 ms | IDR alinhado (1,1×) | IDR escalonado por `S/R` | tempo do IDR por sender |
|---|---|---|---|---|---|---|---|---|
| 100 | 5 | 14,97 | 12,4 | 9,2 | 2,4 | 25,1 | 5,0 | 121 ms |
| 100 | 10 | 7,49 | 12,4 | 8,8 | 1,2 | 32,9 | 3,3 | 121 ms |
| 300 | 20 | 11,24 | 12,4 | 8,6 | 0,6 | 32,9 | 1,6 | 121 ms |
| 300 | 50 | 4,50 | 12,4 | 8,5 | 0,2 | 32,9 | 0,6 | 121 ms |

**O que isto diz:**

1. O alinhamento dos N senders custa **~12 ms** de fila por quadro P e **33–59 ms** por IDR; não é o gargalo de latência do produto. Escalonar os P-quadros (T7 estendido a todos os quadros) ganharia 4–12 ms e custaria até 16,7 ms de atraso nos últimos senders: **não vale**.
2. Escalonar só o IDR, ao longo da janela `S_idr/R`, reduz a fila de pico de 33–59 ms para 1–19 ms; mas o IDR de cada sender já leva 81–121 ms para sair, e escalonar atrasa o início do último em até outro tanto. **Troca latência de IDR por fila**; só vale se E5 mostrar que o pico de 33–59 ms dispara falso sobreuso nos vizinhos (o gradiente: 33 ms em ~50 ms, `60 × 0,66 × 4` ≫ limiar; **[H]**).
3. **O número que importa é outro:** `tempo do IDR por sender = S_idr/R = IDR_X/(60 · fator)` = **81–121 ms**, independente de U e de N. É maior que o jitter buffer inicial (60 ms). Todo IDR do encoder único, que chega a todos os senders, atrasa **todos os espectadores** em `≈ 20–60 ms` de soluço (IDR − J). A solução não está no transporte: IDR menor (intra-refresh, VBV por quadro, `IDR_X` de 8 para 3–4) ou IDR raro. Anotado para o Estudo 1.
4. **Pré-feedback o fator é 2,5** [F]: o IDR inicial de cada caminho novo sai a 2,5 × S, o que o encurta (121 → ≈ 53 ms).

**Alternativas ao escalonamento, em ordem de custo:** (a) não fazer nada (custo zero; ganho potencial ≤ 33–59 ms de pico por IDR); (b) amarrar o `JANELA_DE_CHAVE_POR_SENDER_MS` a N (já é: `40 × senders`, 2 s a N = 50); (c) escalonar IDR (T7); (d) a **cascata** reduz N no host de 50 para k ≤ 4–6, o que reduz o pico de IDR do host em 8–12× (`k_h·S_idr` em vez de `N·S_idr`, §4.7). A cascata resolve o problema, e é o quarto argumento a favor dela.

### 3.3 Bufferbloat e a regra dos 75 %

O modelo fluido acima é a fila **do host**. A fila do roteador doméstico (bufferbloat) é outra, e quem a protege é `UPLINK_SHARE = 0,75` (ADR 0015) e não o pacer: com 75 % de utilização, o RTT do jogo sobe de ~12,5 ms por quadro, mas não indefinidamente. **O modelo não cobre bufferbloat de roteador com buffer grande**; o simulador também não (premissa P3 do `malhas.sim.mjs`).

---

## 4. Topologia: cascata de repasse por espectadores

### 4.1 Levantamento

| Família | Ideia | Latência | Resiliência / churn | Serve ao Tela? |
|---|---|---|---|---|
| **Árvore única** (ESM/Narada, Chu et al.; grau limitado) | Cada nó repassa a `k` filhos | `d·h`, `d = O(log_k N)`; pequena | Saída de um nó interno derruba a subárvore; reconstrução necessária | **Sim**, é o caso (um encoder, b único) |
| **Multi-árvore, SplitStream** (Castro et al., SOSP 2003) | s árvores, cada nó é interno em uma e folha nas outras; a carga por nó é 1/s | `d·h` | Falha de um nó afeta 1/s do fluxo | **Não diretamente**: exige dividir o fluxo em stripes independentes. H.264 P→P não permite stripes por quadro; por pacote RTP o libwebrtc recompõe a pacotização por sender. Via SVC temporal sim, mas fere "60 fps sempre" (T9) |
| **Malha *pull*, CoolStreaming/DONet** (Zhang et al., INFOCOM 2005) | Vizinhos trocam mapas de buffer e puxam pedaços | segundos | Robusta | **Não**: o PPLive tinha atrasos de reprodução de **5 a 60 s** entre pares (Hei et al., medição) contra os ~150 ms do produto |
| **Híbrido** | Árvore para o grosso, *pull* para os buracos | segundos | Boa | Parcialmente: o *pull* de buracos é a nossa retransmissão por salto (NACK local) |
| **Limite de fluxo** | `r* = min{u_s, (u_s + Σu_i)/N}` (Kumar, Liu & Ross, INFOCOM 2007): taxa máxima que **todos** os N recebem se qualquer par repassa | — | — | Teto teórico contra o qual medir qualquer desenho |

[F] Os cinco títulos e venues foram conferidos hoje (Kumar–Liu–Ross: a taxa máxima de streaming depende só da capacidade da fonte, do número de pares e da capacidade agregada de upload; Zhang et al.: "CoolStreaming/DONet", INFOCOM 2005; Castro et al.: SplitStream, SOSP 2003; Hei et al.: atrasos de 5–60 s no PPLive). A afirmação de Liu (ACM MM 2007) de que heterogeneidade de banda melhora o atraso mínimo vem do resumo da busca, não do texto. As referências de Narada/ESM e de "altura mínima com graus heterogêneos por BFS decrescente" são de memória: **[H]**; o argumento de troca está em §4.4 para não depender delas.

A conclusão do levantamento é a de `complexidade.md` §D, e esta pesquisa a confirma: **árvore única com grau medido, profundidade limitada, e b único** é o desenho. Multi-árvore só entra se medirmos salas onde nenhum nó banca uma cópia inteira de 1080p (distribuição "pobre", host de 10 Mbps).

### 4.2 Limite de fluxo e o que ele diz do Tela

Para os cenários de `complexidade.md` §D5 o limite é muito acima do que precisamos (1080p60 no teto = 16,2 Mbps): hosts de 50 Mbps e espectadores típicos têm `r*` ≈ 37 Mbps. **O que decide não é o limite de fluxo, é o grau que cada repassador banca** — e que o limite de CPU/uplink do repassador seja honesto (0,2 núcleo por filho a 1080p60, medido no D0b; 1,2 núcleo para `k = 6`).

### 4.3 Premissas das distribuições de upload

**Dados com fonte (checados hoje por busca, não conferidos na fonte primária):** mediana de banda larga fixa no Brasil ≈ 222 Mbps de download (Ookla, dezembro de 2025/março de 2026); fibra ≈ 66 % dos acessos fixos e velocidade contratada média ≈ 447 Mbps (painel da Anatel, 2024). **O que não tem fonte é a razão upload/download** e a fração de espectadores em celular ou ADSL. Os pesos abaixo são a nossa leitura **[A]**; as três distribuições cobrem o plausível, e quem tiver dados melhores troca os pesos em `DISTRIBUICOES` de `estudo-topologia.mjs`.

| Subida bruta (Mbps) | 10 | 25 | 50 | 100 | 300 |
|---|---|---|---|---|---|
| **típica** | 15 % | 20 % | 30 % | 25 % | 10 % |
| **pobre** | 40 % | 25 % | 20 % | 10 % | 5 % |
| **fibra** | 5 % | 10 % | 25 % | 40 % | 20 % |

### 4.4 Construção da árvore: algoritmo e prova de adequação

Notação: `b` = bitrate por cópia (uma só para a árvore, R5); `u_i` = subida bruta medida; **o host banca `k_h = ⌊(0,75·u_h − 141 kbps)/b⌋` cópias; um repassador, `k_i = min(K_MAX, ⌊(f·u_i − 141 kbps)/b⌋)`** com `f` = fração que ele cede ao repasse (resto é do jogo e da call dele) e `K_MAX` = teto de filhos (CPU). Referência do estudo: `f = 0,5`, `K_MAX = 6`; conservador: `K_MAX = 4`.

**Algoritmo `montarArvore(host, viewers, b, Dmax)`:**
1. `k_i` para cada espectador; os com `k_i = 0` são folhas.
2. Ordenar por `k_i` decrescente.
3. BFS por níveis: o nível 1 tem `k_h` vagas, os próximos `k_h` espectadores (maiores `k`) entram; as vagas do nível 2 são `Σ k_i` do nível 1; e assim até `Dmax`.
4. Distribuir os filhos de cada nível em rodízio entre os pais com vaga (balanceia carga; `k_i` nunca é excedido).
5. Escolher o **maior b** da escada (teto, ponto médio e piso de cada degrau) para o qual todos cabem em profundidade ≤ `Dmax`; se nenhum cabe, vale a porta da ADR 0030.

**Por que é ótimo em profundidade (esboço do argumento de troca).** Numa árvore factível em que um nó `x` de grau menor está acima de um nó `y` de grau maior, trocar os dois mantém a árvore factível e não aumenta a profundidade: as vagas do nível seguinte a `x` crescem `k_y − k_x`, as do nível seguinte a `y` diminuem o mesmo tanto, mas os filhos de `y` que as ocupavam podem subir para as vagas novas, um nível acima. É a construção clássica de "altura mínima com restrição de grau"; **escrito de memória, sem referência conferida [H]**.

### 4.5 A matemática para a grade, com distribuições sorteadas

`estudo-topologia.mjs`: 1000 salas por célula; profundidade ≤ 3; salto 40 ms; relé só se subida ≥ 25 Mbps; `f = 0,5`, `K_MAX = 6`. **b é a mediana, em Mbps por espectador, de UM valor para a sala inteira.** Malha: a conta de hoje (`(0,75·U − 141 kbps)/N`, degrau pela escada). "Afoga" = abaixo do piso de 360p60 (1,9 Mbps).

**N = 50** (`típica` / `pobre`):

| host U | malha b | malha admitiria (porta, piso 1,9) | árvore b | árvore ≥ 720p60 | profundidade | repassadores | upload do host usado | maior subárvore | latência extra |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 0,1 / 0,1 | ≈ 3 | 3,6 / 3,6 (K=6); **2,2** (K=4) | 0 % | 3 | 14 | 7,2 Mbps | 25 | +120 ms |
| 50 | 0,7 / 0,7 | 17–19 | **16,2 / 11,9** | 100 % / 100 % | 3 | 14–19 | 32–36 | 18–25 | +120 ms |
| 100 | 1,5 / 1,5 | 35–39 | **16,2 / 12,4** | 100 % | 3 | 22–26 | 65–71 | 11–13 | +120 ms |
| 300 | 4,5 / 4,5 | 50 | **16,2 / 16,2** | 100 % | 2 | 13–14 | 210 | 4–6 | +80 ms |

**N = 20** (`típica` / `pobre`):

| host U | malha b | árvore b | profundidade | repassadores | upload do host | maior subárvore | latência extra |
|---|---|---|---|---|---|---|---|
| 10 | 0,4 | **7,2 / 7,2** (720p60) | 3 | 7 | 7,2 | 20 | +120 ms |
| 50 | 1,9 | **16,2 / 12,4** | 3 | 8 | 32–36 | 9–10 | +120 ms |
| 100 | 3,7 | **16,2 / 14,3** | 2–3 | 4–6 | 65–71 | 5–6 | +80 a +120 ms |
| 300 | 11,2 | **16,2 / 16,2** | 2 | 7 | 210 | 2 | +80 ms |

**Sensibilidade ao que o repassador cede** (N = 50, distribuição `pobre`, host de 50 Mbps): `f = 0,75, K_MAX = 99` → 16,2 Mbps; `f = 0,5, K_MAX = 6` → 11,9; `f = 0,5, K_MAX = 4` → 9,1; `f = 0,35, K_MAX = 4` → 8,1. O resultado **não é frágil** (mesmo o caso conservador entrega 8,1 Mbps, acima do piso de 720p60, contra 0,7 da malha); o que é frágil é o host de 10 Mbps com N = 50, que depende de `K_MAX` (3,6 → 2,2 Mbps).

**Contra o limite de fluxo:** `r*` mediano 7,4 (host de 10) a 96,8 Mbps (fibra, host de 300, N = 20); a árvore única de profundidade 3 entrega entre 2,2 e 16,2 Mbps (limite superior da escada). Onde a árvore entrega menos que `r*` e menos que o teto da escada (N = 50, host de 10, `pobre`: 3,6 contra 7,4), existe espaço para T9 (stripes) e só aí.

**Profundidade 2 (um nível de repassadores):** com N = 50, host de 50 Mbps: b = 4,3 Mbps (típica), 4,3 (pobre); host de 100 Mbps: 9,1 / 8,1; host de 300 Mbps: 16,2 / 14,3; host de 10 Mbps: sem solução (100 % das salas). A profundidade 3 vale a latência de +40 ms quando o host é de 50 Mbps ou menos.

### 4.6 Latência por salto

Um repassador que injeta o quadro recebido no Encoded Transform de **recepção** em senders próprios opera em **granularidade de quadro** (store-and-forward), não de pacote: o quadro só pode ser reinjetado depois de montado.

Componentes de um salto, quadro P, caso sem perda [I]:

| Componente | Valor |
|---|---|
| Propagação (RTT/2 dentro do Brasil) | 5–25 ms |
| Montagem: o quadro só está completo quando seu último pacote chega (serialização do pai) | `S/R` ≈ 10–15 ms (fator 1,1–1,65) |
| Reinjeção no worker (`postMessage`) | < 1 ms |
| Repacing do filho | já contado como serialização do próximo salto |
| **Total por salto** | **≈ 25–45 ms** (a faixa de 25–50 ms de `complexidade.md` §D3 se confirma) |

**Mas** com perda real o custo por salto sobe: o jitter buffer da **folha** precisa absorver a soma das recuperações dos saltos (§2.2). Com 1 % de perda e RTT de 40 ms por salto: J ≈ 100 / 140 / 180 ms para d = 1 / 2 / 3 deixa os soluços abaixo de 1 por minuto (com `J = 60`: 16 / 154 / 365 por minuto). **Latência extra realista sob perda de 1 %: ~(40 + 40) × d ms** = 80 / 160 / 240 ms. Em IDR, +80–120 ms por salto (serialização do IDR a `S/R`).

**Comparação com o produto:** a latência de ponta a ponta de hoje é ~150 ms (AGENTS.md). Depth 2: ~230 ms (sem perda). Depth 3: ~270 ms. Perda de 1 %: 310–390 ms. **Continua sub-segundo**, e o espectador está numa call de voz paralela; 80–120 ms de atraso de imagem em relação à voz é perceptível para quem conversa sobre o jogo, mas não é decisivo: esta é uma decisão de produto, não de engenharia. Medir em E2.

### 4.7 O desenho concreto

#### Papéis

- **Host:** raiz. Encoder único (como hoje, `FilaDeInjecao`, `CodificadorWebCodecs`), `k_h` filhos. **Dono da topologia.**
- **Repassador (relay):** espectador com `k_i ≥ 1`. Recebe o vídeo como qualquer espectador e **também reinjeta o quadro codificado nos seus senders filhos**, sem recodificar. Decodifica para si mesmo.
- **Folha:** espectador com `k_i = 0`, ou sem filhos atribuídos. É o espectador de hoje.

#### Caminho dos dados num repassador

```text
pai ──► RTCPeerConnection(pai) ── receiver ── RTCRtpScriptTransform (recepção)
                                                   │ quadro codificado (RTCEncodedVideoFrame)
                           ┌───────────────────────┤ continua para o decoder do próprio repassador
                           ▼ (cópia dos bytes + metadados, postMessage)
                  injecao-worker (reaproveitado: FilaDeInjecao, IDR na ponta, contrapressão)
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   sender filho A    sender filho B    sender filho C   (isca 160×90 + Encoded Transform de envio, como no host)
```

- A **peça nova** é trocar a fonte do `FilaDeInjecao`: no host é o `VideoEncoder`; no repassador é o transform de recepção. O resto (isca, `new RTCEncodedVideoFrame(frame, options)`, IDR na ponta para quem entra, contrapressão, remoção de sender morto) é do D0b/produto. O spec proíbe mover o mesmo objeto de quadro entre senders mas permite criar um novo com os bytes e metadados (`RTCEncodedVideoFrame(originalFrame, options)` está no W3C) [F].
- **Metadados a preservar:** `rtpTimestamp`/`captureTime` da origem (medida de latência ponta a ponta e sincronismo de áudio), `frameId` e dependências quando o `RTCEncodedVideoFrame` os expõe. Isso é **[H]**: o que o Chromium 152 expõe na recepção.
- **Áudio** também desce pela árvore (Opus pelo mesmo mecanismo): 128 kbps × 50 espectadores = 6,4 Mbps no host é inaceitável a 10 Mbps. É o que o `AUDIO = 141 kbps` por cópia da conta já assume.
- **NACK/RTX é por salto**, entre pai e filho, contra o histórico de retransmissão do sender do pai (≥ 1 s [F]): recuperação local com RTT_h pequeno, em vez do RTT até o host.

#### Admissão de repassadores por upload medido

- `TesteDeRede` (`adapters/browser-sonda-de-rede.ts`, `core/media/sonda-de-rede.ts`) já mede subida. **Candidato a repassador = subida medida ≥ 25 Mbps**; só é usado quando `k_i(b) ≥ 1` ao `b` do momento (a b = 16,2 Mbps isso exige `u ≥ (16,2 + 0,14)/0,5` ≈ 33 Mbps; a b = 12 Mbps, 25 Mbps bastam), mais **ceder = verdadeiro** (opt-in explícito: "ajudar a transmitir" — a pessoa é gamer, tem jogo e call no mesmo link).
- Capacidade dinâmica: o repassador reporta `enviado` e `cpu`; o host recalcula `k_i` com `min(b_i, 0,75 × enviado)` por caminho (a mesma regra da ADR 0030, aplicada por repassador), e **`capacidade` do canal passa a ser `k_h + Σ k_i` ao `b` atual**, menos 1 vaga reservada de folga.

#### Mudanças de sinalização — R8 intacta, servidor intocado

O servidor só deixa o espectador falar com o host: `resolveTarget` devolve `channel.host` para `role === 'viewer'` (`apps/signaling/src/channel-registry.ts:481`), e `payload` é opaco [F]. Logo:

- **O host é o concentrador de sinalização.** Um espectador que precisa negociar com o pai manda `signal` ao host com `payload = { tipo: 'via', para: <peerId>, dados: <SDP/ICE> }`; o host responde com `signal { to: <peerId>, payload: { tipo: 'via', de: <peerId filho>, dados } }`. O servidor não parseia, não muda a versão do protocolo (as mensagens do canal são JSON opaco).
- **Decisão de topologia vive no host** (R8): mensagens `{ tipo: 'pai', pai: <peerId>|'host', reserva: <peerId>|null, epoca: n }` do host ao espectador. A `epoca` descarta mensagens atrasadas após um reparentamento.
- **Relatórios para cima**, a cada 1 s, de cada repassador ao host: `{ epoca, filhos, orcamentoMin, enviado, cpu, atrasoDeQuadro }` — ~100 B × até 26 repassadores = 2,6 KB/s no WebSocket do host, desprezível.
- O servidor continua a aplicar `capacidade` (`teto = min(servidor, máquina, banda)`, ADR 0030) sobre o número **total** de espectadores; só o valor que o host calcula muda.
- Alternativa descartada: deixar o servidor rotear espectador-a-espectador. Muda o contrato do servidor e ampliaria a superfície de abuso; o hub no host custa um salto de WebSocket (~20–100 ms) na **negociação**, não na mídia.

#### Agregação de PLI/IDR

- Hoje, a janela de coalescência do IDR é `max(500 ms, 40 ms × senders)` (`fila-de-injecao.ts`), 2 s a N = 50. Com a cascata os senders do host são `k_h ≤ 12`: **janela de 500 ms**, e o IDR custa `k_h × S_idr` no uplink do host em vez de `N × S_idr`: com N = 50, 4× a 12× menos.
- **Repassador atende PLI do filho localmente** quando tem um IDR recente no `FilaDeInjecao` (`QUADROS_GUARDADOS` 180 = 3 s): reenvia o último IDR e os P que o seguem, em rajada, até a ponta. Custo: o atraso do IDR + `Σ P` desde ele; se o IDR tem ≤ 1 s, são ≤ 60 quadros ≈ 1,5 MB a 12 Mbps: ~120 ms a 100 Mbps de descida. Se o IDR guardado tem mais que 1 s, o PLI sobe: `sendKeyFrameRequest()` do `RTCRtpScriptTransformer` de recepção (existe no W3C) [F], com o mesmo limite de 1 por 500 ms, agregando os PLI dos irmãos num pedido só. **Decisão de design pendente:** IDR periódico no host (a cada 2–4 s) para que o cache dos repassadores seja sempre recente, ao custo de ≈ `(IDR_X − 1) × S_P / G` ≈ 7,5 % do bitrate a G = 2 s [A].

#### Falha de repassador

| Fase | Sem pai reserva ("frio") | Com pai reserva ("quente") |
|---|---|---|
| Detecção | quadros ausentes por ≥ 500 ms no transform de recepção, com ICE ainda `connected` (hoje `MEDIA_GRACE_MS` = 8 s) | idem |
| Sinalização e ICE | 2 × RTT do WS (50–300 ms) + ICE 100–500 ms + DTLS ≈ 2 RTT (≈ 0,1 s) | já feitos (conexão em espera) |
| Primeiro IDR | cache do novo pai ≤ 0,1 s ou PLI até o host ≈ 0,5–0,7 s | idem |
| **Total** | **≈ 1,2–2,0 s** | **≈ 0,7–1,2 s** |

[I] Todos os valores são estimativas aritméticas; E4 mede. O custo da conexão em espera: memória e keep-alive de uma `RTCPeerConnection` ociosa por filho (≈ 20–30 % do custo de uma ativa, [H]) e **1 vaga reservada** no pai de reserva (o host contabiliza). Alternativa barata: pai reserva = **o próprio host** (já tem a conexão de sinalização e aceita um filho a mais), preferido enquanto `k_h` permitir.

**Quanto isso importa** (`estudo-topologia.mjs`, permanência média 45 min, uma queda por repassador a cada 45 min, afeta a subárvore inteira): **1,3–2,6 eventos por espectador por hora** (N = 50, profundidade 2–3). Com religação a 0,7–1,2 s (quente), ≈ 1–3 s sem imagem por espectador por hora; com 1,2–2 s (frio), ≈ 2–5 s. Na malha pura, um espectador só perde a imagem se o host cai.

#### Adaptação coletiva (R5) numa árvore

- **b continua único**: um encoder só. Cada aresta carrega uma cópia, de modo que **as arestas são comparáveis** e o mínimo faz sentido: `b ≤ min_arestas(orçamento_aresta)`.
- Cada **pai** lê o BWE das suas arestas (como o host hoje) e aplica a regra da ADR 0030 (`min(b, 0,75 × enviado)`, aquecimento por caminho, sonda por colapso); o host recebe o **mínimo reportado** dos repassadores e os dos seus filhos diretos. O `UplinkGovernor` do host passa a ver "caminhos" = arestas do host + resumos de repassador. Nada em `UplinkGovernor` muda de natureza; só passa a ter mais entradas.
- **A árvore dá uma terceira opção à R5**, além de "ou ele aguenta ou todos descem": **ele muda de lugar.** Se uma aresta de um repassador degrada (tráfego cruzado do jogo dele), a ordem de resposta é: (1) o host reduz `k_i` desse repassador e reparenta o excesso sob outro repassador com folga; (2) se nenhum tem folga, desce-se um degrau coletivo, como hoje. Só (2) fere o b de todos.
- **A atuação é medida pela própria atuação (ADR 0018)**: o `enviado` de cada repassador é o que ele de fato manda, então a tampa de `1,5×acked` reaparece em cada pai, e a regra `min(b, 0,75 × enviado)` precisa valer em cada um. O simulador precisa modelar isso (§5.1).

#### Riscos que o desenho carrega

1. **Exposição de IP entre espectadores.** Na malha, só o host vê os IPs dos espectadores; na cascata, cada filho e cada pai veem o IP um do outro (ICE direto). É uma mudança de modelo de privacidade (ADR 0021/0028 salas por convite/abertas) que precisa de decisão do dono. Mitigação: política `relay` de TURN nas arestas entre espectadores (custo de cota TURN, ADR 0007 e `relayStatus`), ou só admitir repassadores em salas de convite.
2. **Integridade.** Um repassador malicioso pode congelar, atrasar ou **alterar** o vídeo da subárvore (os quadros H.264 não são assinados). Mitigação possível, não avaliada: o host acrescenta uma assinatura Ed25519 por quadro num SEI `user_data_unregistered` (decoders ignoram SEI desconhecido); a folha verifica com a chave pública do host recebida na sinalização, e se falhar por ≥ 500 ms reparenta ao host. **[H]**: SEI de usuário atravessa o Encoded Transform e o depacketizer do Chromium sem ser removido; E-nenhum o cobre, é item de pesquisa.
3. **O repassador joga.** Os 6 filhos custam 1,2 núcleo (0,2/filho, D0b) e 6 × 16 Mbps = 97 Mbps de upload; com `f = 0,5` o uplink dele fica a ≤ 50 % e `K_MAX = 4` limita a CPU a ~0,8 núcleo. O repassador **precisa** de um botão "parar de ajudar" e de uma regra de saída automática por `cpu`/`atrasoDeQuadro` (o `StatsSampler` já lê CPU).
4. **Churn de repassadores:** 1,3–2,6 quedas/espectador/h (§4.7). A reconstrução periódica da árvore (a cada 30 s só se o ganho for ≥ 1 nível ou ≥ 20 % de b) deve ser mais lenta que a rampa do AIMD para não oscilar.
5. **Complexidade:** nova classe pura em `core/` (a árvore, `core/mesh/arvore-de-repasse.ts`), uma `SessaoDeRepasse`, mudança na fonte do worker de injeção, mensagens de sinalização de aplicação, simulador estendido e ADR. **Estimativa** de esforço: 3–5 semanas de uma pessoa (**[H]**, sem base de medição).

#### Compatibilidade com R1–R8 e com as ADRs

- **R1/R3:** a árvore e a sessão de repasse ficam em `core/` puras; o worker e o transform ficam em `adapters/`. **R2:** nenhum SDK novo. **R4:** perda de pai, árvore sem lugar, `CHANNEL_FULL` por banda: `Result`/`AppError` literais, sem `throw`. **R5:** b único, parâmetros idênticos entre senders de um mesmo pai (mesma isca, mesmos parâmetros do `Call` e do transform); a regra "todo degrau tira pixel" intacta (não mexe na escada). **R6:** nada de chat/voz/contas; é infraestrutura de transporte, mas "múltiplos transmissores" não se aplica. **R7:** sem barrel. **R8:** o servidor continua sem parsear; o host é o hub.
- **ADR 0005 (mesh):** é a evolução natural (a ADR já diz "mesh P2P" para ≤ 5; a 0029 o estende para 50 por "um encode"). **ADR 0029/0030:** a porta pela banda é generalizada, não substituída (`capacidade` passa a somar vagas de repassadores).

### 4.8 Resumo da proposta T2

**Fase 1 (profundidade ≤ 2, host como pai reserva):** só repassadores medidos e opt-in; árvore montada pelo host; sem repasse de áudio separado (áudio desce pela árvore por Encoded Transform); sem assinatura; sem IDR periódico (PLI local do cache). **Ganho:** hosts de 100 Mbps com 50 pessoas passam de 1,5 Mbps (abaixo do piso de 360p60, 1,9 Mbps) para 8,1–9,1 Mbps (720p60); hosts de 300 Mbps para 14–16 Mbps. **Fase 2:** profundidade 3, pai reserva quente, IDR periódico, e relatórios por repassador no governador. **Fase 3 (condicional):** stripes por camadas temporais.

---

## 5. Plano de validação

### 5.1 Estender `e2e/malhas.sim.mjs` para repassadores

O simulador já tem tudo o que importa: o modelo de rede (`Rede`, l.251; `tique`, l.294: demanda = `min(BWE, maxBitrate)`, partilha max-min do uplink, AIMD com tampa `1,5×acked`, ruído de ±20 %, recuo para `0,85 × enviado`) e a sessão REAL (`BroadcastSession` + `UplinkGovernor` + `MeshTopology` + `StatsSampler`). O que falta é **topologia** e, para T4, **perda** e **fila**.

**Mudanças propostas** (não implementadas aqui; o arquivo existente não foi tocado):

1. **`peers[].pai`** (id ou `'host'`), **`peers[].upBps`** (subida do próprio espectador; já existe `downBps`). Cada nó com filhos tem seu uplink compartilhado max-min entre os filhos.
2. **`tique` em ordem BFS** (pais antes dos filhos). A demanda da aresta `(pai → filho)` vira `min(bwe, maxBitrateAplicado, recebido(pai))`, com `recebido(host) = ∞` e `recebido(repassador) = carregado da aresta de entrada`. É a propagação "o filho não recebe mais do que o pai tem".
3. **A leitura do host** passa a ser o mínimo sobre as **arestas dos filhos do host** e dos resumos dos repassadores (atrasados 1 s, como o relatório real). `SimTransport.getStats` devolve para cada aresta o `availableOutgoingBitrate` ruidoso, como hoje; os repassadores aplicam a regra da ADR 0030 localmente e reportam o orçamento mínimo.
4. **Eventos de topologia no cenário:** `saidaDeRepassador(t, id)` (a subárvore fica sem fonte por `T_rec` = 0,7 / 1,2 / 2,0 s, e depois reparenta), `entrada(t, id)` com a política de colocação da §4.4.
5. **Métricas novas** além das já usadas: tempo sem imagem por espectador; bpp por aresta; "aresta afogando" (> 10 % do tempo pedindo mais que o link da aresta); número de reparentamentos; latência acumulada = `profundidade × h`.
6. **Premissas novas em `PREMISSAS`:** (P9) a aresta repassa em granularidade de quadro; (P10) o repassador nunca recodifica; (P11) a CPU do repassador limita `K_MAX`; (P12) o repasse só falha por saída, não por Wi-Fi.
7. **Perda por caminho (T4):** `Rede` ganha `perda(i)` por caminho, que reduz `acked` e, no ramo legado, `bwe *= 1 − 0,5·perda` acima de 10 % e `bwe` plano entre 2 e 10 % [F: a regra de `send_side_bandwidth_estimation.cc`]. Cenário: um espectador de 4 % de perda entre 10 normais; critério: o mínimo da sala não cai mais do que 10 % por mais de 30 s com T4 ligado.
8. **Fila (§3):** acrescentar `fila(t)` por quadro com o `filaMax` de `estudo-transporte.mjs` como premissa de pico, e um sobreuso falso do trendline quando a fila passa de 30 ms em 50 ms: serve para testar T7 em cenários de sala cheia.
9. **Sondas (T6):** um modo `--sondas` em que a entrada de um caminho produz um salto instantâneo da estimativa (sonda 3×/6× limitada por `maxBitrateProbe` ∈ {5 Mbps, ∞}) e uma carga transitória de `6 × S × 100 ms` no uplink, que o `partilhaMaxMin` já sabe tratar como demanda.
10. **Portões:** nenhum estado absorvente; "afogando" ≤ o da malha; **b mediano ≥ o da malha em 100 % das células**; tempo sem imagem ≤ 5 s/espectador/h; latência acumulada ≤ 400 ms.

### 5.2 Experimentos em navegador real

Todos em máquina Linux com `ip netns` + `tc netem` (precisa de root; `e2e/banda.e2e.mjs` já registra que o CDP não estrangula uma conexão aberta). Critério comum: **mediana de ≥ 5 repetições** e a máquina identificada (como os benches).

| # | Pergunta | Montagem | Medida | Passa se |
|---|---|---|---|---|
| **E1** | As sondas de banda rodam nos caminhos do Tela? Qual a rampa real? | Host + 1 espectador, `netem rate` 100 Mbps, RTT 40 ms. 3 execuções: padrão; com `x-google-max-bitrate=40000`; com `b=AS:40000` | `availableOutgoingBitrate` a **5 Hz** desde a conexão (o `e2e/qualidade.e2e.mjs` já tem a rampa do encoder a 5 Hz, l.562–590); contagem de saltos ≥ 2× | Rampa de **degraus** (sondas) vs **exponencial de 8 %/s** (AIMD). Se for AIMD até 12 Mbps, as sondas estão presas a 5 Mbps e T6 é aplicável |
| **E2** | **Latência de dois saltos com repassador** (a prova do desenho) | 3 Chrome: A (host), B (repassador), C (folha). A desenha um **contador de quadro** em pixels (padrão binário 16 bits) e grava `performance.timeOrigin + performance.now()` por quadro; B reinjeta; C lê o contador via `requestVideoFrameCallback` + o mesmo relógio (mesma máquina, ±1 ms) | Latência `A→B`, `A→C` (e `B→C` por diferença) a RTT 20/40/80 ms entre pares, perda 0/1/2 %, 60 s cada | `A→C − A→B ≤ 60 ms` a RTT 20 ms sem perda (≈ `h`); `≤ 160 ms` a 1 % de perda com J do `JitterGovernor`; 0 congelamentos sem perda |
| **E3** | Custo de CPU de um repassador a 1080p60 com k = 1, 2, 4, 6 filhos | Host (sintético, 1080p60) + repassador + k folhas, `top`/`perf stat` por processo; cenário com um jogo rodando (carga sintética) | núcleos do repassador e FPS do jogo de carga | ≤ 0,25 núcleo por filho; FPS do jogo cai ≤ 5 % com `K_MAX = 4` |
| **E4** | Tempo de religação: frio × quente, e o impacto da sonda de entrada | Matar o processo do repassador (SIGKILL) com 6 folhas; reparentar para o host (frio) ou para a conexão em espera (quente). Em paralelo: entrada de um novo espectador numa sala de 10, com e sem `x-google-max-bitrate` | tempo sem quadro novo (watchdog de 250 ms no transform); `availableOutgoingBitrate` dos vizinhos durante a entrada | Frio ≤ 2,0 s; quente ≤ 1,2 s; a entrada não corta o `availableOutgoingBitrate` dos vizinhos em mais de 15 % |
| **E5** | Fila do host e IDR: o pico alinhado dispara sobreuso falso? | `tcpdump` no gargalo (netem `rate 50 Mbit`, buffer grande), N = 10 senders; medir a série de fila por quadro P e por IDR; ler `availableOutgoingBitrate` dos 10 caminhos | pico de fila vs 12,5 ms (P) e 33–59 ms (IDR) previstos; quedas simultâneas de BWE nos 10 | previsão dentro de ±30 %. Se houver queda simultânea dos 10 em cada IDR, T7 sobe de prioridade |
| **E6** | O piso do `JitterGovernor` por RTT (T3) | Host + espectador, `netem delay 40/80 ms loss 1/2 %`, 5 min; comparar `JitterGovernor` atual × com piso RTT + 25 ms/2·RTT + 35 ms | soluços por minuto (`freezeCount` do espectador), latência média | soluços/min ≤ 1/10 do atual a RTT 80 ms e 1 %; latência +≤ 50 ms |
| **E7** | O Electron aceita *field trials* do WebRTC por linha de comando? | `--force-fieldtrials="WebRTC-BweBackOffFactor/Enabled-0.9/"` e conferir a recuperação do AIMD num colapso induzido | recuo em 0,9 em vez de 0,85 | Efeito visível na série do BWE |

**Cabe a humanos (como diz o AGENTS.md):** latência glass-to-glass com câmera a 240 fps (E2 mede um proxy pelo relógio compartilhado), hardware encode, impacto no FPS do jogo real com MangoHud (E3 usa carga sintética) e a taxa de sucesso de ICE entre espectadores atrás de CGNAT brasileiro (o ganho da cascata depende de duas pontas diretas entre espectadores; **sem TURN, as arestas entre espectadores podem falhar mais que as arestas para o host** [H]).

---

## 6. O que não foi verificado e o que pode estar errado

| Item | Estado |
|---|---|
| Que os N pacers disparem juntos | [H]; E5 |
| Que o Chrome 152 / Electron 44 tenham as mesmas constantes do `main` | [I]; E1 e E7 |
| Que as sondas iniciais estejam limitadas a 5 Mbps nos nossos caminhos | [F] no código; [I] no binário real; E1 |
| O "alocado" do sender-isca e seu efeito no teto de sonda (2×alocado) | [H]; E1 |
| `LossBasedBweV2` ligado ou não no Chrome estável | [H] |
| Que `RTCEncodedVideoFrame` exponha, no receptor, metadados suficientes para reinjetar com continuidade de `frameId` e dependências | [H]; E2 |
| Latência por salto de 25–45 ms; 80–120 ms de IDR; recuperação de falha 0,7–2,0 s | [I]; E2 e E4 |
| Distribuições de upload (pesos) | [A]; só os 222 Mbps de mediana (Ookla) e os 66 % de fibra (Anatel) têm fonte, e sem checagem na fonte primária |
| Esforço de 3–5 semanas | [H] |
| SEI assinado atravessa o Chromium | [H] |
| `Narada/ESM` e "altura mínima por BFS" citados de memória | [H] |
| O modelo de perda assume NACK/RTX independentes com a mesma p, otimista para rajada | [A] |
| O modelo de pacing é fluido e determinístico: sem jitter de agendamento | [A] |

**Decisões deste estudo não cobertas pelos documentos:** (1) usei `f = 0,5` e `K_MAX = 6` como referência do repasse, e não 0,75 como a escada do host, porque o repassador também é um jogador (a diferença muda b de 16,2 para 11,9 Mbps no pior caso, e está na sensibilidade); (2) tratei IDR_X = 8, no meio dos 6–10× publicados pelo Discord e citados no código do Tela; (3) tratei `T_rec`, `h` e `permanência` como parâmetros de linha de comando em vez de constantes.

**Dúvidas que cabem ao dono:** (a) a mudança de modelo de privacidade (IP entre espectadores) é aceitável? (b) o desktop passa a poder ser repassador, ou só o web? (c) a latência de +80 a +120 ms é aceitável para o produto?

---

## 7. Referências

**Código (libwebrtc `main`, lido em 2026-10-02):**
- `modules/congestion_controller/goog_cc/` : [`goog_cc_network_control.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/goog_cc_network_control.cc), [`delay_based_bwe.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/delay_based_bwe.cc), [`trendline_estimator.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/trendline_estimator.cc), [`probe_controller.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/probe_controller.cc), [`send_side_bandwidth_estimation.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/send_side_bandwidth_estimation.cc), [`loss_based_bwe_v2.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/loss_based_bwe_v2.cc), [`alr_detector.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/congestion_controller/goog_cc/alr_detector.cc)
- [`modules/remote_bitrate_estimator/aimd_rate_control.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/remote_bitrate_estimator/aimd_rate_control.cc)
- [`modules/pacing/pacing_controller.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/pacing/pacing_controller.cc) e `.h`
- [`modules/video_coding/nack_requester.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/video_coding/nack_requester.cc); `modules/rtp_rtcp/source/rtp_packet_history.h`; [`call/rtp_video_sender.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/call/rtp_video_sender.cc) (`ShouldDisableRedAndUlpfec`); `modules/rtp_rtcp/source/rtp_sender_video.cc`
- [`media/engine/webrtc_video_engine.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/media/engine/webrtc_video_engine.cc) (`GetBitrateConfigForCodec`, `SetSdpBitrateParameters`); `video/config/encoder_stream_factory.cc`
- `modules/congestion_controller/scream/scream_v2.h` e `modules/congestion_controller/ect1_policy.h` (ScreamV2 e ECT(1) em desenvolvimento)

**Padrões:**
- [draft-ietf-rmcat-gcc-02](https://www.ietf.org/archive/id/draft-ietf-rmcat-gcc-02.txt) — Google Congestion Control (η = 1,08; β = 0,85; `A < 1,5·R`)
- [RFC 8698](https://www.rfc-editor.org/rfc/rfc8698) — NADA; [RFC 8298](https://www.rfc-editor.org/rfc/rfc8298) — SCReAM; [draft-johansson-ccwg-rfc8298bis-screamv2-07](https://www.ietf.org/archive/id/draft-johansson-ccwg-rfc8298bis-screamv2-07.txt)
- [RFC 9330](https://www.rfc-editor.org/rfc/rfc9330) e [RFC 9331](https://www.rfc-editor.org/rfc/rfc9331) — L4S; [RFC 8888](https://www.rfc-editor.org/rfc/rfc8888) — RTCP feedback de congestionamento (com ECN)
- [RFC 8699](https://www.rfc-editor.org/rfc/rfc8699) — Coupled Congestion Control for RTP Media; [RFC 8382](https://www.rfc-editor.org/rfc/rfc8382) — Shared Bottleneck Detection; [RFC 8867](https://www.rfc-editor.org/rfc/rfc8867) — casos de teste de CC
- [RFC 4588](https://www.rfc-editor.org/rfc/rfc4588) (RTX), [RFC 5109](https://www.rfc-editor.org/rfc/rfc5109) (ULPFEC), [RFC 8627](https://www.rfc-editor.org/rfc/rfc8627) (FlexFEC), [RFC 2198](https://www.rfc-editor.org/rfc/rfc2198) (RED), [RFC 4585](https://www.rfc-editor.org/rfc/rfc4585) (NACK/PLI), [RFC 5104](https://www.rfc-editor.org/rfc/rfc5104) (FIR)
- [W3C WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/) (`RTCEncodedVideoFrame(originalFrame, options)`, `sendKeyFrameRequest()`, `generateKeyFrame()`)

**Artigos:**
- Carlucci, De Cicco, Holmer, Mascolo. *Analysis and design of the Google Congestion Control for WebRTC.* MMSys 2016. [doi:10.1145/2910017.2910605](https://doi.org/10.1145/2910017.2910605)
- Castro et al. *SplitStream: High-bandwidth multicast in cooperative environments.* SOSP 2003. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/splitstream-high-bandwidth-multicast-in-a-cooperative-environment/)
- Zhang, Liu, Li, Yum. *CoolStreaming/DONet: A data-driven overlay network for efficient live media streaming.* INFOCOM 2005. [HKUST](https://researchportal.hkust.edu.hk/en/publications/coolstreamingdonet-a-data-driven-overlay-network-for-peer-to-peer/)
- Kumar, Liu, Ross. *Stochastic fluid theory for P2P streaming systems.* INFOCOM 2007. (resumo e fórmula conferidos em busca; sem link para o texto)
- Liu. *On the minimum delay peer-to-peer video streaming: how realtime can it be?* ACM Multimedia 2007. [Semantic Scholar](https://www.semanticscholar.org/paper/On-the-minimum-delay-peer-to-peer-video-streaming:-Liu/a9534771b4cc198523d13f56a7468417717bf215)
- Hei, Liang, Liang, Liu, Ross. *A measurement study of a large-scale P2P IPTV system* (PPLive). [PDF](https://cse.engineering.nyu.edu/~ross/papers/P2PliveStreamingMeasurement.pdf)

**Dados de mercado (checados por busca; não conferidos na fonte primária):** Ookla Speedtest Global Index, Brasil, banda larga fixa, mediana ≈ 222 Mbps de download em dezembro de 2025 ([Telecompaper](https://www.telecompaper.com/news/brazil-improves-fixed-broadband-ranking-in-speedtest-global-index--1571689)); painel da Anatel, ≈ 66 % de fibra e velocidade contratada média ≈ 447 Mbps em 2024 (resultados de busca de Teletime/Tecnoblog).

**Interno:** AGENTS.md (R5 e corolários), ADRs 0005, 0015–0019, 0023, 0029, 0030, `docs/engenharia/complexidade.md` §D, `docs/desktop/D0b-um-encode-n-envios.md`, `e2e/malhas.sim.mjs`, `e2e/bench/rede-malha-vs-arvore.calc.mjs`.
