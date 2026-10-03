# Estudo — fluidez (FPS e ritmo) no "um encode"

**Data:** 2026-10-03 · **Bancada:** `e2e/fluidez.e2e.mjs` (Chromium headless, fonte 1280×720@60 animada, 2 espectadores na rota de produção) · **Carga:** um laço ocupado por núcleo (16), o "jogo"

O que o espectador sente vem do `inbound-rtp`: fps decodificado e o RITMO — média
e desvio do intervalo entre quadros (`totalInterFrameDelay`,
`totalSquaredInterFrameDelay`). FPS "certo" aos trancos é o engasgo que se vê.

## Motivação

Um espectador em Campinas mandou o diagnóstico: rede limpa (perda ~0, RTT 65 ms),
decoder com folga (11–24 ms por quadro), e mesmo assim **13 a 27 fps** e bitrate
em rajadas. O gargalo estava no ritmo de saída do transmissor.

## Medido

Primeira rodada (uma amostra por configuração):

| Cenário | Degrau | fps | desvio do intervalo |
|---|---|---|---|
| Sem carga — um encode | 720p60 | 60 | 4,1 ms |
| Sem carga — mesh simples | 720p60 | 60 | 3,9 ms |
| Carga — um encode, produção | **720p60 (não desceu)** | 27,2 | 25,5 ms |
| Carga — mesh simples | 360p60 | 38,7 | 12,2 ms |

Sem carga o pipeline é fluido nos dois transportes: a injeção de quadros do
"um encode" não estraga o ritmo.

## A primeira correção, e por que foi refeita

A primeira versão (1) acusava sobrecarga com latência acima de 2× o orçamento
do ALVO e FPS de saída abaixo de 85% do alvo, e (2) subia a tolerância da
contrapressão de 2 para 4 quadros. A revisão independente derrubou as duas:

- (1) com a fonte a 30 fps a condição de FPS fica sempre verdadeira e 34–58 ms
  bastavam: a escada descia sem ganhar um quadro, e a calmaria (cada aperto
  custa 5) não a deixava voltar;
- (2) o "+15% de fps" era menor que a variação ENTRE RODADAS da mesma
  configuração (o revisor mediu 43 fps onde eu tinha 35–37), e cada quadro de
  tolerância é latência para a sala inteira;
- e achou a causa raiz das rajadas: o atraso que o worker avisa a cada 100 ms
  ficava velho, e o encoder pulava TODOS os quadros até o próximo aviso.

## O que ficou

1. **Sobrecarga contra o intervalo REAL de entrada**
   (`sobrecarga-do-encoder.ts`): latência acima de 2,5 intervalos entre
   quadros entregues ao encoder, com no mínimo 10 amostras; a leitura logo
   depois de trocar de tamanho é ignorada. Pipeline de hardware (1–2
   intervalos), fonte a 30 fps e tela parada não acendem.
2. **Atraso drenado**: cada quadro segurado desconta uma vaga; tolerância
   volta a 2.
3. **Banda antes de CPU** no limitador: `cpu` intermitente não esconde mais um
   colapso de rede da malha (ADR 0033).

Produção × nova, rodadas ALTERNADAS, mesma carga (a máquina estava mais
carregada que na primeira rodada, por isso os absolutos caíram para as duas):

| Carga, fonte 60 fps | Produção | Nova |
|---|---|---|
| congelamentos (por rodada) | 6 · 6 · 1 | **0 · 0 · 0** |
| desvio do intervalo | 32,0 · 31,9 · 27,9 ms | **24,8 · 25,4 · 24,8 ms** |
| fps | 19,1 · 19,4 · 20,3 | **21,9 · 20,4 · 21,2** |
| leituras `cpu` (de ~45) | 8 · 6 · 1 | 0 · 7 · 2 |

| Outros cenários | Produção | Nova |
|---|---|---|
| carga, fonte 30 fps | 720p, 20,4 fps | **720p** (sem falso positivo), 20,9 fps |
| sem carga, fonte 60 fps | — | 60,1 fps, desvio 4,3 ms |

O ganho consistente é o ritmo — zero congelamentos e −18% de desvio —, e vem
do atraso drenado. A escada de CPU deixou de descer à toa; se ela deve descer
MAIS sob um jogo de verdade é a pergunta aberta abaixo.

## O que a bancada não pega

- Latência (só o buffer do receptor): o custo de qualquer tolerância.
- Hardware: só encoder por software; pipeline de GPU não é testável aqui.
- Fonte realista: o canvas disputa a mesma thread do encoder; um jogo é
  capturado no processo de GPU (WGC/PipeWire).
- Aba em segundo plano: as flags da bancada desligam o estrangulamento que o
  usuário real tem com o jogo em tela cheia.
- Rede: loopback, 2 espectadores.

## Não medido (humano)

Com um jogo de verdade, antes e depois desta versão: o diagnóstico do
transmissor (`msPorQuadro`, limitador, `segurados`) e o fps e as travadas que o
amigo vê; se a escada desce e volta; GPU real a 30 fps e em tela parada,
lendo `msPorQuadro` e o limitador.
