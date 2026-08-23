# ADR 0009 — Estabilidade das malhas de controle e escolha de degradação

**Status:** aceita · **Data:** 2026-08-23
**Origem:** relatos de produção — travamento, ping instável, imagem embaçada
**Altera:** R5 (acrescenta uma escolha do usuário sobre `degradationPreference`)

## O erro que motivou esta ADR

A correção do impacto no ping introduziu três malhas de controle, e nenhuma
delas tinha amortecimento:

| malha | como estava | efeito |
|---|---|---|
| teto de bitrate | 75% da estimativa CRUA, a cada segundo | o encoder recebia alvo novo por segundo e nunca assentava |
| escada de preset | 5 amostras, desde o primeiro segundo | degradava durante o aquecimento, quando tudo parece apertado |
| captura ociosa | imediata ao chegar a zero peers | um peer piscando derrubava a captura para 5fps e de volta |

`availableOutgoingBitrate` oscila por natureza — o controle de
congestionamento sobe, sonda e recua. Reagir a cada leitura é reagir ao ruído.

**Uma malha que responde mais rápido do que o sistema assenta oscila. Sempre.**
Os usuários relataram exatamente isso: travamento e instabilidade.

## Decisão: três defesas, aplicadas a toda malha

1. **Aquecimento.** Nada é decidido nas primeiras leituras. No início da
   transmissão o encoder ainda sobe e o estimador ainda sonda; `cpu` e
   `bandwidth` aparecem mesmo em máquina folgada, e passam sozinhos.
2. **Suavização.** Média móvel exponencial, para que um vale isolado não vire
   queda de qualidade.
3. **Histerese.** Só muda quando o alvo se afasta o bastante do aplicado.
   Ajuste pequeno não paga o custo de reconfigurar o encoder.

Mais um piso: o teto nunca desce abaixo do menor preset. Estimativa ruim não
pode estrangular a transmissão até o nada — é melhor deixar o WebRTC
descartar pacote do que desligar a imagem por precaução.

Está em `core/media/uplink-governor.ts`, isolado e testado. O teste que
importa alimenta ruído de ±20% e exige **zero** reconfigurações.

## Decisão: a degradação vira escolha do usuário

A R5 trava `degradationPreference: 'maintain-framerate'`. Ele continua sendo
o padrão, e por bom motivo: em gameplay o movimento É a informação.

Mas o relato foi específico — "quando tem muita coisa na tela, fica embaçado".
Isso é a regra funcionando: cena complexa pede mais bits, não há, e o encoder
derruba resolução para segurar 60fps.

Para quem está mostrando um mapa, um inventário ou texto, o detalhe é a
informação, e nítido a 30fps vence fluido e ilegível.

Então: **`fluidez` (padrão, inalterado) e `nitidez`**, alternável ao vivo, sem
renegociar. O produto não escolhe pelo usuário nem esconde a troca — ele diz
o que cada lado custa.

## Decisão: trocar a fonte sem derrubar ninguém

`replaceTrack` substitui o vídeo num sender já negociado sem tocar no SDP.
Quem assiste não pisca. É o que permite alternar entre tela inteira e uma
janela no meio da transmissão, que é como as pessoas de fato usam.

Renegociar aqui derrubaria a imagem de todos a cada troca.

## Decisão: preview do que está sendo capturado

Ninguém deveria transmitir às cegas. E é diagnóstico: sem ele, "está preto"
tem duas causas indistinguíveis — a captura não produziu frame, ou produziu e
a rede não entregou. Com ele a pergunta se responde olhando.

O preview leva só o vídeo. Incluir o áudio tocaria o som do jogo de volta nos
alto-falantes de quem está jogando, criando eco que o navegador pode
recapturar.

## O que continua verdadeiro

`contentHint = 'motion'`, `videoCodec: 'h264'`, parâmetros idênticos entre
peers e duas camadas por preset seguem inalterados e inegociáveis.
