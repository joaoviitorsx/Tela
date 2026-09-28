# TELA-026 — Refatoração localizada e custo da interface

**Data:** 2026-09-28 · **Plano:** §8.3, §10.4, §11.1

## 1. Malha de banda fora de `BroadcastSession`

Governador, evidência de colapso (TELA-015) e sonda de subida saíram para
`apps/web/src/core/media/malha-de-banda.ts`: classe pura, leitura do segundo
entra, `{ orcamentoVideo, presetPorBanda } | null` sai. A sessão aplica —
grava o orçamento no transporte e compõe o degrau com o do usuário e o da CPU.

| | antes | depois |
|---|---|---|
| `broadcast-session.ts` | 1.909 linhas | 1.684 linhas |
| `malha-de-banda.ts` | — | 322 linhas + 4 testes diretos |

**Prova de que nada mudou:** commit só de refatoração (`abe74da`), 540 testes
inalterados, e a saída completa de `e2e/malhas.sim.mjs` (1.200 cenários) e de
`--quedas` **idêntica byte a byte** à anterior (só a linha de progresso com
tempo difere, e ela já variava entre duas execuções da mesma árvore).

## 2. Custo da interface

`node e2e/custo-interface.e2e.mjs` contra o `pnpm dev`. CPU = `TaskDuration`
do CDP por segundo, em 10 s de tela parada. Chromium headless com SwiftShader:
o número da TV 3D é CPU fazendo trabalho de GPU e **não é o custo real** — vale
a comparação.

| Tela parada | CPU antes | CPU depois | Animação infinita invisível antes → depois |
|---|---|---|---|
| home passo 01 (TV 3D) | 236,7 ms/s | 239,2 ms/s | 0 → 0 |
| home passo 01, aba oculta | — | 0,5 ms/s | — |
| home passo 01, TV fora da tela | — | 0,5 ms/s | — |
| home passo 02 | 0,1 ms/s | 0,1 ms/s | 0 → 0 |
| espectador esperando sinal | 1,9 ms/s | 2,6 ms/s ¹ | 0 → 0 |
| ao vivo, console aceso | 9,1 ms/s ² | 8,9 ms/s | **2 → 0** |
| ao vivo, console apagado (placa) | 4,0 ms/s | 3,4 ms/s | **2 → 0** |

¹ Ruído entre execuções: o polling de 5 s cai ou não dentro da janela.
² Inclui o canvas falso que substitui a tela (desenho a 30 fps na própria página).

### O que foi achado e corrigido

- **LEDs piscando em camada invisível, a transmissão inteira.** O console ao
  vivo e a placa de repouso se revezam por opacidade; o LED da camada apagada
  seguia animando. Classe `.animacoes-pausadas` na camada com opacidade 0.
- **Duas capturas por TRANSMITIR em desenvolvimento.** O remonte do StrictMode
  encerrava a primeira sessão no meio do `getDisplayMedia` e a segunda pedia de
  novo — dois seletores de tela do sistema. O encerramento do efeito agora
  espera um tique; remonte com os mesmos parâmetros cancela. Medido: 2 → 1.

### O que foi conferido e já estava certo

- A TV 3D da vitrine para com a aba oculta e fora da viewport
  (IntersectionObserver + `visibilitychange`), e roda a 30 fps quando visível.
- A abertura faz `dispose` + `forceContextLoss` ao terminar.
- Um socket de sinalização por página (o outro WebSocket é o HMR do Vite).
- Ajustes de encoding não se acumulam: `applyPreset` lê preset e orçamento
  vigentes na hora; um `setParameters` concorrente invalida a transação
  anterior, que rejeita, vira pendente e é reaplicada com os valores novos.
- Animações CSS pausam com a aba oculta (`data-aba`, já existente).

## Não verificado (precisa de humano)

- **Custo real da TV 3D com GPU.** Abrir a home, `chrome://gpu` confirmando
  aceleração, e comparar no gerenciador de tarefas do Chrome (Shift+Esc) a
  CPU/GPU da aba com a TV visível e com o passo 02 aberto.
- **Impacto do console ao vivo no FPS do jogo** com MangoHud, console aceso e
  apagado — o número acima é a página, não o jogo.
