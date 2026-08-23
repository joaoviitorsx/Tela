# ADR 0005 — Mesh P2P como transporte primário

**Status:** aceita · **Data:** 2026-08-23
**Origem:** `docs/TELA-changeset-mesh.md` §1
**Substitui:** ADR 0001 (LiveKit como SFU) e a §12 da documentação técnica

## Contexto

Duas restrições novas surgiram depois de os documentos originais serem escritos:

1. **Orçamento zero.** Não há servidor a pagar nem a administrar.
2. **O projeto também é peça de portfólio.**

O SFU (LiveKit) resolvia o problema de escala — dezenas de espectadores por
transmissor. Esse problema não existe aqui: a sessão real é uma pessoa jogando
e 2 a 3 amigos assistindo.

## Decisão

Transporte primário passa a ser **mesh P2P**: cada espectador recebe uma
`RTCPeerConnection` direta do transmissor. Nenhum vídeo passa por servidor.

`MediaTransport` continua sendo a interface. LiveKit não é removido do
desenho — vira um adapter alternativo documentado, não implementado, em
`adapters/_reference/`.

## Consequências

| | |
|---|---|
| + | Custo de infraestrutura: zero, permanente |
| + | Latência menor — sem hop de servidor (~30–50ms a menos) |
| + | Sem VM para administrar, sem Docker, sem firewall |
| + | Portfólio mais forte: WebRTC de baixo nível em vez de config de SFU |
| + | Escopo cai de 6 milestones para 4 |
| − | Teto de 3 espectadores simultâneos |
| − | Upload do transmissor multiplica por espectador |
| − | Sem simulcast — adaptação vira responsabilidade nossa |
| − | ~15–20% das conexões dependem de TURN de terceiro com cota |

## Invariante que define a arquitetura

**O servidor de signaling nunca vê um byte de mídia.** Ele repassa `payload`
opaco: não parseia SDP, não inspeciona ICE, não guarda histórico.

Consequência observável: se o signaling cair no meio de uma transmissão, as
conexões já estabelecidas continuam funcionando — só novos espectadores não
entram. Se você se pegar escrevendo lógica de mídia no servidor, parou de ser
mesh (nova regra R8 do AGENTS.md).

## A regra contraintuitiva

**Todos os peers recebem parâmetros de encoding idênticos.**

O Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s com parâmetros
iguais — um encode, três envios. Variar bitrate por peer vira três encoders, e
o FPS do jogo despenca.

Portanto adaptação é **coletiva**: se um espectador tem rede ruim, ou ele
aguenta o que está sendo enviado, ou todos descem juntos um degrau. É a quarta
regra de mídia do AGENTS.md R5, e a que mais parece errada à primeira vista.

## Relação com a ADR 0002

A ADR 0002 já havia adicionado P2P como transporte **alternativo**, mantendo o
SFU como padrão. Esta ADR inverte: mesh vira o único transporte vivo, e o custo
que a 0002 documentava como opcional (N encoders, N× upstream, teto de 3,
dependência de TURN na cauda) passa a ser o custo permanente do produto.

A análise técnica da 0002 continua válida na íntegra — em particular a seção
sobre CGNAT e por que "zero infraestrutura" nunca serve 100% dos usuários.
