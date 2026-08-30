# ADR 0010 — A escada de qualidade é calibrada por bits por pixel

**Data:** 2026-08-24
**Estado:** aceita
**Substitui parcialmente:** ADR 0004 (escolha de qualidade)

## Contexto

Usuários relataram, repetidamente, que a imagem "fica pixelizada" em jogo de
movimento rápido — Counter-Strike, com o mouse girando. O relato persistiu
depois de várias correções de malha de controle, e o dado que fechou o
diagnóstico foi este: **acontecia com UM espectador**, num link de fibra, onde
nenhum teto de upload chega a ser aplicado.

Isso elimina a rede como causa. Com um espectador e sem teto, o encoder recebe
exatamente o que a tabela de presets manda. Se a imagem quebra ali, a tabela
está errada.

A aritmética confirma. `p1080p60` pedia 8 Mbps para 1920×1080 a 60fps:

    1920 × 1080 × 60 = 124.416.000 pixels por segundo
    8.000.000 ÷ 124.416.000 = 0,064 bit por pixel

Conteúdo de movimento alto precisa de **0,10 a 0,20 bpp** em H.264. Num flick
a tela inteira muda de quadro para quadro, vetores de movimento não ajudam, e
o controlador de taxa tem uma única saída: subir o QP. **QP alto é o
quadriculado.** O produto nunca deu bits suficientes ao encoder, nem no melhor
cenário possível.

Pior, a tabela antiga não tinha critério nenhum — os degraus variavam entre
0,045 e 0,072 bpp sem razão aparente, e o degrau "econômico" era o PIOR de
todos, justamente o que devia ser escolhido sob aperto.

## Decisão

**Todo degrau da escada mantém ~0,10 bit por pixel, e todo degrau preserva
60fps.**

| id | resolução | bitrate | bpp |
|---|---|---|---|
| `p1080p60` | 1920×1080@60 | 12,0 Mbps | 0,0965 |
| `p900p60` | 1600×900@60 | 8,0 Mbps | 0,0926 |
| `p720p60` | 1280×720@60 | 5,5 Mbps | 0,0995 |
| `p600p60` | 1024×576@60 | 3,6 Mbps | 0,1017 |
| `p480p60` | 854×480@60 | 2,5 Mbps | 0,1016 |
| `p360p60` | 640×360@60 | 1,4 Mbps | 0,1013 |

Referências: YouTube recomenda 12 Mbps para 1080p60 em H.264; o OBS usa
5,8 Mbps como *mínimo* para esse modo; e encode em tempo real — um passe, CBR,
sem B-frames, sem lookahead — custa 10 a 20% a mais que o mesmo alvo em vídeo
gravado. A referência é piso, não teto.

> **Correção (ADR 0019).** As duas primeiras referências foram verificadas e
> conferem — os 5,8 Mbps do OBS são literais no código deles, âncora de uma
> fórmula `pow(cx*cy, 0.85) * sqrt(pow(fps, 1.1))`. A terceira, o custo de
> 10 a 20% do tempo real, **não tem medição publicada que eu tenha achado**.
> Continua sendo premissa. O que tem fonte e sustenta a mesma margem é o Zoom,
> também tempo real e também 1 passe, publicando 12,8 Mbps para 1080p60.

## Consequências

**1080p60 passou a custar 12 Mbps de subida por espectador, não 8.** Quem
tinha link para 8 e não para 12 vai receber `p900p60` — e vai ver uma imagem
MELHOR, porque 900p com 0,093 bpp é mais nítido que 1080p com 0,064. A
resolução no rótulo caiu; a qualidade percebida subiu. A promessa ficou
honesta.

**`p720p30` deixou de existir.** Ele tinha a mesma resolução do degrau acima,
então descer nele cortava framerate sem tirar um pixel do encoder — havia um
corolário inteiro na R5 explicando por que a escada de CPU precisava pular esse
degrau. No orçamento dele cabe `p360p60`, que preserva o movimento. Movimento é
a informação em gameplay.

**A escada perdeu a exceção.** `SIXTY_FPS_PRESETS` passou a ser toda a ordem, e
a distinção entre "degrau de CPU" e "degrau de upload" desapareceu: cada degrau
alivia os dois. O corolário da R5 foi reescrito.

**Dois degraus intermediários novos** (900p60 e 576p60) fazem a degradação cair
em vez de despencar. Antes, sair de 1080p60 significava ir direto para 720p.

## Alternativas descartadas

**Manter a tabela e confiar nas malhas.** Não resolve: com um espectador não há
teto nenhum, e o problema aparecia ali.

**Trocar de codec.** VP9 e AV1 comprimem 30% melhor, mas encode por hardware só
existe em placas recentes, e em software custam 3 a 5 vezes mais CPU — na mesma
máquina que está rodando o jogo. A R5 continua certa.

**Deixar o usuário escolher o bitrate.** Contradiz o produto: quem aperta um
botão para transmitir para os amigos não sabe, e não deveria precisar saber,
quantos megabits por segundo o Counter-Strike exige.

## O que continua sem verificação

O número 0,10 bpp vem de literatura e de referências de plataforma, não de
medição no hardware do usuário. Falta comparar, com o mesmo jogo e o mesmo
link, a imagem antes e depois — e confirmar em `chrome://webrtc-internals` que
`qp_sum / framesEncoded` caiu. Enquanto isso não for feito, esta ADR é uma
hipótese bem fundamentada, não um fato medido.
