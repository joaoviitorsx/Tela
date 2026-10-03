# Plano — Multivisão (ADR 0032)

Dois canais na mesma tela do espectador: a principal ocupando o palco, a
secundária num quadro no canto. Um clique no quadro troca as duas. Vale para
o site e para o app desktop: a rota é a mesma.

Este plano é o "como". O "por quê" e o que o dono decide estão na ADR 0032.

**Estado (2026-10-03): M0–M3 feitos; do M4, a prévia do link composto e o
`tela://assistir/a+b`.** Ficam para depois: `/tela canal:a+b` no Discord,
sincronia para a mesma partida e a grade de 4. Diferença do plano: o arranjo
em lado a lado e empilhado é pela ORDEM dos canais (nada se move na troca;
só a borda âmbar e o som mudam de lado).

---

## 1. A experiência

### 1.1 Três jeitos de chegar

| Caminho | Quem usa | Como |
|---|---|---|
| **`+ TELA` na barra do espectador** | quem já está assistindo um amigo e o outro entra no ar | botão na barra (atalho `A`) → diálogo "ASSISTIR JUNTO" |
| **Link composto** `tela.gg/soumbra+ana` | quem manda os dois de uma vez na call | abre direto em multivisão; no app, `tela://assistir/soumbra+ana` |
| **Trilho ASSISTIR do app** | desktop | o campo aceita `soumbra+ana`, ou dois links colados |

O diálogo "ASSISTIR JUNTO" reaproveita o `DialogoAssistir` (mesmo campo, mesma
validação `canalDaEntrada`) e acrescenta **canais recentes**: até 6 nomes que
este aparelho já assistiu, como teclas. Um toque e pronto. Ficam só no
navegador (porta `storage`), nunca no servidor.

### 1.2 O palco

```
 PAISAGEM / DESKTOP (padrão: PiP)          LADO A LADO (L)
┌──────────────────────────────────────┐  ┌──────────────────┬──────────────────┐
│                                      │  │                  │                  │
│            PRINCIPAL                 │  │    PRINCIPAL     │    SECUNDÁRIA    │
│        (som, barra, zoom)            │  │   (borda âmbar)  │                  │
│                          ┌─────────┐ │  │                  │                  │
│                          │ ● ana   │ │  ├──────────────────┴──────────────────┤
│                          │  PiP    │ │  │ barra da principal                  │
│                          └─────────┘ │  └─────────────────────────────────────┘
├──────────────────────────────────────┤
│ ● soumbra · 3 · 48 ms · 1080p60 … [+TELA] [⧉] [⛶] │
└──────────────────────────────────────┘

 CELULAR EM PÉ (automático: empilhado)
┌──────────────┐
│  PRINCIPAL   │   o 16:9 de cima é o que hoje já aparece;
├──────────────┤   o preto que sobra embaixo vira a secundária.
│  SECUNDÁRIA  │   tocar nela troca.
├──────────────┤
│ barra        │
└──────────────┘
```

- **PiP:** 16:9, ~24% da largura do palco (mín. 192 px, máx. 480 px), canto
  inferior direito acima da barra, borda de 2 px, LED e nome do canal no rodapé
  do quadro. Três tamanhos (`[` e `]`). Arrastar solta no canto mais próximo
  (4 cantos), lembrado no aparelho.
- **Lado a lado:** para a mesma partida. A principal (a que tem som) leva a
  borda âmbar. Clicar na outra troca.
- **Celular em pé:** empilhado automaticamente. Deitado volta ao PiP.
- **Tela cheia leva o palco inteiro.** A PiP vai junto, o que o PiP nativo do
  navegador não faz.

### 1.3 Interações

| Ação | Mouse | Toque | Teclado |
|---|---|---|---|
| Trocar principal ↔ secundária | clique na PiP | toque na PiP | `T`, ou `Enter` com a PiP focada |
| Mover a PiP | arrastar (solta no canto) | arrastar | — |
| Tamanho da PiP | botão no quadro | botão no quadro | `[` / `]` |
| Lado a lado ↔ PiP | botão na barra | botão na barra | `L` |
| Fechar a secundária | `×` no quadro | `×` (sempre visível no toque) | `X` |
| Adicionar | `+ TELA` | `+ TELA` | `A` |

- Clique e arrasto se separam por um limiar de 6 px: soltar abaixo dele é
  clique (troca), acima é arrasto.
- A PiP é um `button` com `aria-label="Trocar para <canal>"`, focável na ordem
  natural (depois do palco, antes da barra). O anel de foco é o da `tecla`.
- Ações do quadro (`⇄`, tamanho, `×`) aparecem no hover e no foco. No toque
  o `×` fica sempre visível, com área de toque de 44 px.
- **Animação da troca:** FLIP de 220 ms (`transform` + `opacity`, nada de
  `width`/`height`), `ease-out`. Com `prefers-reduced-motion`, instantânea.
- A URL acompanha (`/ana+soumbra` depois da troca), e o título da aba vira
  `● soumbra + ana · Tela`.

### 1.4 Estados da secundária

Cada painel tem a própria `ViewerSession` e a própria máquina de estados; a
PiP mostra uma versão miniatura do `OfflineState`:

| Estado da sessão | O quadro mostra |
|---|---|
| `watching` | o vídeo |
| `connecting` / `checking` | "SINTONIZANDO" com os blocos, em miniatura |
| `offline` | "AGUARDANDO <canal>". Quando entra no ar, o LED acende e o quadro pisca uma vez |
| `full`, `recusado`, `removido`, `sem-conexao` | o motivo em uma linha, mais `TENTAR` e `×` |
| pausada pela guarda de banda | último quadro congelado, escurecido, com "PAUSADA · sua rede" e `RETOMAR` |

