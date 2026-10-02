# ADR 0030 — Aquecimento por caminho e porta pela banda

**Data:** 2026-10-01
**Estado:** proposta
**Complementa:** 0018 (as malhas mediam a própria atuação), 0023 (sonda), 0029 (teto de 50) · **Mantém:** R5 (adaptação coletiva), R8 (o servidor não vê mídia)

## Contexto

A ADR 0029 abriu 50 vagas e `e2e/malhas.sim.mjs --escala` (N ∈ {10, 20, 50},
1032 cenários) mediu o que a malha fazia com elas: **87 salas presas abaixo do
que o link pagava** e **187 afogando o link**. Nenhum dos dois aparece com
N ≤ 5.

### 1. O recém-chegado derrubava a sala (76 dos 87 absorventes)

Rastreado em `up300-n20-iguais-nenhuma-escalonada-ausente`: a sala estava em
900p60 a 9,96 Mbps por caminho; no segundo 22 o vigésimo espectador conecta e
a sala cai para 720p60 a 6,55 — e nunca mais sobe.

Um caminho novo nasce com a estimativa no `x-google-start-bitrate` (o que já
enviamos aos outros) e o AIMD do libwebrtc sobe 8 %/s até encostar no teto de
`1,5 × acked` seis segundos depois. Nesse intervalo a leitura dele vale a
METADE da dos caminhos assentados (`1,08 × enviado` contra `1,5 × enviado`), e
entrava no mínimo do governador CRUA, na primeira amostra. Com o ruído de −20 %
o mínimo caía 40 %, a histerese de corte (30 %) disparava e todos desciam um
degrau por causa de quem acabou de chegar. É a ADR 0018 de novo: a leitura
falava da subida do caminho, não do link.

E uma vez embaixo, não subia. Subir sem sonda exige `alvo/aplicado ≥ 1,06`
com a razão alcançável `1,125 × (1 − viés do mínimo de N)`. O viés do mínimo de
N caminhos suavizados (ruído residual ≈ 4,4 %) é ~5 % com N = 5, ~8 % com N =
20, ~10 % com N = 50: **a partir de dez caminhos nenhum degrau sobe sozinho.**
A sonda da ADR 0023 só disparava depois de uma descida por COLAPSO, e esta
descida não era colapso.

### 2. A escada descia até onde não há imagem (187 afogando)

Exatamente as células em que `piso × N > upload`: 5 Mbps com 20 ou 50, 10 e
20 Mbps com 50. A adaptação coletiva faz o certo — todos descem juntos — mas
desce até 200 kbps por pessoa, abaixo do piso de 360p60, e o encoder continua
pedindo mais do que o cano tem. Faltava a PORTA: parar de admitir quando a
próxima pessoa leva todo mundo abaixo do piso.

## Decisão

### A. Aquecimento por caminho (`AQUECIMENTO_POR_CAMINHO = 8`)

Um caminho só vota no mínimo do governador, no pior caminho do freio rápido
(`piorAvailableBps`) e na evidência de colapso (`bandwidth`) depois de **oito
amostras** — o mesmo aquecimento que o primeiro caminho sempre teve, pelo mesmo
motivo. Oito é o que a média móvel (α = 0,25) leva para o peso da primeira
leitura cair a 10 %, e cobre os seis segundos do AIMD até o teto. Durante o
aquecimento o caminho é suavizado (`availablePorPeer` continua cru e completo)
mas não decide.

Exceção, para nunca mandar algo absurdo a um recém-chegado: um caminho que diz
carregar **menos de 60 % do que cada caminho recebe** (`ABSURDO_POR_CAMINHO`)
vota na hora. A subida parte do que enviamos e, no pior ruído, lê 80 % disso;
abaixo de 60 % não é subida, é um amigo em ADSL — e ele derruba a sala na hora,
como a R5 manda. `cpu` de um caminho novo também conta: é a máquina.

Se ninguém assentou ainda (todos entraram juntos), todos votam.

### B. A sonda sobe depois de QUALQUER descida (altera a 0023)

A 0023 restringia a sonda ao pós-colapso para não trocar estabilidade por
reconfiguração num link pequeno. O discriminador certo nunca foi a origem da
descida: é a **folga da estimativa sobre o envio** (`≥ 1,3×`), que já era
condição da sonda. Num link saturado o AIMD recua a 0,85 da fatia e a
estimativa fica RENTE ao envio — a sonda não dispara. Onde dispara e falha, a
espera dobra (15 → 240 s), como antes.

