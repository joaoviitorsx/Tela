# ADR 0013 — A abertura roda em toda visita

**Status:** aceita · **Data:** 2026-08-24
**Altera:** o passo 1 da §2 e um critério de aceite da §13 da coreografia

## Contexto

A coreografia manda bypassar quem já viu:

> 1. `localStorage.getItem('tela.intro.seen')` → se existe, `BYPASS`

E a §13 cobra isso como critério: *"Segunda visita: canvas nunca é criado"*.

Implementado assim, a abertura aparecia uma vez por navegador e nunca mais. Na
prática ela só era vista por quem chegava de link novo ou limpava o
armazenamento — ou seja, quase ninguém depois do primeiro dia.

## Decisão

A abertura roda **em toda visita a `/`**. `tela.intro.seen` deixa de ser
gravado e deixa de ser lido; a chave sai do código.

O restante da §2 fica: `prefers-reduced-motion` continua caindo para a variante
parada, a ausência de WebGL continua desligando a cena, o quadro de aquecimento
continua cortando máquina fraca, e o prazo do modelo continua valendo.

O escopo é a tela inicial, e só ela. Quem abre `tela.gg/joao` — o amigo que
recebeu o link — continua caindo direto no vídeo. Espectador não veio ver
abertura; veio ver o jogo.

## Por que o custo é menor do que parece

O bypass da §2 existia para não cobrar 1,80 s de quem já conhece a cena. Duas
coisas que já estavam no desenho da própria especificação seguram esse custo:

- **O DOM real está montado, opaco e interativo desde `t = 0`** (§7). O canvas
  é uma folha por cima com `pointer-events: none` — a página nunca fica
  bloqueada, nem se o WebGL travar.
- **Qualquer toque, tecla ou rolagem pula direto para o fim** (§8), e o skip
  não acelera o que falta: salta ao estado final. Quem já viu não espera
  1,80 s, espera o tempo de encostar na tela.

O que sobra de custo é banda e GPU. A banda foi resolvida junto: `_headers`
passa a mandar `max-age=604800, stale-while-revalidate=86400` no
`/tela-crt.glb`. Sem isso seriam 208 KB por visita; com isso, uma vez por
semana, e a troca de versão acontece em segundo plano.

Sete dias e não `immutable`, que é o que os outros assets usam: o nome do
arquivo não tem hash de conteúdo — ele é referenciado por caminho fixo no
`preload` do `index.html` e no adaptador — e `immutable` por um ano deixaria um
modelo velho preso no navegador de quem já visitou.

## Consequência

O critério de aceite "segunda visita: canvas nunca é criado" está **revogado**.
Se alguém restaurar o bypass, o lugar é `core/intro/probe.ts`, e o teste
`roda de novo a cada visita` é o que vai falhar primeiro — de propósito.

`?abertura=0` continua existindo e agora é o único jeito de pular a cena sem
mexer em código. Serve para quem estiver depurando a tela inicial e não quiser
1,80 s a cada recarga.

## O que fica em aberto

Se a abertura vai cansar quem transmite todo dia é pergunta que só o uso
responde. O sinal para observar é a taxa de skip: se quase todo mundo pula,
o que a cena está fazendo é atrasar o produto, e aí a saída não é voltar o
bypass por navegador — é encurtar a coreografia.
