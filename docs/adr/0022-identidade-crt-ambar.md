# ADR 0022 — Identidade CRT âmbar

**Data:** 2026-09-28
**Estado:** aceita
**Substitui:** a paleta e a tipografia da ADR 0008 (a "disciplina" da 0008 continua)
**Mantém:** R5 (nenhum parâmetro de encoding muda aqui), ADR 0011/0013 (a abertura) e ADR 0014 (a TV na vitrine)

## Contexto

O dono do produto entregou o protótipo v3 (`Tela Prototipo v3.dc.html`): a
interface como o menu na tela de um televisor, em âmbar sobre grafite, com
teclas de relevo, rótulos bitmap e números de placar. Ele contradiz a 0008 em
dois pontos objetivos:

| | 0008 | protótipo v3 |
|---|---|---|
| acento | verde `#22E07A`, só para AO VIVO e botão primário | âmbar `#f2a93b`, ação primária, seleção, título de painel |
| tipografia | Geist, Geist Mono, Barlow Condensed | Silkscreen, Jersey 10, Martian Mono |

A 0008 dizia, no último parágrafo, que se a identidade fosse reaberta aquele
era o texto para reler antes de manter o verde por inércia. Foi reaberta, e o
brief mudou. Esta ADR registra o que ficou e o que foi medido no caminho.

## Decisão

### 1. Tokens, um papel cada, contraste medido

Vivem em `@theme` no `globals.css`, com a tabela no topo do arquivo. Contraste
é a razão de luminância relativa da WCAG 2.x, calculada sobre os hex.

| token | hex | papel | sobre `void` | sobre `surface` |
|---|---|---|---:|---:|
| `deep` | `#050506` | recuo: moldura, campo do canal | — | — |
| `void` | `#0b0c0e` | fundo do app | — | — |
| `bar` | `#0e0f11` | cabeçalho e rodapé | — | — |
| `surface` | `#111215` | painel | — | — |
| `key` | `#1b1c20` | tecla secundária | — | — |
| `line` | `#26231b` | divisor **decorativo** | 1,25 | 1,19 |
| `edge` | `#6b6252` | contorno de controle **interativo** | 3,26 | 3,12 |
| `faint` | `#5c5648` | desabilitado, decoração | 2,68 | 2,57 |
| `dim` | `#8a8272` | rótulo pequeno legível | 5,14 | 4,92 |
| `muted` | `#b5ab96` | texto secundário | 8,60 | 8,23 |
| `text` | `#ece3cf` | conteúdo | 15,33 | 14,68 |
| `accent` | `#f2a93b` | ação primária, seleção, título de painel | 9,80 | 9,38 |
| `accent-hi` | `#ffc766` | fósforo: números e o slug | 12,69 | 12,14 |
| `ok` | `#8fd694` | confirmado, dentro do esperado | 11,38 | 10,89 |
| `warn` | `#e7c68a` | funcionando pior (sempre com "!") | 11,97 | 11,45 |
| `danger` | `#ff8a76` | texto de parar e de erro | 8,53 | 8,16 |
| `live-hi` | `#ff6a52` | LED e NO AR | 6,93 | 6,63 |

Texto sobre preenchimento: `ink` (`#14100a`) sobre `accent` 9,49 e sobre
`accent-hover` 11,01; branco sobre `live` (`#b3261a`) 6,54; `danger-ink` sobre
`danger-bg` 9,42; `warn` sobre `warn-bg` 11,13; `muted` sobre `warn-bg` 8,00.
Tudo acima de 4,5:1 (AA para corpo pequeno).

### 2. O que medi e mudei em relação ao protótipo

O protótipo usa `#3b3528` como contorno de quase tudo (1,6:1) e `#4a4538` no
relevo das teclas (2,1:1). Isso é decoração e continua sendo — o `line`. Mas
onde a borda é o único jeito de saber que um campo ou uma opção existe, a WCAG
1.4.11 pede 3:1, e esse papel é o `edge`: `#6b6252`, 3,26:1 sobre `void`.

Outros ajustes, todos medidos ou verificados na tela:

- **`dim` nunca sobre `key`.** `#8a8272` sobre `#1b1c20` dá 4,47:1, um
  centésimo abaixo de AA. Texto de tecla é `text` (13,34:1).
- **Piso de 11px** nos rótulos bitmap. A Silkscreen desenhada em 8px vira
  borrão abaixo disso; o protótipo usava 9 e 10.
- **Anel de foco** de 2px em `accent-hi` (12,69:1 sobre `void`). Sobre o âmbar
  ele sumiria, então nos títulos e nas linhas selecionadas do menu o anel é
  `ink` (9,49:1) e por dentro. No botão primário é `text`.
- **Estado nunca só por cor** (a 0008 §3 continua): o "!" bitmap marca o que
  pede atenção — necessário porque âmbar agora também é a cor da ação —, o "✓"
  marca o passo concluído, e o texto da nota diz o que mudou.

### 3. O acento deixou de ser escasso; o vermelho ficou

A 0008 reservava o acento a duas coisas. Aqui o âmbar é a cor da interface
inteira (ação, seleção, títulos), então escassez não é mais o mecanismo. O que
carrega o papel de "ao vivo" é o **vermelho**: `live` e `live-hi` aparecem só
em NO AR / AO VIVO, e `danger` só em parar e erro. A tabela de estados da 0008
("verde é no ar") vira: vermelho é no ar, verde é confirmado, areia com "!" é
funcionando pior, cinza é metadado.

