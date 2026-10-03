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

| Cenário | Degrau | fps | desvio do intervalo |
|---|---|---|---|
| Sem carga — um encode | 720p60 | 60 | 4,1 ms |
| Sem carga — mesh simples | 720p60 | 60 | 3,9 ms |
| Carga — um encode, ANTES | **720p60 (não desceu)** | 27,2 | 25,5 ms |
| Carga — mesh simples | 360p60 | 38,7 | 12,2 ms |
| Carga — um encode, sobrecarga por latência, tolerância 2 | 480p60 | 31,5 / 32,0 | 20,6 / 22,0 ms |
| Carga — um encode, sobrecarga por latência, tolerância 4 | 480p60 | 35,1 / 37,1 | 16,0 / 15,1 ms |

Sem carga o pipeline é fluido nos dois transportes: a injeção de quadros do
"um encode" não estraga o ritmo.

## Dois defeitos, duas correções

1. **A escada de CPU nunca descia.** O sinal `sobrecarregado` só acendia com a
   fila interna do encoder transbordando; sob carga o encoder levava 40–165 ms
   por quadro (orçamento: 16,7 ms) e o sinal acendia em 3 de 40 amostras — a
   escada pede 5 seguidas. Agora também acende com latência acima de 2× o
   orçamento E FPS de saída abaixo de 85% do alvo (`sobrecarga-do-encoder.ts`).
   Hardware saudável (FPS cheio) e tela parada (latência baixa) não acendem.
2. **A contrapressão global segurava quadros de todos.** Com a CPU disputada as
   iscas atrasam, e a tolerância de 2 quadros fazia o encoder pular 4–15
   quadros por segundo para a sala inteira. Tolerância 4: +15% de fps, −27% de
   desvio; sem carga, igual.

## Não medido (humano)

A bancada põe transmissor, espectadores e "jogo" na mesma máquina — muito mais
pesada que o real. A validação é com um jogo de verdade: diagnóstico do
transmissor (`msPorQuadro`, limitador, `segurados`) e o fps que o amigo vê,
antes e depois desta versão.
