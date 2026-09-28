# TELA-007 — estatísticas e estados de áudio

O áudio passou a ter contabilidade própria, separada do vídeo
(`core/media/audio-stats.ts`), e um classificador de estado
(`core/media/audio-state.ts`). Este registro separa o que foi executado do que
ainda depende de navegador, rede ou pessoa.

## O que é medido

| Lado | Campo | Origem no `getStats()` |
|---|---|---|
| ambos | `bitrateBps` | Δ `bytesSent`/`bytesReceived` por peer + SSRC |
| ambos | `codec` | `codec` apontado por `codecId`; `sdpFmtpLine` filtrado por lista fechada de chaves Opus |
| transmissor | `nivel` | Δ `totalAudioEnergy` / Δ `totalSamplesDuration` da `media-source` (depois do ganho) |
| espectador | `nivel` | o mesmo par, no `inbound-rtp` (antes do volume local) |
| espectador | `perda` | Δ `packetsLost` / (Δ `packetsReceived` + Δ `packetsLost`) |
| espectador | `ocultacao` | Δ `concealedSamples` / Δ `totalSamplesReceived` |
| espectador | `jitterBufferMs` | Δ `jitterBufferDelay` / Δ `jitterBufferEmittedCount` |
| espectador | `jitterMs` | `jitter` instantâneo |

Regras: taxa por intervalo, nunca acumulado; SSRC novo ou contador que volta
não gera delta; campo ausente é `null`, nunca zero.

## Estados

`sem-fonte`, `encerrada`, `bloqueado`, `mudo`, `perda`, `sem-sinal`,
`transmitindo`, `desconhecido`. `sem-sinal` exige 20 s contínuos abaixo de
~-60 dBFS **medidos**; `perda` entra com 3 amostras acima de 5 % de ocultação e
sai com 5 abaixo de 2 %. Cada mudança vira evento `audio` no diagnóstico, que
passou à versão 3 com as colunas `audio*` por amostra e o `codecAudio`.

## Executado

| Ensaio | Resultado |
|---|---|
| `pnpm turbo lint typecheck test build` | 12/12 tarefas; 391 testes web, 128 signaling |
| `pnpm depcruise` | sem violações |
| `pnpm e2e` (Chromium 1228 headless, Linux, oscilador de 440 Hz) | passou. Transmissor: 1 fluxo, ~128 kbps, nível 1,0, `audio/opus` 2 canais 48 kHz, `stereo=1;sprop-stereo=1;useinbandfec=1;minptime=10` |

O `pnpm e2e` estava quebrado no `develop` antes desta tarefa (faltava o
`scheduler` exigido desde a TELA-005, e o preset `_ECO` removido pela ADR
0010). O harness foi corrigido em commit próprio.

## Não executado

| Caso | Por quê | Como validar |
|---|---|---|
| Lado do espectador em navegador real | o E2E não expõe a sessão do espectador | abrir `/<slug>` com transmissão ao vivo, copiar o diagnóstico e conferir `audioKbps`, `audioOcultacaoPct` e `audioNivelDb` preenchidos |
| Firefox e Safari | nomes de campo divergem; `media-source` de áudio e `concealedSamples` não foram conferidos | repetir o passo acima e registrar quais colunas vêm `null` |
| `perda` sob perda real | exige rede degradada | `tc qdisc add dev <if> root netem loss 10%` no espectador; o aviso "som picotando" deve aparecer em ~3 s e sumir ~5 s depois de remover a regra |
| `sem-sinal` com jogo mudo | exige captura real | transmitir com o jogo pausado e sem música por 20 s; o HUD do transmissor deve avisar; com volume da transmissão em zero, não deve |
| `encerrada` | exige fechar a fonte de áudio (sink virtual no Linux) | remover o sink com a transmissão no ar |
