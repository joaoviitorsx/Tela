# ADR 0004 — Escolha de qualidade pelo usuário

**Status:** aceita · **Data:** 2026-08-23

## Contexto

A documentação define presets fixos e degradação automática por pressão de CPU.
Faltava a decisão que só o usuário sabe tomar: ele conhece a internet e a
máquina dele, e o produto não.

Em P2P (ADR 0002) isso deixa de ser conforto e vira necessidade — o upstream é
o gargalo, e ele varia entre uma casa e outra por uma ordem de grandeza.

## Decisão

Três presets, escolhíveis antes de iniciar **e com a transmissão no ar**:

| Preset | Bitrate principal | Para quem |
|---|---|---|
| 1080p60 | 8 Mbps | Fibra simétrica |
| 720p60 | 4 Mbps | Conexão comum |
| 720p60 econômico | 2,5 Mbps | Upload apertado ou vários espectadores em P2P |

Todos mantêm **60fps** e **duas camadas** de simulcast. O que muda entre eles é

> **Superado (ADR 0019).** Simulcast saiu do tipo. Em malha P2P cada conexão
> tem UM receptor e o controle de congestionamento dela já adapta o encoding
> àquele espectador — a segunda camada nunca foi lida em lugar nenhum do
> runtime desde a ADR 0005, que trocou o SFU por malha. O que restou de
> `layers[0]` virou `width`/`height` no preset.

resolução e bitrate — nunca framerate, que é a regra do produto.

Trocar ao vivo republica a trilha sem derrubar quem já está assistindo.

## Interação com a degradação automática

A degradação por CPU continua existindo e desce **um degrau por vez**. Quando
ela age, a UI marca o preset como `presetForced` e diz o motivo real ("o
encoder não estava dando conta") em vez de esconder atrás de "conexão
instável".

Escolha manual limpa a marca e zera o contador de pressão. Se o usuário insiste
em 1080p com o encoder no limite, o produto avisa e obedece — e a degradação
automática volta a valer se a pressão persistir.

## Por que a lista de opções fala de rede, não de pixel

O rótulo diz `1080p60`; a linha abaixo diz "Fibra. ~8 Mbps de subida por
espectador". O usuário não sabe se precisa de 1080p — ele sabe se a internet
dele aguenta. `suggestPreset()` existe para sugerir a partir do upstream medido
em vez de deixá-lo adivinhar.

## Consequência

Adicionar um quarto preset é acrescentar um objeto em
`packages/shared/src/encoding.ts` e um id em `PRESET_ORDER`. A UI, a máquina de
estados e os dois transportes iteram sobre a lista — nada precisa ser tocado.
