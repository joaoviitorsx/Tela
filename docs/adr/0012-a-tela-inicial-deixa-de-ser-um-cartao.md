# ADR 0012 — A tela inicial deixa de ser um cartão

**Status:** aceita · **Data:** 2026-08-24
**Altera:** a §4 da ADR 0008 (o que "o botão domina" quer dizer)

## Contexto

A tela inicial era uma chapa arredondada de 1180px flutuando sobre o vazio, com
a palavra "tela" em minúsculas no canto e tudo dentro dela: campo, botão,
qualidade, áudio, uma coluna de 380px explicando por que o produto existe, e o
caminho do vídeo no rodapé.

Quatro problemas, e nenhum é gosto.

**O cartão.** A referência declarada do produto é painel de aparelho de vídeo
(Parsec, Kick) e a anti-referência é cromo de aplicativo (Zoom, Teams, Meet).
Painel não tem canto arredondado flutuando no ar. Uma chapa sobre o vazio lê
como formulário hospedado numa página, que é exatamente o cromo que a §11 da
documentação técnica manda evitar.

**A coluna da direita.** "Por que isto existe" ocupava 380px permanentes para
explicar o produto a quem acabou de clicar no link dele. Três fatos moravam
ali, e nenhum estava onde é útil.

**O eixo.** O conteúdo do cartão começava em x=154 e o rodapé em x=130. Cinco
regiões, dois eixos, nenhuma leitura de aparelho.

**O nome.** "tela" em 15px de Geist semibold é o mesmo desenho do nome de
qualquer aplicativo, e era a única coisa que identificava o produto na tela.

## Decisão

### 1. Faixas na largura da janela, não um cartão

Cinco faixas atravessando a janela, separadas por filetes de 1px: identificação,
canal, console (qualidade e áudio), caminho do vídeo, rodapé. Quem respeita a
coluna de 1180px é o CONTEÚDO, não a moldura. Todo elemento começa no mesmo x.

A regra de preenchimento da ADR 0008 continua valendo e não mudou: `surface`
só nas regiões que não se toca (identificação, caminho, rodapé), `void` onde há
controle, porque `edge` mede 2,92:1 sobre `surface` e 3,13:1 sobre `void`.

### 2. Os três fatos da coluna vão para onde são úteis

| Fato | Para onde foi |
|---|---|
| "até 5 ao mesmo tempo" | virou DESENHO no caminho do vídeo — cinco marcas que acendem quando o pulso chega |
| "a aba precisa ficar aberta" | ao lado do TRANSMITIR, que é onde a decisão acontece |
| "o link é seu enquanto o navegador for" | uma linha no rodapé, junto do contexto da ANPD |

A coluna some. Nenhuma informação some.

### 3. O caminho do vídeo anda

O elemento-assinatura do produto era um diagrama parado. Agora um pulso
atravessa a reta em 2,2 s, cada nó acende quando o pulso passa por ele, e no
fim ele acende as cinco saídas em sequência.

O movimento carrega informação, não decoração: mostra a direção do pixel e
mostra que a mesma imagem sai cinco vezes da própria máquina — que é a resposta
para "por que o teto é cinco", e era um parágrafo numa coluna de texto.

Ciclo de 3,2 s: 2,2 s de viagem e 1,0 s de descanso. Sem o descanso vira
marquee, e marquee no rodapé de uma tela onde a pessoa está digitando é
exatamente o tipo de animação infinita que atrapalha. Cinza, nunca verde.

Declarado dentro de `prefers-reduced-motion: no-preference`: quem pediu menos
movimento recebe o mesmo desenho parado, e não perde informação — ela está na
FORMA (a reta, as cinco marcas), o movimento só a apressa.

### 4. O botão divide a linha com o aviso

**Aqui a §4 da ADR 0008 muda de leitura.** Ela pede que o botão domine a tela
inicial, e a implementação anterior traduziu isso como "ocupar a coluna
inteira" — 860×56 de verde puro, com a metade direita da faixa vazia ao lado.

O acento é o recurso mais escasso da paleta, e ali ele era a maior área de cor
da tela. Em 300px o TRANSMITIR continua sendo o único elemento verde, o maior
alvo e o mais alto contraste da página; o espaço que sobrava passa a explicar o
que acontece depois de apertá-lo. No celular volta a empilhar.

Dominar é ser o único acento e o maior alvo. Não é ser a maior área pintada.

### 5. A marca ganha um vidro, e as etiquetas ganham uma condensada

O nome passa a viver dentro de uma plaqueta com a mesma pilha de camadas da
abertura em escala de nameplate: scanline de 3px, roll bar lenta, vinheta.
Quem viu o tubo se abrir reconhece o tubo na faixa de identificação, e a mesma
ideia reaparece em três tamanhos — plaqueta, abertura, tela de espera.

A §11 da documentação técnica pede "tipografia condensada" desde o começo e
isso nunca saiu do papel. Entra **Barlow Condensed** como `--font-etiqueta`,
em dois lugares e em nenhum outro: a marca e as serigrafias. Texto corrido
continua em Geist — condensada em parágrafo cansa — e número continua em Geist
Mono, porque tabular vale mais que estilo.

A borda da plaqueta é `line`, não `edge`: ela não é um controle, e `edge` tem
um papel escrito. Quem desenha o retângulo é o degrau de `void` sobre `surface`.

## Consequência

Nenhuma cor nova, nenhuma exceção nova ao acento, nenhuma funcionalidade nova
(R6). O que mudou foi onde as coisas moram e o que o desenho diz sozinho.

Uma coisa nova para quem for mexer: `data-vidro` marca as caixas que a abertura
mede no DOM vivo para desenhar o esqueleto da home dentro do tubo (ADR 0011,
desvio 5). Elemento de layout novo em regra visível na tela inicial merece o
atributo; esquecer só deixa a sintonia mais pobre, não quebra nada.

## Custo

`grid-cols-2` virou `grid-cols-3` no seletor de qualidade: a escada tem seis
degraus desde a ADR 0010, e em duas colunas o controle ficava mais alto que o
botão primário no celular.

CLS medido da página: 0,00016, todo ele troca de fonte (o campo mono e o link
da faixa), nada do handoff da abertura. Uma terceira família custa isso.