E a sonda que falha **volta para onde estava**, não para onde a queda a levou.
O sobreuso que ela mesma causa recua o estimador, e `0,75 ×` disso fica abaixo
do orçamento que funcionava: medido na sala de 50 em 300 Mbps, sondar 720p a
partir de 600p terminava em 480p, com a espera já em 240 s. Se o link caiu de
verdade no mesmo instante, as leituras seguintes cortam a partir do valor
restaurado.

### C. Porta pela banda (`capacidade-pela-banda.ts`, mensagem `capacidade`)

Com N caminhos medidos e orçamento `b` por caminho, o upload útil é `b·N`;
admitir mais um dá `b·N/(N+1)` a cada um, e cabe enquanto isso fica no piso do
menor degrau `p`:

```
b·N/(N+1) ≥ p   ⟺   ⌊b·N/p⌋ ≥ N+1      →   capacidade = ⌊b·N/p⌋
```

nunca abaixo de N (ninguém é expulso), nunca acima do que a máquina codifica.

**Mas `b` não serve sozinho (ADR 0018).** `b = 0,75 × estimativa`, e a
estimativa é tampada em `1,5 × acked`. Quando somos nós o limitador — todo link
com sobra — `b ≈ 1,125 × enviado` e `b·N` passa do útil em 1,5×: um
espectador a 16 Mbps num link de 20 "cabia" 8 pessoas no piso (16,5 Mbps num
útil de 15). O que fala do link em qualquer regime é o que SAI dele:

```
por caminho = min(b, 0,75 × enviado)
```

Sem sobreuso o link carrega pelo menos `N × enviado`; com sobreuso `enviado` é
a fatia que ele dá. É medido NESTE segundo, então uma leva de entrantes que
faz N saltar não multiplica um `b` velho por um N novo. Refinamentos:

- `FOLGA_DE_ADMISSAO = 10 %`: o AIMD trabalha entre 0,85 e 1,0 da fatia depois
  de um recuo; admitir até o piso exato deixaria o fundo da escada abaixo dele
  a cada recuo.
- `FOLGA_DE_DESCIDA = ½ vaga`: `⌊·⌋` numa fronteira inteira abriria e fecharia
  uma vaga por um fio de ruído. Fechar exige meia vaga faltando; abrir, a vaga
  inteira.
- Cena parada (`encoderOcioso`, a mesma guarda do governador) não fecha vaga.
- `CAPACIDADE_ATE_MEDIR = 5`: até a primeira medição vale o teto que o produto
  sempre prometeu antes da 0029. Com 50 vagas antes de medir, 50 amigos
  clicando juntos entrariam num link que paga 3 — e aí ninguém mais sai. Num
  link farto são duas rodadas até 50 (5 → ~26 → 50).

A sessão calcula a cada amostra e manda `{ type: 'capacidade', valor }` ao
servidor quando muda. As duas implementações (Node e Durable Object) fazem
`teto = min(servidor, máquina, banda)` SEM tirar ninguém: só a próxima pessoa
recebe `CHANNEL_FULL` com o teto real. O Durable Object guarda o valor no
attachment do host (sobrevive à hibernação); o host que reconecta começa sem
teto pela banda e a sessão reenvia em `signaling-restored`. `PROTOCOL_VERSION`
continua 5: o servidor sobe antes dos clientes e cliente antigo nunca manda a
mensagem — subir a versão expulsaria toda aba aberta por algo que ela não usa.
A sessão expõe `vagasPelaBanda` no estado; `maxPeers` continua sendo o teto da
máquina.

## Medido

Simulador, premissas padrão. Sala grande (`--escala`, 1032 cenários):

| métrica | antes | depois |
|---|---|---|
| estado absorvente | 87 | **0** |
| afogando o link (> 10 % do tempo) | 187 | **1** |
| governador mudo | 0 | 0 |
| recusou gente que o link pagava | — | **0** |
| bpp entregue < 0,10 | 473 | 150 |
| abaixo de 80 % do que o link pagava | 169 | 49 |
| reconfigurações (mediana) | 11 | 21 |
| entrada atrasada pela porta (p90 / máx) | — | 85 s / 295 s |

