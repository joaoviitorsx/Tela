# ADR 0014 — O aparelho ao lado do campo

**Status:** aceita · **Data:** 2026-08-24
**Toca:** a regra de escassez do acento da ADR 0008

## Contexto

A metade direita da faixa do canal está vazia desde que a coluna "por que isto
existe" saiu (ADR 0012). O pedido foi pôr ali o mesmo CRT da abertura, girando
como numa vitrine e reagindo ao clique.

Um objeto 3D girando ao lado de um formulário é, por padrão, enfeite caro:
paga contexto WebGL, modelo e GPU contínua para não dizer nada.

## Decisão

**O aparelho é o monitor do canal que está sendo criado, não um enfeite.**

O que a pessoa digita aparece no tubo. Campo vazio, o tubo mostra chiado e
`SEM SINAL` — que é literalmente o que o canal é antes de ter nome. As três
lâmpadas da lateral, que já vinham modeladas, são o estado do nome.

Isso resolve o problema de fundo: o objeto não é ilustração do produto, é uma
segunda superfície do mesmo dado. Se a regra do slug mudar, o tubo muda junto,
porque ele lê do mesmo lugar que o campo.

### O movimento

Pêndulo de ±26° em 13 s, e não giro de 360°. As costas do gabinete são uma
caixa lisa: num giro completo, metade do ciclo mostra um bloco cinza e esconde
justamente a peça que dá nome ao produto. O seno já desacelera nos extremos, o
que dá a volta sem easing escrito à mão.

Sobre isso, duas reações: o aparelho se inclina na direção do cursor, e o
clique dá um empurrão de giro com recuo de escala e um estouro de chiado na
tela — o gesto de trocar de canal. O clique também **põe o cursor no campo**.
Um objeto de 340 px que responde ao toque e não leva a lugar nenhum é enfeite
caro com etapa extra.

A invariante "nunca mostra as costas" é teste, não esperança: amplitude,
paralaxe e impulso somados dão 0,99 rad contra 1,57 de teto, e o teste varre o
período inteiro com o ponteiro nos cantos e o clique no auge.

### O acento numa lâmpada, e por que isto não fura a ADR 0008

A ADR 0008 reserva o verde para AO VIVO e o botão primário. Aqui ele acende
numa lâmpada de 8 px quando o nome está livre, com o texto `PRONTO PARA IR AO
AR` embaixo.

O argumento é que **é o mesmo estado, um passo antes**. A tabela da ADR 0008 diz
"verde é no ar, âmbar é funcionando pior, vermelho é parou ou falhou", e manda
todo estado novo escolher entre eles em vez de inventar. Âmbar enquanto confere
e vermelho quando o nome não serve caem na tabela sem discussão; o terceiro
estado é "pronto para ir ao ar", e a alternativa seria deixar a lâmpada verde
apagada para sempre num aparelho que a tem modelada — o que lê como defeito, não
como disciplina.

Nada aqui é comunicado só por cor (§3 da mesma ADR): o tubo escreve o estado por
extenso, e o campo ao lado já traz ícone e frase.

### Não aparece no celular

`hidden lg:block`. Em 390 px a faixa do canal já ocupa a tela com campo, aviso e
botão; um aparelho de 340 px empurraria o TRANSMITIR para baixo da dobra —
trocar o botão principal por um enfeite é o oposto do que a ADR 0008 pede. E é
GPU contínua na bateria de quem está com o celular na mão.

## O custo, e o que foi feito com ele

Esta cena **não termina**. Ela vive enquanto a tela inicial estiver aberta, o que
pode ser horas com o jogo rodando na mesma GPU. A §11 da coreografia já tinha
decidido o padrão para esse caso — 12 fps e pausa total com a aba oculta — e
este é o mesmo padrão, com folga:

| | |
|---|---|
| taxa | 30 fps por quadro contado. O pêndulo leva 13 s para ir e voltar; 60 não muda nada que o olho perceba |
| aba oculta | `setAnimationLoop(null)`. **Medido: 0 desenhos** |
| fora da viewport | `IntersectionObserver`. Rolar até o console já para. **Medido: 0 desenhos** |
| `prefers-reduced-motion` | laço desligado. Desenha uma vez e só volta a desenhar quando o estado do canal muda |
| sair da home | `dispose()` de geometria, material, textura e contexto |

Bundle: **zero byte a mais**. O three.js já vinha por `import()` dinâmico para a
abertura, e as duas cenas caem no mesmo pedaço. O `.glb` é o mesmo arquivo, já
no cache do navegador quando a vitrine pede — a abertura acabou de baixá-lo.

Antes disso, `adapters/crt-modelo.ts` passou a concentrar o que as duas cenas
não podem deixar divergir: o carregamento, a restauração do `side: BackSide` dos
contornos de casca invertida e o descarte da GPU. As três têm armadilha, e a do
contorno já derrubou a abertura uma vez (ADR 0011).

## Uma regra que se inverteu

Na abertura, as scanlines são obrigatoriamente em espaço de tela (§4): a câmera
entra no tubo e em UV elas engrossariam até virar listras.

Aqui é o contrário. A câmera não se move e o tubo GIRA — em espaço de tela as
linhas ficariam paradas enquanto o vidro roda por baixo, como se estivessem no
monitor de quem olha em vez de no tubo. Em UV elas giram junto com o vidro, que
é onde elas moram num CRT de verdade.

A regra da §4 não era "espaço de tela sempre"; era "as scanlines pertencem ao
tubo". Nas duas cenas, o que preserva isso é uma implementação diferente.

## O que fica em aberto

Quanto custa em bateria, de verdade, num notebook com o jogo rodando. As pausas
foram medidas em desenhos por segundo, não em watts, e o teto de 30 fps é
julgamento — não medição — sobre o que o olho percebe num pêndulo de 13 s.
