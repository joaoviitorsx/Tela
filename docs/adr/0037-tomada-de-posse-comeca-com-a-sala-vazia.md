# ADR 0037 — A tomada de posse depois da carência começa com a sala vazia

**Data:** 2026-10-04
**Estado:** aceita (achado N-1 da revisão de segurança, 2026-10-04)
**Altera:** a reapresentação de plateia e pedidos no `claim` do Worker
(`apps/signaling/src/worker.ts`) · **Mantém:** a reconexão de cinco minutos do
MESMO dono (ADR 0028), que segue reapresentando quem já assistia; a carência
`OWNERSHIP_GRACE_MS = 5 min`; R8 (payload opaco) e R4 (falha tipada, sem
`throw`)

## Contexto

A carência guarda o slug para o dono reconectar depois que o transmissor cai
(F5, troca de rede, crash). Dentro dela, um token diferente é recusado com
`SLUG_TAKEN` — a promessa "o link é seu" (ADR 0026/0028). Vencida a carência, o
slug fica livre: qualquer token pode assumir.

O achado N-1 é sobre o que acontece com a PLATEIA e os PEDIDOS do transmissor
anterior quando um token diferente assume depois da carência. O transmissor é
quem oferece a mídia; ao assumir, ele é apresentado a quem já está no canal
(`peer-joined`) e aos pedidos em espera (`join-request`, ou admissão direta na
sala aberta). Essa reapresentação existe para a RECONEXÃO do próprio dono não
perder a audiência (ADR 0028). Se ela valer também para um estranho, o estranho
herda a audiência de outra pessoa: vê os nomes e impressões de quem pediu para
entrar, e passa a ofertar mídia para quem achava que assistia o streamer
original. É se passar pelo streamer diante dos amigos dele.

## Prova (quem é afetado)

Medido lendo o código das duas implementações, com a suíte de conformidade
(`apps/signaling/src/conformance.test.ts`) exercitando o caminho em ambas.

**Node (`channel-registry.ts`) — NÃO explorável.** A posse é a EXISTÊNCIA da
entrada no `Map`. Em `claimChannel`, `existing = channels.get(slug)` e
`ehDono = equals(existing.ownerHash, ownerHash)`; `existing !== undefined &&
!ehDono` recusa com `SLUG_TAKEN` (linha ~260). O canal só é descartado por
`reap` quando `host === null && viewers.size === 0 && pedidos.size === 0`
(linha ~130). Logo, enquanto houver QUALQUER plateia ou pedido a herdar, a
entrada existe e um token estranho é recusado — a carência vencida não abre
porta, porque o teste de posse é por existência, não por tempo. Quando o canal
fica vazio de verdade, ele é descartado e o estranho cria um canal novo, sem
nada para herdar. Não há caminho de herança. Não foi alterado.

**Worker (`worker.ts`) — explorável, foi onde a revisão reproduziu.** A posse
sobrevive à hibernação em `storage[CHAVE_POSSE] = { ownerHash, ate }`.
`donoAtual()` devolve o hash do host conectado ou, sem host, a posse guardada —
mas, se `ate <= agora`, APAGA a posse e devolve `null` (linha ~451). Numa queda
sem `leave`, `handleClose` guarda a posse e NÃO derruba a plateia (a mídia é
direta; ADR 0023), então os sockets dos espectadores e dos pedidos seguem
abertos no objeto. Passados os cinco minutos, `donoAtual()` devolve `null`
embora a plateia ainda esteja lá. Um `host` com token qualquer cai no ramo de
"slug livre" (`donoPrevio === null`), assume, e os laços finais de `claim`
reapresentam `this.viewers()` e `this.pedidos()` ao recém-chegado (linhas
~828–845) — na sala aberta, `admitir()` os entrega direto. A posse é
decidida pelo TEMPO da chave guardada, desacoplada de a plateia ainda existir;
é essa diferença de modelo (existência × tempo) que o Node não tem.

## Decisão

Opção (a) da revisão: na TOMADA por um token diferente, começar com a sala
vazia.

No Worker, `claim` passa a distinguir reconexão de tomada. A seção crítica
devolve `reconexao = dono !== null` — se há dono (e já passou pelo `equals`), é
o MESMO dono reconectando; se `dono === null`, o slug estava livre e quem
assume é outra pessoa. Quando NÃO é reconexão, `reiniciarCanal()` fecha a
plateia (`removido` antes do `close`, para o `webSocketClose` atrasado não
mandar `peer-left` ao novo host) e recusa os pedidos herdados com
`NOT_HOSTING`. Só então os laços de reapresentação rodam — agora sobre uma sala
vazia. A reconexão do mesmo dono não passa por `reiniciarCanal` e segue
herdando plateia e pedidos, intacta.

O Node não muda: já recusa a tomada enquanto houver o que herdar, que é uma
garantia mais forte que "sala vazia". As duas implementações concordam no que
importa — o recém-chegado nunca é apresentado à audiência de outra pessoa.

R8 e R4 preservados: nada lê `payload`/SDP, e a tomada continua devolvendo
`Result` tipado (`SLUG_TAKEN` no Node; `hosting` com sala vazia no Worker),
sem `throw`.

## Consequências

- **Aceito:** depois da carência, a plateia e os pedidos do transmissor
  anterior são descartados numa tomada por token diferente. A mídia deles já
  estava morta havia cinco minutos (o host anterior sumiu); quem quiser voltar
  dá `watch` de novo e entra limpo no novo transmissor.
- **Aceito (divergência Node × Worker):** uma tomada por token diferente, com
  plateia ainda pendurada, recebe `SLUG_TAKEN` no Node e `hosting` com sala
  vazia no Worker. O Node é mais conservador (segura o slug enquanto houver
  qualquer socket no canal); o Worker liberta o slug no fim da carência. Os
  dois cumprem a propriedade de segurança: nenhuma herança. A conformidade
  afirma a propriedade comum, não a mensagem exata.
- **Aceito:** uma reconexão do MESMO dono DEPOIS da carência também cai como
  "sala vazia" no Worker (a posse já foi apagada e o hash anterior se perdeu),
  enquanto no Node ela ainda herdaria se a plateia tiver segurado o canal. A
  carência é a janela prometida de reconexão; fora dela não há promessa, e o
  caso é raro (host fora por mais de cinco minutos com espectador ainda
  pendurado). Não vale guardar o hash para sempre só por isso.

## Verificação

`apps/signaling/src/conformance.test.ts`, bloco "N-1: a tomada de posse não
herda a sala (ADR 0037)", nas duas implementações:
- reconexão do mesmo dono, dentro da carência, herda plateia e pedidos;
- token diferente depois da carência começa com a sala vazia — sem
  `peer-joined`, sem `join-request`, sem o id da vítima no que o intruso
  recebe.

Para vencer a carência sem esperar o tempo real, os drivers ganharam `avancar`:
no Node adianta o `TestClock`; no Worker adianta o relógio injetado em
`ChannelDeps.now` (ausente em produção, onde é `Date.now`). Um teste afirma que
`OWNERSHIP_GRACE_MS` é o mesmo nos dois.

## Não verificável por mim (humano)

Nada novo de GPU/rede. Convém confirmar em produção (Cloudflare) que, cinco
minutos após o transmissor cair de verdade, um segundo navegador com outro
`ownerToken` assume o slug e abre numa sala vazia — sem ver a plateia nem os
pedidos do primeiro.
