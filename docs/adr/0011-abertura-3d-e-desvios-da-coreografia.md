# ADR 0011 — A abertura 3D, e onde ela desviou da coreografia

**Status:** aceita · **Data:** 2026-08-24
**Altera:** nada. Implementa `TELA-coreografia-abertura.md` e registra os desvios.

## Contexto

A especificação de coreografia chegou com números fechados: keyframes de
câmera, opacidades por camada, easings nomeados, critérios de aceite. Ela abre
dizendo "onde este for omisso, pergunte — não invente". Este ADR é a resposta:
o que foi implementado como está escrito, o que foi derivado, e por quê.

O modelo (`assets/3d/tela-crt.origem.glb`) chegou junto e tem proporções
diferentes das que a §1 descreve. É de lá que vem quase todo desvio.

## O que ficou literal

Duração de 1,80 s. Os quatro keyframes de câmera da §3, com os três easings
nomeados. As sete camadas da §4 e seus quadros-chave. Os três rasgos de
sintonia com amplitude decrescente. O barril da §5 com
`cubic-bezier(.33,1,.68,1)`. A pilha do §7, o skip do §8 sem aceleração, o
escudo de 250 ms, a variante de `prefers-reduced-motion` da §9, o chiado
gerado do §10. A abertura é muda.

Medido: **1,808 s** (`performance.measure('tela:abertura')`), `k1 = 0` em
`t = 1,80`, canvas removido do DOM com o contexto WebGL descartado, CLS do
handoff em zero.

## Os desvios

### 1. A escala do modelo não sai da §1

A §1 fixa o espaço pela altura do tubo: 1,0 unidade. Neste modelo o gabinete e
as antenas valem **três vezes** o tubo, então o aparelho ficaria com 3,04
unidades numa janela inicial de 1,69 — estourando o quadro por todos os lados.
O que apareceria em `t = 0` é um retângulo escuro com um vidro no meio, e o
objeto 3D que a abertura existe para mostrar seria irreconhecível.

A §1 descreve as proporções do modelo que ela imaginava. O que ela e a §3
querem é o aparelho no quadro. Então o modelo é encaixado na janela inicial
nos dois eixos, ocupando 86% dela — nos dois eixos porque num celular em pé a
janela é estreita e encaixar só pela altura corta o gabinete pelas laterais.

### 2. Onde o dolly para é derivado, não fixado

A §3 termina em `z = 0,26`. Esse número existe para o vidro cobrir a janela
inteira em `t = 1,80` — sem isso o handoff mostra a moldura e o critério "o
crossfade não denuncia" cai.

Cobrir a janela é geometria, e depende da PROPORÇÃO dela. Num monitor 16:10 a
conta dá **0,258** — que é o 0,26 escrito na §3. Num celular em pé o modelo é
menor (desvio 1), o vidro é menor, e a 0,26 a moldura aparece.

Por isso `sampleIntro(t, zFinal)`: a trilha da §3 continua uma só, o trecho do
dolly é reescalado para terminar onde a janela pede, e tudo antes de
`t = 1,15` fica intocado. Com `zFinal = 0,26` a função é a identidade — a
coreografia da especificação é o caso padrão, não um caso especial.

### 3. O quadro de aquecimento roda depois do modelo, não antes

A §2 põe o quadro de aquecimento no passo 4, dentro de um orçamento total de
150 ms (passo 5). Medido num Chrome headless: desenhar um triângulo custa
**0,3 ms** e ABRIR o contexto WebGL custa **189 ms** — a primeira criação de
contexto numa aba paga o aperto de mão com o processo de GPU.

Ou seja: perguntar "tem WebGL?" já estourava o orçamento, e a abertura era
reprovada pelo custo do próprio termômetro. Em toda visita.