Os 150 quadriculados são 144 em 5 Mbps de upload: cinco entram antes de medir
e o link paga um. O afogando restante é `up5-n10-fraco-sustentada20-escalonada-errada-baixa`
a 10,5 %: os mesmos cinco em 5 Mbps, que na matriz normal (`up5-n5-*`, 48
células) ficam entre 6 e 10 % — o governador caça a parede do link em ciclos de
~30 s (sobe 6 % por decisão enquanto a estimativa está colada em `1,5 × acked`,
bate, corta 30 %). Não é a porta: é a célula `up5-n5` com outra semente de
ruído. O portão da sala grande continua em zero; a correção principiada é
outra — memória da parede no governador, como o estado *near max* do
`AimdRateControl` —, e fica para uma ADR própria.

Matriz normal (`--portao`, 1200 cenários, N ≤ 5):

| métrica | antes | depois | teto |
|---|---|---|---|
| quadriculado | 70 | 72 | 90 |
| mudos | 0 | 0 | 0 |
| absorventes | 1 | **0** | 10 |
| abaixo do link | 138 | **128** | 175 |
| afogando | 81 | 83 | 175 |

A porta não age com N ≤ 5 (zero recusas). Os +2 de cada lado são o custo da
sonda aberta: células `fraco` + `blips5` em que o link paga um degrau e meio —
a sonda sobe para o degrau que cabe fisicamente (sem os 25 % de folga), o
governador caça a parede e o sobreuso vai de 8–9 % a 10,2–10,5 %. Os +2
quadriculados são oito entradas e seis saídas, todas entre 0,085 e 0,098 bpp
em células de 5 Mbps. Em troca, dez cenários a menos presos abaixo do link e
nenhum absorvente.

## Custo aceito

- Uma reconfiguração a cada entrada de porta que muda, e mais sondas: mediana
  de 25 para 30 reconfigurações em 300 s na matriz normal.
- Quem chega numa sala farta antes da segunda medição vê "sem vaga" por 10 a
  25 s e entra sozinho (o backoff de `CHANNEL_FULL` do espectador é 7,5 s, 17 s,
  30 s). Encurtar isso é no espectador, ou com um aviso de vaga do servidor.
- O espectador fraco que entra passa oito segundos recebendo o que a sala
  envia antes de puxá-la para baixo — a não ser que leia menos de 60 %.

## O que continua sem verificação

1. **O aquecimento de 8 s contra o libwebrtc real.** O simulador é pessimista
   no tempo de subida (P1): com as sondas iniciais do `ProbeController` o
   caminho encosta no teto antes. Medir em `chrome://webrtc-internals`, com um
   terceiro espectador entrando: `availableOutgoingBitrate` dos dois primeiros
   não deve cair e o `maxBitrate` dos senders não deve mudar.
2. **`e2e/qualidade.e2e.mjs`** (dois Chrome reais) — o coordenador roda:
   parâmetros idênticos entre peers continuam valendo (R5) com a entrada
   escalonada.
3. **A porta em rede real:** com um link de ~20 Mbps e seis amigos, o sexto
   deve ver "sem vaga · N/N" com o N do link, não 50, e entrar quando alguém
   sair. E a sala não deve descer abaixo de 360p60 com os admitidos.
4. **Hibernação de verdade** no Cloudflare: o teto pela banda sobrevive
   (coberto no driver de teste, não na plataforma).

## Portão da sala grande (decisão do coordenador)

O único `afogando` que restava na matriz `--escala` era
`up5-n10-fraco-sustentada20-escalonada-errada-baixa`: cinco espectadores
entram antes da 1ª medição (`CAPACIDADE_ATE_MEDIR`, o comportamento anterior à
ADR 0029) num link de 5 Mbps que paga um. É a célula `up5-n5` da matriz normal
com outra semente — a malha caçando a parede do link, que o portão de sempre
já cobra. O portão `--escala` passa a contar `afogando` só em sala que passou
dos cinco iniciais (`admitidos > 5`): ele existe para a sala GRANDE. Resultado:
`--escala --portao` 0/0/0/0; `--portao` dentro dos tetos (72/0/0/128/83).
