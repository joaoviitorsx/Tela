# ADR 0032 — Multivisão: dois canais na mesma tela, o segundo em PiP

**Data:** 2026-10-03
**Estado:** **proposta** (aguarda o dono: perguntas em "O que o dono decide")
**Altera, se aceita:** R6 (o espectador pode assistir mais de um canal ao mesmo tempo) · **Mantém:** R1, R2, R3, R5, R8, ADR 0005, 0026, 0028, 0029, 0031
**Plano:** `docs/multivisao/PLANO-multivisao.md`

## Contexto

Dois amigos jogando a mesma partida, cada um transmitindo o próprio canal; ou
um num jogo e outro em outro. Hoje quem assiste abre duas abas e alterna. O
dono pediu (2026-10-02): adicionar uma segunda transmissão na própria tela do
espectador, a secundária num quadro no canto, e um clique nela a torna a
principal.

A R6 lista "múltiplos transmissores por sala" como fora do escopo. O dono
registrou que a R6 era a cerca do MVP e que, com o MVP no ar, recursos como
este podem entrar. Esta ADR escreve até onde a cerca muda.

## Decisão

1. **A composição é do espectador, não da sala.** Cada canal continua sendo
   uma sala com UM transmissor. A página abre uma `ViewerSession` por canal
   (`createViewerSession()` já é fábrica: transporte e sinalização próprios) e
   mostra as duas. Servidor, protocolo (5) e Durable Object não mudam. A R8
   fica intacta: o signaling nem sabe que as duas sessões estão na mesma aba.
2. **"Múltiplos transmissores por sala" continua fora.** O que muda na R6 é
   só a linha do espectador.
3. **Limite de 2 canais** na primeira versão: principal mais um em PiP. A
   grade de 4 só depois de medir o custo de decodificar 4 × 1080p60 numa
   máquina fraca.
4. **Trocar não reconecta.** As duas sessões e os dois `<video>` ficam
   montados o tempo todo; trocar muda a POSIÇÃO de cada um (CSS), nunca o
   elemento. Nenhum quadro preto, nenhuma renegociação.
5. **O som segue a principal.** A secundária está sempre muda. A troca
   desmuta a nova principal dentro do próprio clique (o gesto autoriza o
   áudio).
6. **Link composto:** `/<a>+<b>`. O `SLUG_RE` não aceita `+`, então o caminho
   nunca colide com um canal. A ordem é a do layout: o primeiro é a principal.
   A troca reescreve a URL com `replaceState` (sem entrada nova no histórico).
7. **A banda é a do espectador, e a R5 continua valendo.** Não existe
   "miniatura em baixa resolução": os parâmetros de encoding são idênticos
   para todos os peers de um canal, então a PiP custa a banda de uma
   transmissão inteira. Se o espectador não aguenta as duas, a adaptação
   coletiva derrubaria um degrau **da sala inteira** dos dois canais. Por isso:
   - **Guarda de banda:** perda de quadros por causa da REDE (vigia de
     fluidez) em qualquer painel, sustentada, PAUSA a secundária: a sessão
     fecha, o último quadro fica congelado com "PAUSADA · sua rede não segura
     duas" e um toque tenta de novo. A principal nunca é pausada por isso.
     Causa `decodificacao` também pausa, com o texto do computador.
   - **Espectador em multivisão não repassa** na cascata (ADR 0031): a subida
     dele já não é dele.
8. **Tamanho do passo:** um marco por vez (plano), começando por uma
   refatoração SEM mudança de comportamento do `Viewer.tsx`.

## Consequências

- O download de quem assiste dobra. Em 1080p60 a 12–20 Mbps por canal, são
  24–40 Mbps. Quem não tem isso vê a secundária pausar, não a sala piorar.
- Dois decodificadores H.264 1080p60 ao mesmo tempo. Com decodificação por
  hardware é folgado; sem ela, o vigia acusa `decodificacao` e a guarda
  pausa a secundária.
- A barra de baixo continua falando da principal (latência, imagem, som). A
  PiP tem só o próprio rótulo e três ações.
- `AGENTS.md` R6 ganha a exceção escrita, se esta ADR for aceita.

## Rejeitado

- **Picture-in-picture nativo do navegador para a secundária.** Sai da
  página (não entra na tela cheia junto), só aceita um vídeo por vez, e a
  troca seria trocar `srcObject` — o tipo de remontagem que a decisão 4
  existe para evitar. Continua existindo para a principal, como hoje.
- **Pedir ao transmissor um fluxo menor para a PiP** (simulcast/SVC por
  espectador). Fere a R5 e o "um encode, N envios" da ADR 0029.
- **Mixar os dois áudios.** Dois jogos ao mesmo tempo é barulho; a call do
  Discord já está tocando por cima.

## O que o dono decide

1. Aceita a emenda da R6 como escrita (decisões 1–2)?
2. Limite de 2 agora e 4 depois de medir?
3. Guarda de banda: pausar a secundária automaticamente (recomendado) ou só
   avisar e deixar a pessoa decidir?
4. O nome do botão: `+ TELA` (recomendado: é o nome do produto e diz o que
   faz) ou `ASSISTIR JUNTO`?