### 4. Tipografia

- **Silkscreen** — rótulos, botões, títulos de painel. Só existe em caixa alta
  (o texto no DOM continua em minúsculas, o que importa para o E2E e para leitor
  de tela). Piso 11px.
- **Jersey 10** — números de placar (contagens, resolução, tempo no ar) e o slug
  digitado. Tem minúsculas, então o link se lê como se escreve.
- **Martian Mono** — texto corrido e identificadores, 12–13px. Monoespaçada de
  propósito: quem abriu o link errado compara letra a letra.

Carregadas do Google Fonts como as anteriores (`index.html`), com
`display=swap`. Nenhuma dependência nova.

### 5. O custo do CRT

O produto roda do lado de quem está jogando. O que é efeito e o que ele custa:

| efeito | quando | custo |
|---|---|---|
| scanlines + vinheta | sempre (chrome), **nunca** sobre o vídeo do espectador nem sobre a prévia | camada estática; zero repintura |
| chiado da troca de passo | 260 ms, uma vez, ao mudar de passo | some do DOM depois |
| número do canal | 3 piscadas e fica, ~1,6 s | some do DOM depois |
| chiado da sala de espera | só durante `conectando` (segundos) | `background-position` em passos |
| LED de NO AR / AO VIVO | contínuo | quadrado de 8 px |
| tudo | **pausado com a aba oculta** (`data-aba="oculta"`) | zero |
| tudo | **inexistente** sob `prefers-reduced-motion` (declarado só em `no-preference`) | zero |

A roll bar do protótipo (faixa clara descendo a tela a cada 7 s) **não foi
adotada**: era o único laço de tela cheia, e a informação que ela carregava é
nenhuma. `prefers-contrast: more` desliga as scanlines.

O ruído do chiado é um SVG `feTurbulence` ladrilhado em 160px. A primeira versão
usava `repeating-radial-gradient`, como o protótipo, e produzia moiré em tela
cheia — anéis gigantes que liam como defeito de renderização.

### 6. A abertura e a vitrine

Continuam como estão (ADR 0011, 0013, 0014). O que muda são **constantes de
cor** em dois adapters, e só isso:

- `three-crt-stage.ts`: as placas que a abertura pinta no vidro a partir do DOM
  (contorno, preenchido, acento, texto) passam a usar os tokens novos. Sem isso
  o crossfade da abertura para a home trocaria verde por âmbar no último quadro.
- `three-crt-vitrine.ts`: o slug no tubo sai em `accent-hi` (fósforo) e a
  legenda em Silkscreen; as lâmpadas usam `ok`, âmbar e `live-hi`. As fontes
  antigas (Barlow Condensed) deixaram de ser carregadas, e o canvas 2D cairia
  no fallback do sistema.

Os atributos `data-vidro` da tela inicial foram mantidos nos mesmos papéis:
`contorno` no campo, `acento` no botão, `texto` nos textos e `preenchido` onde
havia painel.

## O que o protótipo tinha e a interface não tem, e por quê

- **BAIXAR APP** e o modal do app desktop: o app não existe.
- **TESTAR REDE** e latência/perda por espectador: a sessão não mede nenhuma
  das duas. O diagnóstico mostra o que existe (`PeerInfo`, `MediaStats`).
- **Lista de janelas**: a web não enumera janelas; quem escolhe é o seletor do
  Chrome. O passo 02 mostra os tipos como orientação.
- **Linha "QUADROS 60/30"**: pela R5, 30 fps só existe dentro do modo
  `nitidez`, que troca `contentHint`, `degradationPreference` e framerate
  juntos (ADR 0015). Uma linha independente permitiria 30 fps com
  `maintain-framerate`, que é uma combinação que a R5 proíbe. A escolha
  "se a rede apertar: fluidez/nitidez" existe, no painel ao vivo, onde a sessão
  a aceita.
- **PiP simulado**: trocado pelo picture-in-picture nativo, só onde
  `document.pictureInPictureEnabled`.
- **Aprovação manual de espectador**: fica para depois.

## O que fica em aberto

- ~~`og.png` e `favicon.svg` continuam com a televisão verde.~~ Resolvido com a
  arte do dono: `favicon.svg`, `tela-tv.svg`, `tela-app-icon.svg` e a prévia de
  link `og-convite.png` (nome novo para furar o cache de prévia do Discord). A
  `theme-color` passou a ser o âmbar da arte, porque é ela que pinta a faixa
  lateral da prévia no Discord.
- **2026-10-02:** a logo passou a ser a arte nova do dono, a TV inclinada
  piscando sobre âmbar (`assets/marca/tela-logo.origem.png`). Dela saem
  `favicon.png` (64 px), `tela-app-icon.png` (256 px, também na `Marca`) e o
  ícone do desktop (`apps/desktop/build/icon.png`, 1024 px). `favicon.svg`,
  `tela-tv.svg` e `tela-app-icon.svg` saíram. A `og-convite.png` não mudou.
- A pintura do tubo depende de as fontes já estarem carregadas quando o canvas é
  desenhado. `document.fonts.ready` repinta, como já fazia; num primeiro acesso
  lento o tubo pode aparecer por um instante na fonte de fallback.
- Nada aqui mediu bateria. As pausas foram verificadas em desenhos, não em watts.
