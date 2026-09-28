# ADR 0008 — Disciplina de cor: papéis, contraste e escassez do acento

**Status:** aceita, **paleta e tipografia substituídas pela [ADR 0022](0022-identidade-crt-ambar.md)** · **Data:** 2026-08-23
**Altera:** §11 da documentação técnica (valores de dois tokens)

> A identidade mudou (âmbar sobre grafite; Silkscreen, Jersey 10 e Martian Mono). Continuam valendo o princípio de um papel por token, a exigência de 3:1 para contorno interativo (1.4.11) e "nenhum estado só por cor". Os hex e a tabela abaixo são históricos.


## Contexto

A §11 define a paleta e uma regra: o acento é "exclusivamente para AO VIVO e o
botão primário". Ao medir a implementação, dois problemas objetivos e um de
disciplina:

| Token | Contraste no fundo | Situação |
|---|---|---|
| `muted` #6B6B76 | **3,80:1** | Reprova em texto pequeno (WCAG AA pede 4,5:1) — e era o token de bitrate, latência e contagem |
| `line` #232329 | **1,28:1** | A borda não existe para quem enxerga pouco. Era o contorno de campos e botões |

E o acento tinha vazado para oito lugares: anel de foco, ponto de slug válido,
marca de copiado, seleção de qualidade, overlay de áudio, barra de progresso,
mensagem de sucesso. Quando tudo é destaque, nada é.

## Decisão

### 1. Um papel por token, escrito

A tabela vive em `globals.css`, no topo. Se faltar uma cor, o que falta é um
papel — não um hex.

| token | papel | contraste |
|---|---|---|
| `void` | fundo absoluto | — |
| `surface` | painel elevado | — |
| `line` #1F1F26 | divisor **decorativo** dentro de painel | 1,2:1 (invisível de propósito) |
| `edge` #5E5E69 | contorno de controle **interativo** | 3,1:1 |
| `faint` #55555F | texto decorativo (placeholder, separador) | 2,7:1 |
| `muted` #8A8A96 | metadado legível | 5,9:1 |
| `text` #EDEDF0 | conteúdo | 17:1 |
| `accent` #22E07A | AO VIVO e botão primário. Só. | 11,5:1 |
| `warn` #FFB020 | degradado mas funcionando | 10,9:1 |
| `danger` #FF4D4D | parar e erro | 6,1:1 |

**Desvio da §11:** `muted` muda de #6B6B76 para #8A8A96, e `line` se divide em
`line` (divisor) e `edge` (controle). O critério não é gosto — é a WCAG 1.4.11,
que exige 3:1 quando a borda é o **único** jeito de saber que ali existe um
campo. Era exatamente o caso.

### 2. O acento volta a ser escasso

Sobrou em dois lugares: o indicador AO VIVO e o botão primário. Uma exceção
declarada: o anel de foco, porque acessibilidade vale mais que pureza de
paleta, e ele é transitório.

Tudo que era acento por hábito virou o que de fato é: seleção usa contorno
forte, confirmação usa ícone, progresso usa metadado.

### 3. Nenhum estado é comunicado só por cor

O campo de slug tinha um ponto verde/vermelho e nada mais — invisível para
daltônico e para quem está com a tela no sol. Agora: ícone (check ou alerta),
frase, e a cor reforçando. Vale para todo estado do produto.

### 4. A tela inicial volta a ser um botão e um campo

Não é cor, mas apareceu na mesma revisão e é da mesma família de problema. A
escolha de qualidade tinha virado quatro cartões e o áudio, um parágrafo com
comando de terminal — juntos empurravam o botão para 10% da página e
transformavam a home num painel de configuração, o oposto da tese do produto.

Qualidade virou uma linha com a explicação do preset selecionado. Áudio virou
um resumo de uma linha que abre sob demanda. O botão voltou a dominar.

## Consequência

Todo estado do produto tem uma cor previsível: verde é "no ar", âmbar é
"funcionando pior", vermelho é "parou ou falhou", cinza é metadado. Um estado
novo escolhe entre esses quatro em vez de inventar.

## Nota sobre a paleta em si

A paleta continua sendo a da §11. Vale registrar que "fundo quase preto com um
único acento verde ácido" é hoje um dos visuais mais repetidos em interface
gerada por IA — a orientação de design consultada nomeia esse exato padrão como
um default, não uma escolha.

Aqui ele **é** uma escolha, e está no documento fundador: a anti-referência
declarada é Zoom/Teams/Meet e a referência é Parsec/Kick, num produto onde o
jogo precisa ser a única fonte de luz da tela. O brief venceu. Mas se um dia a
identidade for reaberta, este é o parágrafo para reler antes de manter o verde
por inércia.
