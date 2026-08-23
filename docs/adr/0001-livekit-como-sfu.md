# ADR 0001 — LiveKit como SFU no modo servidor

**Status:** SUBSTITUÍDA pela ADR 0005 · **Data:** 2026-08-23 · **Origem:** §3 da documentação técnica

> O SFU deixou de ser o transporte do produto. O texto abaixo fica como
> registro do raciocínio original — em particular do argumento do simulcast,
> que a ADR 0005 responde de outra forma (adaptação coletiva).

## Contexto

O produto precisa entregar 1080p60 com latência sub-segundo para até 12
espectadores, sem que o pior espectador estrague a experiência dos outros.

## Decisão

LiveKit Server, self-hosted, com simulcast de **duas** camadas e seleção
server-side.

## Alternativas rejeitadas

| Alternativa | Motivo da rejeição |
|---|---|
| mediasoup | Simulcast e congestion control manuais; ~3 semanas a mais até o MVP |
| MediaMTX | Sem simulcast — o amigo no 4G derruba a qualidade de todos |
| Twitch/YouTube | 3–15s de latência; inviável para interação |

## Consequência

O diferencial não é "mais fácil": é o simulcast com seleção no servidor. Sem
ele, o transmissor reduz o bitrate porque o pior receptor reclama, e todo mundo
perde. Com ele, cada espectador recebe a camada que aguenta.

O custo é precisar de um servidor com IP público e egress. É exatamente esse
custo que a ADR 0002 ataca.
