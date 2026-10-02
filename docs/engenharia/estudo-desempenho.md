# Estudo de desempenho — roteiro consolidado

**Data:** 2026-10-02 · **Base:** `complexidade.md` (caminhos quentes, medido) e as três partes do estudo em `estudo/`, cada uma com fontes primárias, medições e etiquetas de confiança:

| Parte | Assunto |
|---|---|
| [`estudo/1-codec.md`](estudo/1-codec.md) | encoder e codec: IDR, intra refresh, camadas temporais, AV1/HEVC, controle de taxa |
| [`estudo/2-transporte-e-topologia.md`](estudo/2-transporte-e-topologia.md) | controle de congestionamento, NACK × FEC, pacing, cascata de repasse |
| [`estudo/3-latencia-espectador-host.md`](estudo/3-latencia-espectador-host.md) | orçamento de latência, espectador, consumo do host, infra, metodologia |

A regra que vale para tudo abaixo é a do AGENTS.md: medido em vez de deduzido. Cada item diz o que já foi medido, o ganho esperado e o que falta para mexer.

## Já aplicado (com número)

| Item | Antes → depois | Onde |
|---|---|---|
| Um encode, N envios (ADR 0029) | CPU de encode por espectador ×N → constante | D0b, D0c |
| NVENC nativo no Linux | ~1,2 → ~0,07 núcleo em 1080p | D0c |
| Fila de injeção em anel | 369 → 87 ns por vaga a N=50 | complexidade A1 |
| Leitor do protocolo O(B) | IDR em pedaços de 512 B: 88 MB → 0,3 MB copiados | complexidade A4 |
| Janela de IDR ∝ N + teto de PLI por espectador | IDR a N=50: 120–240 → 30–60 Mbps no pior caso | complexidade C4 |
| `relay()` O(1) no Durable Object | 235,6 → 8,7 µs por sinal a N=50 | complexidade C2 |
| `getStats` em rodízio | 50 → ~12 leituras/s a N=50 em sala saudável | complexidade B2 |
| Aquecimento por caminho + porta pela banda (ADR 0030) | sala grande: 87 absorventes → 0; 187 afogando → 0 | simulador `--escala` |
| `writev` no helper | 180 → 60 syscalls/s | complexidade A7 |

## Próximos, em ordem

**Agora (baixo risco, medido ou barato de medir):**
1. **Encolher o IDR do NVENC** (VBV 4 → 2 quadros): pico 66–74 KB → ~40 KB, −0,1 dB. [1-codec P1]
2. **Rotas sob demanda** no front: o espectador para de baixar o código de transmissão. [3 · 9]
3. **Guarda contra filtro sobre o vídeo** (teste): `backdrop-filter` custou ~4× em raster por software. [3 · 3]
4. **Ociosidade no caminho nativo** (5 fps sem plateia). [3 · 4]
5. **Medir a rampa e as sondas por caminho** em Chrome real antes de mexer no SDP (`x-google-max-bitrate`; sem ele o teto de sonda é 5 Mbps no libwebrtc). [2 · T1/T6]
6. **Registrar "sem FEC"**: o libwebrtc já desliga o ULPFEC para H.264 com NACK; tirar `red`/`ulpfec`/`flexfec` das preferências. [2 · T5]

**Depois (precisa de rede real ou ADR):**
7. **Piso do jitter buffer atrelado ao RTT** (J ≥ RTT + 25 ms; ≥ 2·RTT + 35 ms com perda): de 710 para 17 soluços/min em RTT 80 ms com 1% de perda; em link calmo, piso 20 ms ganha 10–30 ms. Validar com `tc netem`. [2 · T3, 3 · 2]
8. **Medição ponta a ponta de verdade** (carimbo de captura + offset de relógio): hoje 0 de 852 quadros têm `captureTime`. [3 · 1]
9. **VBR para tela parada**: −89% de banda com a tela parada, mas reabre o risco da ADR 0018 (estimativa decai a 1,5 × enviado e a volta do movimento sobe devagar). Exige cenário "parado → jogo" no simulador. [1-codec P1]
10. **Perfil Main/High**: ~10% de bitrate, mas o Firefox decodifica H.264 com OpenH264 (Constrained Baseline) — só com negociação por espectador. [1-codec P1]
11. **Windows: medir antes de construir** (PresentMon, "Video Encode" no Gerenciador de Tarefas) e `CalculateNativeWinOcclusion` desligado com jogo em borderless. [3 · 6–7]

**Fases grandes (cada uma com ADR):**
12. **Cascata de repasse** — a única proposta que muda a ordem de grandeza: N=50 com host de 100 Mbps passa de 1,5 para 12–16 Mbps por espectador, ao custo de +80–120 ms e IP exposto entre espectadores. Profundidade ≤ 2 na fase 1. [2 · T2]
13. **Válvula de camada temporal por espectador** (SVC L1T2): descartar a camada não-base é bit-exato no Chromium; um espectador fraco recebe 30 fps sem encoder extra. Toca `maintain-framerate` (R5). [1-codec P2]
14. **AV1 em dois níveis** (H.264 para quem não decodifica): 14–52% menos bits a PSNR igual. Toca `videoCodec: h264` (R5). [1-codec P3]

**Descartado com evidência:** intra refresh como substituto do IDR (o receptor do Chromium só começa num IDR — medido), LTR/RPS num encode compartilhado, troca de algoritmo de congestionamento (não é configurável do JS; SCReAMv2/L4S em desenvolvimento no libwebrtc).

## O custo que mais escala hoje

Medido no navegador (`e2e/bench/chromium-por-espectador.mjs`): **~0,03–0,06 núcleo por espectador** no Chromium de quem transmite, e quase não muda com o bitrate — é custo **fixo por sender** (isca 160×90 codificada a 60 fps + Encoded Transform + pacotização), não proporcional aos bytes. Extrapolado, 50 espectadores somam 1,5–3 núcleos. Duas frentes: medir com a máquina ociosa e `chrome://tracing` para decompor, e testar isca menor (32×32 deu indício de ~30% a menos, dentro do ruído de uma máquina carregada) — e, no limite, a cascata, que tira esses senders do host.