Agora o passo 3 é detecção de construtor (microssegundos) e o passo 4 mede o
**quadro zero da cena de verdade**, com `gl.finish()`, depois de o modelo
chegar — o que é mais perto do que a §2 pede ("renderiza 1 frame de
aquecimento") do que um triângulo sintético jamais foi. Quem reprova já baixou
208 KB; em troca, quem passa vê a abertura.

### 4. Prazo de rede, sobre o qual a §2 é omissa

Depois de a sondagem aprovar, o modelo tem 700 ms para chegar. O `.glb` é
pré-carregado pelo `index.html` em paralelo com o bundle, mas "em paralelo" não
é "instantâneo" num 4G. Enquanto espera, o canvas já está de pé pintado de
`void`, que é a cor do `body`: para quem olha, é a página carregando. Estourou
o prazo, a abertura some — abertura que arranca depois de a pessoa já ter visto
a tela é pior que abertura nenhuma.

### 5. A interface dentro do tubo é o contorno do DOM vivo, não um instantâneo

A §6 manda usar a opção A — renderizar a home para imagem — com um requisito
absoluto: mesma largura de viewport do DOM real, senão o crossfade denuncia.

**Não existe API de navegador que fotografe o DOM.** As saídas reais são
`foreignObject`, que não enxerga as fontes carregadas pela página e recalcula a
largura de cada palavra, ou uma dependência nova só para isso.

O que está implementado satisfaz o requisito por construção e não é a opção C
(recriar a UI, que a §6 proíbe por criar duas fontes de verdade): a camada L3
é o **contorno das caixas da home, medido com `getBoundingClientRect` no DOM
vivo** durante a sondagem. Não há segunda fonte para divergir — a régua é o
próprio layout — e a escala bate porque é a mesma janela.

Também é melhor: um CRT sintonizando mostra estrutura antes de detalhe, que é
exatamente o que os três rasgos da §4 encenam.

### 6. As camadas de conteúdo são amostradas em espaço de tela

Para as scanlines isso é a própria §4 ("período em espaço de tela, não em UV" —
em UV elas engrossam durante o dolly). Aqui vale também para chiado, interface
e roll bar, e é o que torna o handoff exato: em `t = 1,80`, com `k1 = 0`, o
pixel da textura está no mesmo lugar do pixel do DOM em qualquer viewport, sem
calcular projeção nenhuma.

Enquanto o vidro é menor que a janela, a página é reduzida para caber DENTRO
dele — um aparelho de TV mostra a imagem inteira, não um pedaço dela. O fator
satura em 1,0 quando o dolly faz o vidro cobrir a janela.

Efeito colateral, e é intencional: a interface não dá zoom junto com o tubo. O
tubo é que se abre em volta dela até sair de quadro. A moldura desaparece e a
interface já estava lá, no tamanho final.

A ignição (L1) e a vinheta (L6) continuam na UV do quadrilátero: as duas são
gestos DO TUBO, não do conteúdo.

### 7. Onde a §12 diverge da §4, vale a §4

A "tabela consolidada" da §12 traz valores intermediários que não batem com as
tabelas por camada da §4 (chiado em 0,96, scanlines em 1,45, `k1` em 1,45). As
tabelas por camada trazem o easing nomeado; a §12 é leitura arredondada de
amostras. Os dois critérios de aceite que dependem disso — duração e
`k1 ≤ 0,01` — valem em qualquer das duas leituras.

## O asset

`scripts/build-3d.mjs` leva o `.glb` de **3,57 MB para 208 KB** (94% menor,
124 KB em gzip), preservando os 46 nomes de nó, que são contrato com o
renderizador. O que sai: 1,31 MB de `extras` (o exportador do Three despejou
`Object3D.toJSON()` em cada nó), as normais, e float32 que vira inteiro
quantizado (`KHR_mesh_quantization`, nativo no three.js, sem decoder no
bundle).

Duas correções que o formato exigiu, e as duas têm sintoma visível:

- **Todo material vira unlit.** No arquivo de origem só `chiado` e os
  `contorno_*` eram unlit; gabinete, moldura, antena, LEDs e placa saíram como
  PBR, e PBR numa cena sem luz renderiza PRETO. Acrescentar luz traria o
  degradê que a §11 da documentação técnica proíbe no produto inteiro.
- **`side: BackSide` é restaurado em runtime.** O glTF só tem `doubleSided`;
  "só o verso" não é uma das opções, e é exatamente o que um contorno de casca
  invertida precisa. Sem isso as cascas infladas renderizam as faces da frente
  e o aparelho inteiro fica preto — não é problema de espaço de cor, é o
  contorno cobrindo a peça que deveria contornar.

## Custo

`three` é a primeira biblioteca de renderização do projeto: 613 KB (158 KB
gzip) num pedaço à parte, atrás da port `core/ports/intro-stage.ts` e carregado
por `import()` dinâmico só quando a sondagem já decidiu que a abertura vai
rodar — nunca na segunda visita, que é a maioria das visitas. O bundle
principal não mudou de tamanho.

## O que ainda precisa de humano

- O quadro de aquecimento e o skip foram medidos em rasterizador por software,
  onde um quadro custa 58 ms. Numa GPU de verdade os dois números caem uma
  ordem de grandeza, e o critério "skip percebido em ≤ 100 ms" só se verifica lá.
- Se o dolly com `cubic-bezier(.55,0,1,.45)` — que segura 56% do percurso para
  os últimos 23% do tempo — lê como imersão ou como solavanco. É a §14 que pede
  ease-in, e ela tem razão sobre o ease-out; a intensidade é julgamento em
  movimento, não em quadro parado.
- O 3/4 inicial da §3 é uma inclinação de 7,3°. A §3 diz que ele existe "para
  provar que é 3D"; num objeto de cor chapada, 7° podem não provar nada.