A principal continua com a tela inteira de estados de hoje. Se a principal
cai e a secundária está ao vivo, aparece um aviso "ana está ao vivo — TROCAR"
(sem troca automática: mudar o que a pessoa olha sem ela pedir desorienta).

---

## 2. Arquitetura

Camadas do `AGENTS.md`, setas para dentro.

```
core/multivisao/estado.ts         puro: reducer da multivisão
core/multivisao/guarda-de-banda.ts  puro: quando pausar a secundária
core/domain/canais-da-rota.ts     puro: "a+b" ⇄ [a, b] (SLUG_RE, sem repetir, máx. 2)
core/identity/canais-recentes.ts  porta storage: os 6 últimos
react/use-painel-de-canal.ts      UMA sessão: stream, som, latência, stats, estado
react/use-multivisao.ts           o reducer + URL + atalhos
components/QuadroPip.tsx          burro: vídeo + rótulo + ações
components/DialogoAssistirJunto.tsx  burro
routes/Viewer.tsx                 compõe 1 ou 2 painéis
```

- **`core/multivisao/estado.ts`**: `{ canais: [principal, secundaria?],
  layout: 'pip' | 'lado-a-lado', canto, tamanho, pausada }` e as ações
  `adicionar`, `trocar`, `remover`, `mudarLayout`, `moverPip`,
  `redimensionar`, `pausar`, `retomar`. `Result` para o que é esperado
  (`CANAL_REPETIDO`, `LIMITE`, `CANAL_INVALIDO`), sem `throw` (R4).
- **Uma rota, não duas.** `parseRoute` passa a devolver
  `{ name: 'viewer', slugs: [a] | [a, b] }`. Adicionar a segunda NÃO pode
  remontar a primeira, então os dois casos são o mesmo componente, e a URL
  muda por `replaceState`.
- **Os painéis são estáveis por canal, não por posição.** `key={slug}`; a
  troca muda a classe de cada um. É isso que garante "trocar não reconecta"
  (ADR 0032 §4).
- **Som:** `use-painel-de-canal` recebe `audivel: boolean`. A secundária fica
  `muted` sempre. `informarReproducao` diz à sessão que o mudo é escolha, para
  o classificador não chamar de "sem som".
- **Não repassar:** a sessão em multivisão abre com a opção de não aceitar
  filhos da cascata. Conferir no M3 como o espectador se oferece hoje; se não
  houver como recusar, acrescentar a opção na sessão (sem mudar o protocolo,
  se possível).
- **Servidor:** nada (R8). O Worker já manda `/*` para o SPA. A prévia do
  link composto (`soumbra + ana · 2 ao vivo`) é opcional, no M4.

---

## 3. Marcos (um por vez, com parada para o dono)

| Marco | Entrega | Prova |
|---|---|---|
| **M0 — refatoração** | extrair `use-painel-de-canal` do `Viewer.tsx`. **Zero mudança de comportamento**, commit próprio | testes atuais verdes; `e2e/mesh.e2e.mjs` igual |
| **M1 — duas telas** | `canais-da-rota`, reducer, rota `a+b`, PiP fixa no canto, troca por clique, som segue, `×`, `+ TELA` com diálogo | unidade (reducer, rota); e2e com dois anfitriões de canvas: os dois recebem quadros; a troca não muda o `srcObject` nem reabre sessão |
| **M2 — o palco bom** | arrastar para os cantos, 3 tamanhos, lado a lado, empilhado no celular em pé, FLIP, atalhos, recentes, título da aba | unidade; screenshots headless em 1280×800, 390×844 em pé e deitado |
| **M3 — guarda de banda** | pausa da secundária por rede ou decodificação, `RETOMAR`, não repassar | unidade da guarda com séries do vigia; e2e com perda induzida |
| **M4 — extras** (opcional) | prévia do link composto, `/tela canal:a+b`, `tela://assistir/a+b`, sincronia para a mesma partida, grade de 4 | cada um com o próprio teste |

Estimativa grosseira: M0 meio dia; M1 1–2 dias; M2 1–2 dias; M3 1 dia.

---

## 4. O que só humano verifica

| O quê | Como |
|---|---|
| Custo de decodificar 2 × 1080p60 | notebook fraco, gerenciador de tarefas: CPU/GPU com 1 e com 2 canais |
| Banda real | dois canais 1080p60 numa conexão de 50 Mbps: a secundária segura? a guarda dispara quando devia? |
| iPhone/Safari | dois `<video>` inline tocando ao mesmo tempo, um mudo |
| App desktop | `tela://assistir/a+b` abre direto em multivisão |
| Sensação da troca | a troca "parece instantânea"? A PiP atrapalha o HUD do jogo no canto escolhido? |

---

## 5. Riscos

- **A PiP cobre o HUD do jogo.** O canto padrão (inferior direito) é onde
  muitos jogos põem o minimapa, como no LoL. Mitigação: arrastar para
  qualquer canto, lembrado por aparelho. Se os testes mostrarem que o
  inferior direito atrapalha demais, o padrão passa a ser o superior direito.
- **Dois áudios do jogo + a call.** Resolvido por desenho: só a principal
  tem som.
- **Autoplay.** A secundária nasce muda (o autoplay mudo é sempre
  permitido). A principal segue a regra de hoje (`AudioUnlock`).
