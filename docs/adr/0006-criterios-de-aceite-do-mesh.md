# ADR 0006 — Critérios de aceite do MeshTransport (M2)

**Status:** aceita · **Data:** 2026-08-23
**Origem:** auditoria independente sobre `adapters/p2p-transport.ts`

## Contexto

`p2p-transport.ts` será reescrito como `mesh-transport.ts` no M2, com
`PeerLink` (perfect negotiation) e `MeshTopology` conforme o changeset 001 §7.

Uma auditoria independente provou quatro defeitos no adapter atual. Corrigir
código que será reescrito é desperdício — mas perder os achados é pior: são
defeitos de **desenho de negociação**, e uma reescrita ingênua os reintroduz.

## Decisão

Os quatro viram critério de aceite do M2. Cada um precisa de um teste com
`FakeSignalingChannel` **antes** de o milestone ser considerado pronto.

### A1 — Espectador que chega antes do `publish()` não pode ser perdido

`offerTo` saía cedo quando `request === null`, e o peer nem entrava no mapa —
então o `publish()` seguinte, que itera os peers conhecidos, não o recuperava.
O espectador ficava em "conectando" para sempre.

A janela é real: `transport.connect()` e `transport.publish()` são duas
chamadas, e o `peer-joined` cai no meio.

**Aceite:** um `peer-joined` recebido antes da primeira publicação resulta em
oferta enviada assim que a mídia existir. Teste: joined → publish → exatamente
uma oferta para aquele peer.

### A2 — Falha ao ofertar não pode deixar PeerConnection zumbi

Se `createOffer`/`setLocalDescription` lançasse, o peer já tinha sido inserido
no mapa: sobrava uma `RTCPeerConnection` contando como espectador, sem oferta
nenhuma no ar. E como a chamada era `void offerTo(...)`, virava unhandled
rejection.

**Aceite:** falha na negociação remove o peer e emite a mudança de contagem.
Nenhuma rejeição sem tratamento.

### A3 — Renegociação concorrente precisa ser serializada por peer

Duas chamadas de `publish` para o mesmo peer se intercalavam: a segunda
fechava a PC da primeira, e a primeira retomava o `await` numa PC já fechada
(`InvalidStateError`).

O gatilho está no `BroadcastSession`: `trackCpuPressure` dispara
`void this.transport.publish(...)` sem esperar, e o usuário pode chamar
`setPreset` no mesmo instante.

**Aceite:** fila por `peerId`; dois `publish` concorrentes resolvem os dois,
sem PC órfã. E `trackCpuPressure` passa a tratar a rejeição.

**Nota de desenho:** com o `adaptAll` do changeset (§7.2), trocar preset deixa
de renegociar — é `setParameters` nos senders existentes. Isso remove a causa
raiz, não só o sintoma, e é o motivo de o changeset estar certo aqui.

### A4 — Entrada de espectador não pode dar pico no bitrate do HUD

`StatsSampler` guarda a soma de `bytesSent` de todos os peers. Um espectador
novo entra com bytes já acumulados e o delta salta — o HUD reportou 8,2 Mbps
onde o real era 1 Mbps.

**Aceite:** o `getAggregateStats` do changeset (§6) acumula por peer, não a
soma bruta. Entrada e saída de espectador não produzem pico nem buraco.

## Também vale registrar

A auditoria **retirou** uma suspeita: a mescla de chaves em `readStats`
(`${merged.size}:${key}`) é feia mas correta — nenhuma colisão é possível.
Registrado para que ninguém "conserte" o que não está quebrado.

## O que já foi corrigido e não é dívida do M2

Os defeitos das sessões (`BroadcastSession`, `ViewerSession`), do hub e do
rate limit já estão corrigidos na main, com regressão. Ver commits
`b3c7df6`, `13d64af`, `d7cea9d` e `300462d`.

Em particular, o teto de 15s na negociação do espectador (`ViewerSession`)
protege contra A1 mesmo antes de o M2 existir: uma negociação que trava agora
vira nova tentativa em vez de aba presa.
