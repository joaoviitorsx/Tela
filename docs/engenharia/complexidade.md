# Complexidade e desempenho dos caminhos quentes, de N=5 a N=50

**Data:** 2026-10-01 · **Contexto:** ADR 0029 (teto de 50, "um encode, N envios") e a cascata de repasse que vem depois · **Método:** ADR 0019 — medido em vez de deduzido; o que não dá para medir sem navegador está marcado.

Bancada: `e2e/bench/*.bench.mjs` (Node 22.23.1, AMD Ryzen 7 7435HS, 16 threads, 15 GiB, Linux 7.2.7). Mediana de 7 repetições, mais uma de aquecimento descartada, GC forçado entre elas. Os benchmarks importam o código REAL de `apps/web/src` e `apps/desktop/d0` (via `tsx`, como o simulador); as alternativas vivem só na bancada e são verificadas por equivalência de decisões antes de serem cronometradas.

```bash
node e2e/bench/fila-de-injecao.bench.mjs      # A1
node e2e/bench/copias-por-sender.bench.mjs    # A2
node e2e/bench/protocolo-captura.bench.mjs    # A4
node e2e/bench/stats-sampler.bench.mjs        # B1
node e2e/bench/sinalizacao-worker.bench.mjs   # C2
node e2e/bench/rede-malha-vs-arvore.calc.mjs  # D (calculadora, não benchmark)
```

## Notação

| Símbolo | Significado | Valor típico |
|---|---|---|
| N | espectadores | 5 … 50 |
| F | quadros por segundo | 60 |
| B | bytes de um quadro codificado | ~25 KB (P a 12 Mbps/60 fps); IDR ~150–300 KB |
| Q | quadros guardados na fila de injeção | 180 (`QUADROS_GUARDADOS`) |
| E | objetos num relatório de `getStats()` | ~60–120 por `RTCPeerConnection` |
| b | bitrate por espectador | 12,4 Mbps (piso 1080p60) … 16,2 (teto) |
| U | subida bruta de quem transmite | 10, 50, 100, 300 Mbps |
| k | grau da árvore de repasse | 2 … 6 |
| d | profundidade da árvore | ⌈log_k N⌉ aprox. |
| h | latência por salto | 25–60 ms (ver §D) |

## Tabela-síntese

"Custo a N=50" é por segundo de transmissão, na máquina da bancada, salvo indicação. "Estimado" = derivado, não medido aqui.

| # | Caminho | Frequência | O() hoje | O() melhor | Custo a N=50 | Prioridade | Recomendação |
|---|---|---|---|---|---|---|---|
| A1 | `FilaDeInjecao.vaga` (`recentes.find`) + `chegou` (`push/shift`) | F·N = 3 000/s | O(Q) por vaga → O(N·Q·F) | O(1) por vaga (anel por `seq`) | **1,0 ms/s** medido (342 ns/vaga); anel 0,24 ms/s | P2 | anel indexado por `seq % Q`; decisões idênticas (verificado) |
| A2 | `real.dados.slice(0)` por sender (worker) | F·N | O(N·B·F) bytes | O(N·B·F) — inerente ao spec | **8,7 ms/s**, 78 MB/s, 0,87 % de um núcleo (medido) | P3 | não é gargalo; manter |
| A3 | Chromium por sender: `SetData`, pacotização, SRTP, `sendmsg` | F·N·B/MTU ≈ 62 500 pacotes/s | O(N·B·F/MTU) | idem — só cai com repasse (§D) | **estimado 150–400 ms/s de thread de rede** (12–30 % de um núcleo) | **P0 medir** | é o custo que escala de verdade; procedimento em §F |
| A4 | `LeitorDoProtocolo` (`Buffer.concat` por pedaço) | F + eventos | O(B²/c) por mensagem | O(B) (lista de pedaços) | 0,5 ms/s a 64 KiB; 8 ms/s a 512 B; IDR 300 KB em 512 B: 88 MB copiados (295×) | P2 | parser com lista + offset; custo passa a ser determinístico |
| A5 | `injecao.mjs`: `postMessage` sem transferência | F | 1 clone de B | 0 (transfer) | 0,4 ms/s (7 µs/quadro) | P3 | transferir se o `MessagePortMain` aceitar |
| A6 | WebCodecs `copyTo` + `entrada` Map; isca (`fillRect` + `requestFrame`) | F | O(B) + O(1) | — | <1 ms/s | — | nada |
| A7 | `tela-captura.c`: `GQueue` de latência, 3 `write()` por quadro | F | O(1); 180 syscalls/s | `writev` → 60/s | desprezível | P3 | `writev` quando mexer no arquivo |
| B1 | `StatsSampler.readMany` (N relatórios × E objetos) | 1 Hz | O(N·E) | O(N·E) | **0,34 ms/tique** medido (6,7 µs/relatório) | — | nada no JS |
| B2 | `getStats()` por `RTCPeerConnection` (`collectStats`) | 1 Hz × N | O(N) chamadas, cada O(E) no Chromium | O(N/r) com rodízio, ou `sender.getStats()` | **estimado 50–150 ms/s de threads do Chromium + 4 500 objetos/s no heap JS** | **P1 medir** | rodízio (N/5 por tique, leitura retida por peer) + seletor por sender |
| B3 | `UplinkGovernor.observe`, `MalhaDeBanda`, `MeshTopology.effectiveBitrate` | 1 Hz | O(N) | O(N) | <0,05 ms/tique | — | nada |
| B4 | React: `setState` 1 Hz → `Broadcast` re-render, `vagas` (50 objetos), `SalaVagas` 50 `<li>` | 1 Hz | O(maxPeers) | O(1) com memo | estimado <1 ms/s | P3 | `useMemo` em `vagas` |
| B5 | `encode-once.getAggregateStats` → `recalcular()` → `configurar` | 1 Hz | O(1) | — | — | — | nada |
| C1 | Entrada de peer: `admit` → `PeerLink` → `applyPreset` (enfileirado) | por evento | O(1) por entrada; O(N) por troca de degrau (`adaptAll`) | — | troca de degrau: N `setParameters` da isca (nunca reconfigurada) | — | correto |
| C2 | Worker (DO): `relay()` desserializa 2(N+1) attachments por sinal | por sinal (~30 por entrada) | O(N) por sinal → O(N²) por entrada em massa | O(1) com índice | **163 µs/sinal; 245 ms de CPU do DO por entrada de 50** (proxy medido) | P1 | índice `Map<peerId>` reconstruído uma vez por mensagem (ou cache invalidado na escrita) |
| C3 | Node (`channel-registry`): `relay` por `Map`, presença O(N) por entrada | por evento | O(1) / O(N) | — | 1 275 mensagens `viewers` para 50 entradas | — | nada |
| C4 | IDR por PLI coalescido a 500 ms | por evento | B_IDR·N por IDR | — | **7,5 MB por IDR a N=50; até 2/s = 15 MB/s > 75 Mbps de link** (algebra) | **P1** | janela de coalescência ∝ N; NACK antes de PLI; na cascata, agregar PLI no repassador |
| D | Upload: malha U = N·b vs árvore U = k·b | — | O(N) | O(k) | ver §D: a 100 Mbps, 50 pessoas recebem 360p abaixo do piso em malha; 720p–1080p com repasse | — | fase da cascata |

**Leitura rápida.** Nada no JavaScript do produto é quadrático no caminho por quadro, e as duas suspeitas de custo por quadro (A1, A2) somam ~10 ms por segundo a N=50 — menos de 1 % de um núcleo. O custo que escala de verdade com N está DENTRO do Chromium (A3): 50 `RTCPeerConnection`s pacotizando, cifrando e enviando a mesma mídia 50 vezes, e 50 `getStats()` por segundo (B2). Nenhum dos dois cabe em benchmark Node; os dois têm procedimento de medição em §F. Fora do navegador, os únicos defeitos de classe de complexidade são o `Buffer.concat` do leitor (A4, O(B²/c)) e a varredura de attachments do Worker (C2, O(N) por mensagem).

---

## A. Por quadro (F × N por segundo)

### A1. `FilaDeInjecao` — `core/media/fila-de-injecao.ts`

**Hoje.** `recentes` é um array do mais velho para o mais novo. `chegou` faz `push` e, acima de Q, `shift`. `vaga` faz `recentes.find(q => q.seq === s.proximo)`.

O detalhe que decide a complexidade: um sender EM DIA quer o quadro mais NOVO, que está no fim do array. O `find` percorre as Q−1 entradas anteriores antes de achá-lo. O caso normal é o pior caso: **O(Q) por vaga, O(N·Q·F) por segundo = 50 × 180 × 60 = 540 000 comparações/s a N=50**. `shift` é O(Q) nominal (o V8 faz *left-trimming* e costuma ser mais barato que um memmove, mas não é O(1) garantido). `atraso()` é O(N) a 10 Hz: 500 operações/s, irrelevante.

**Melhor.** Os `seq` chegam em ordem e sem buraco (o codificador numera). Então "o quadro de `seq` s está guardado" ⇔ `ultimoSeq − Q < s ≤ ultimoSeq`, e ele está em `anel[s % Q]`. `chegou` vira uma escrita; `vaga` vira um teste de intervalo e um índice; `ponta` é `anel[ultimoSeq % Q]`; `primeiro.seq` é `max(0, ultimoSeq − Q + 1)`. **O(1) por operação, mesma memória (Q referências).**

**Medido** (`fila-de-injecao.bench.mjs`, 10 s simulados, 60 fps, Q=180; "em dia" = toda vaga consumida; "atrasados" = ⅓ dos senders consome a cada 2–3 quadros e estoura a janela):

| modo | N | vagas | atual (ms) | anel (ms) | ns/vaga atual | ns/vaga anel | ganho |
|---|---|---|---|---|---|---|---|
| em dia | 5 | 2 880 | 0,84 | 0,67 | 293 | 232 | 1,3× |
| em dia | 20 | 11 430 | 2,96 | 0,97 | 259 | 84 | 3,1× |
| em dia | 50 | 28 550 | **9,76** | **2,43** | 342 | 85 | 4,0× |
| atrasados | 5 | 2 204 | 2,73 | 0,49 | 1 237 | 224 | 5,5× |
| atrasados | 20 | 9 138 | 2,49 | 0,90 | 273 | 99 | 2,8× |
| atrasados | 50 | 22 933 | 6,31 | 2,30 | 275 | 100 | 2,7× |

Só `chegou()` × 100 000: `push`+`shift` 75 ns/quadro; anel 6 ns/quadro (12×).

Antes de cronometrar, a bancada executa os dois sobre o mesmo roteiro e compara CADA decisão (`enviar` com qual `seq`, `descartar` com ou sem `pedirChave`, e o valor de `atraso()` a 10 Hz): idênticas em todos os cenários e tamanhos.

**Importa a N=50?** Em valor absoluto, não: 1 ms por segundo de transmissão. Importa onde ele roda — no worker do Encoded Transform, no caminho de CADA quadro de CADA sender, entre o leitor e o escritor do stream; 340 ns de busca linear por vaga é jitter que não precisa existir, e o anel tira a dependência de Q (se Q subir para 600 a 60 fps para cobrir 10 s, o `find` sobe junto; o anel não). O ganho é 4× sobre um custo pequeno: **P2** — fazer, com o teste de equivalência da bancada virando teste unitário.

### A2. Cópia por sender no worker — `adapters/injecao-worker.ts`

**Hoje.** `quadro.data = real.dados.slice(0)` por sender. É inerente ao spec: o `data` de um `RTCEncodedVideoFrame` é um `ArrayBuffer` que a escrita desanexa; dois senders não podem compartilhar o mesmo. **O(N·B·F) bytes/s.**

**Medido** (`copias-por-sender.bench.mjs`, 25 KB por P, IDR de 150 KB a cada 2 s = 1,56 MB/s do codificador):

| N | MB/s copiados | ms por segundo | % de um núcleo |
|---|---|---|---|
| 1 | 1,6 | 0,29 | 0,03 % |
| 5 | 7,8 | 1,05 | 0,10 % |
| 20 | 31,3 | 3,54 | 0,35 % |
| 50 | **78,1** | **8,69** | **0,87 %** |

Alocação de N `ArrayBuffer`s de 25 KB por quadro, com GC: 7 ms/s a N=50 (75 MB/s alocados). O `setMetadata({...getMetadata()})` por sender é um objeto pequeno por vaga: 3 000 alocações/s, desprezível.

**Melhor.** Não há como fazer menos de N cópias no JS sem violar o spec. Dá para poupar UMA das N atribuindo `real.dados` ao último sender sem copiar (o buffer já não serve a ninguém) — 2 % a N=50. Não vale a sutileza. **P3: manter como está.** A hipótese "N·B·F de memcpy vai pesar" está refutada: 78 MB/s é <1 % de um núcleo, e o memcpy do Chromium na mesma ordem (ver A3) também.

O que a bancada não mede e fica para o navegador: a pressão de GC no worker com 3 000 `ArrayBuffer`s por segundo e o custo do Chromium ao escrever o quadro de volta (`SetData` copia para um `rtc::Buffer`: mais UMA cópia por sender).

### A3. O que o Chromium faz por sender — o custo real do "N envios"

Isto não é código nosso e não cabe em bancada Node, mas é a conta que decide o teto prático de N por máquina, e vale deixá-la escrita.

Por sender e por quadro, depois do transform: cópia para `rtc::Buffer`, pacotização RTP (B/1 200 ≈ 21 pacotes por P, ~125 por IDR), SRTP (AES-GCM), *pacer*, `sendmsg` por pacote, mais RTCP de recepção (NACK, RR, REMB/TWCC) por peer. Álgebra:

- pacotes/s = N · B · F / MTU_útil = 50 × 25 000 × 60 / 1 200 ≈ **62 500 pacotes/s** (mais ~5 % de RTCP e retransmissão);
- `sendmsg` custa ~2–5 µs no Linux (estimativa de experiência, sem GSO/`sendmmsg` no libwebrtc): 125–310 ms/s, **12–30 % de um núcleo só em syscalls**;
- SRTP AES-GCM com AES-NI: ~1–2 GB/s por núcleo → 78 MB/s = 4–8 %;
- memcpy (SetData + pacotização): ~3 × 78 MB/s ≈ 230 MB/s a ~10 GB/s = 2 %.

Total estimado: **150–400 ms de CPU por segundo a N=50, concentrado na thread de rede do libwebrtc** (uma só por processo). Com o jogo aberto, essa é a thread que disputa núcleo; é o que o D0 deve medir em `chrome://tracing` (procedimento em §F) antes de qualquer promessa para 50. O "um encode" tirou o custo O(N) de ENCODE; o custo O(N) de ENVIO continua, e só a cascata (§D) o tira da máquina de quem transmite.

### A4. Leitor do protocolo nativo — `apps/desktop/d0/protocolo-captura.mjs`

**Hoje.** A cada pedaço do cano que não completa a mensagem, `pendente = Buffer.concat([pendente, pedaço])`: copia tudo o que já estava pendente de novo. Uma mensagem de B bytes chegando em pedaços de c bytes custa c·(1+2+…+B/c) ≈ **B²/(2c)** bytes de cópia, mais a cópia final `slice` para o `ArrayBuffer` transferível. É O(B²/c) por mensagem — a classe errada, mesmo que a constante seja pequena hoje.

**Melhor.** Lista de pedaços + offset de consumo: cada byte do cano é copiado exatamente UMA vez, direto no `ArrayBuffer` de destino, quando a mensagem está completa. O(B). O cabeçalho de 4 bytes pode cair na fronteira entre dois pedaços; a bancada trata sem concatenar.

**Medido** (`protocolo-captura.bench.mjs`, 10 s a 60 fps, 15,7 MB úteis, 600 quadros + eventos):

| pedaço | atual (ms) | lista (ms) | ganho | copiado atual | copiado lista | fator |
|---|---|---|---|---|---|---|
| 64 KiB (pipe do Node) | 4,79 | 3,19 | 1,5× | 35,0 MB | 15,7 MB | 2,2× |
| 16 KiB | 6,16 | 2,95 | 2,1× | 46,8 MB | 15,7 MB | 3,0× |
| 4 KiB | 13,08 | 3,00 | 4,4× | 93,1 MB | 15,7 MB | 5,9× |
| 512 B | 81,24 | 5,29 | 15,4× | 523 MB | 15,7 MB | 33× |

Um IDR de 300 KB em pedaços de 512 B: atual 12,5 ms e **88,4 MB copiados para 0,3 MB úteis (295×)**; lista 0,14 ms.

**Importa?** No Linux o Node lê o pipe em pedaços de até 64 KiB, então o caso real é a primeira linha: 0,5 ms/s, 2,2× de cópia — não pesa. O que a lista compra é previsibilidade: o custo deixa de depender de como o SO fatiou e de o processo principal do Electron estar atrasado. **P2**, feito junto com A5 quando se tocar no `injecao.mjs`.

### A5. Ponte processo principal → renderer — `apps/desktop/d0/injecao.mjs`

`port1.postMessage({ tipo: 'quadro', ..., dados: q.dados })` sem lista de transferência: clone estruturado de B por quadro. Medido: 7 µs/quadro sem transferência, 5 µs com (0,4 vs 0,3 ms/s). Desprezível; **P3**. Antes de mudar, conferir se o `MessagePortMain` do Electron transfere `ArrayBuffer` (a API documenta transferência de portas; se o buffer for sempre clonado, não há o que fazer).

### A6–A7. Codificador WebCodecs, isca e `tela-captura.c`

- `saiu()`: `new ArrayBuffer` + `copyTo` (1 cópia de B, inevitável), `entrada` Map O(1) com `clear()` acima de 120 — correto.
- Isca: um `fillRect(0,0,1,1)` + `requestFrame()` por quadro capturado; 60/s, O(1). O encoder do sender codifica 160×90 — ~1 % do custo de 1080p por sender. A N=50 são 50 encoders de 160×90 ≈ metade de um 1080p: aceitável, mas não zero. Fica a pergunta para o navegador: o Chromium reaproveita o encoder entre senders de isca idêntica? (O D0 mediu que NÃO para 1080p.)
- `tela-captura.c`: a `GQueue` de latência faz `g_new` por quadro e corta em 64 — O(1), 60 alocações/s. `enviar()` faz três `write()` por quadro (cabeçalho de 5, cabeçalho de 9, corpo): 180 syscalls/s; `writev` deixaria em 60. **P3**, só quando o arquivo for aberto por outro motivo.

---

## B. Por segundo / por tique

### B1. `StatsSampler.readMany` — `core/media/stats-sampler.ts`

O(N·E): percorre todos os objetos de todos os relatórios e lê os três que interessam. Medido com E=90 (`stats-sampler.bench.mjs`): **0,34 ms por tique a N=50** (6,7 µs por relatório). O `AudioStatsSampler` percorre de novo (2·N·E), já incluído. Nada a fazer no JS.

### B2. `getStats()` × N — `MeshTopology.collectStats`

O que custa não é o nosso laço, é a chamada. Em cada `RTCPeerConnection.getStats()` o Chromium (`RTCStatsCollector`) despacha tarefas para as threads de sinalização, de rede e de worker, coleta ICE/RTP/codec/certificados, monta ~E objetos e os converte em um `RTCStatsReport` no renderer (serialização + alocação no heap JS). O cache interno é POR conexão (~50 ms): 50 conexões = 50 coletas completas por segundo.

Estimativa, não medida aqui: 1–3 ms de parede por chamada em conexões pequenas (ordem de grandeza da experiência da comunidade WebRTC; o comentário em `collectStats` já registrou que "não é barato" com 5). A N=50: **50–150 ms/s de threads do Chromium + 4 500 objetos/s alocados no JS** — comparável a todo o resto deste documento somado. **P1 medir** (§F), e duas mudanças de custo zero em semântica:

1. **Rodízio.** Medir N/5 peers por tique, retendo a última leitura de cada peer; o `UplinkGovernor` já suaviza POR peer e já tira o mínimo dos suavizados, então uma leitura de até 5 s de idade entra na mesma conta (`porPeer` retém; só o `delta` de bytes precisa de dois pontos do mesmo peer, e o rodízio garante isso). O custo cai para O(N/5). A `MalhaDeBanda` exige três amostras seguidas de `bandwidth` para declarar colapso; com rodízio, "seguidas" passa a ser "do mesmo peer", e o atraso de detecção sobe de 3 s para até 15 s a N=50. É o preço; os cenários de queda do simulador medem se ele cabe.
2. **Seletor.** No "um encode", o `outbound-rtp` de vídeo é o MESMO quadro em todos os senders; o que varia por peer é `candidate-pair` (banda disponível, RTT) e `bytesSent`. `sender.getStats()` e `pc.getStats(selector)` devolvem relatórios menores (E cai para ~10–20), reduzindo a serialização em 5–10× sem mudar o número de chamadas.

### B3. Governador, malha de banda, topologia

`UplinkGovernor.observe`: `Object.entries` + `Set` + `Math.min(...valores)` por tique — O(N), com N≤50 cabe num *spread*. `MalhaDeBanda.observar`: O(1) mais o governador. `MeshTopology.effectiveBitrate/tetoUtil`: O(1). `collectStats` ainda enfileira `reaplicarPendentes` (O(pendentes)) e `adaptAll` quando a escala mudou (O(N) `setParameters`, enfileirados). `Diario.registrar`: `push` + `shift` em 120 amostras, 1 Hz. Tudo abaixo de 0,1 ms por tique.

### B4. React — o fan-out do `setState` a 1 Hz

`sampleStats` faz `setState({...state, stats, audio})` a cada segundo; `useSyncExternalStore` re-renderiza a rota `Broadcast`. Nela: dois `filter` sobre `peers`, `Array.from({length: maxPeers})` construindo 50 `Vaga`s, strings de ajuda, e `SalaVagas` reconcilia 50 `<li>` (o `<details>` fechado esconde no DOM, mas o React renderiza a subárvore). Estimativa: <1 ms por segundo no renderer. `montarDiagnostico` é O(N) e só roda com o painel aberto. A topologia já evita `announce()` sem mudança, então `peers` mantém identidade entre tiques. **P3:** `useMemo` em `vagas` sobre `[vivo.peers, vivo.nomes, vivo.maxPeers]`. O harness `e2e/custo-interface.e2e.mjs` (TaskDuration do CDP) é onde se mede isso de verdade.

---

## C. Por evento

### C1. Entrada e saída de peer — `core/mesh/mesh-topology.ts`, `peer-link.ts`

`admit` → `attach`: um `PeerLink`, `addTrack` por trilha (2), `applyPreset` enfileirado, oferta, ICE. O(1) por entrada; os `Map`s de `links`/`senders` são O(1). `publish` e `adaptAll` são O(N) por chamada e só rodam em troca de degrau/fonte — no "um encode" o degrau reconfigura UM codificador, e a isca nunca é reconfigurada (os `setParameters` continuam, mas nunca geram quadro-chave). `drop` é O(1) mais `announce`. `handleSignal` por candidato é O(1) no JS; o custo é do ICE no Chromium (checks por par de candidatos, O(c²) por conexão com c candidatos — independente de N).

**O custo que escala com N na entrada é o quadro-chave (C4), não a sinalização.**

### C2. Worker (Durable Object) — `apps/signaling/src/worker.ts`

Toda consulta à sala é `peers()`: percorre `ctx.getWebSockets()` e **desserializa o attachment de cada socket**. `relay()` chama `host()`/`viewers()` duas vezes por sinal; `dentroDoLimite` desserializa e reserializa mais uma. Por sinal: **2(N+1) desserializações**. Uma entrada custa ~30 sinais (oferta, resposta, ~15 candidatos de cada lado em rede real); N entrando juntos: 30·N sinais × O(N) = **O(N²)**.

Medido com `v8.serialize/deserialize` no lugar da plataforma (`sinalizacao-worker.bench.mjs` — proxy, não o DO):

| N | desserializações/sinal | relay hoje (µs) | índice por mensagem (µs) | índice em cache (µs) | entrada de N, hoje (ms) | entrada de N, cache (ms) |
|---|---|---|---|---|---|---|
| 5 | 12 | 23,5 | 12,9 | 2,81 | 3,5 | 0,42 |
| 20 | 42 | 95,1 | 40,3 | 1,98 | 57,1 | 1,19 |
| 50 | 102 | **163,5** | 74,5 | **1,76** | **245** | 2,65 |

Um DO é single-threaded: 245 ms de CPU numa rajada de entrada é fila na troca de ICE de todo mundo — e isso em cima do custo da plataforma, que pode ser maior que o `v8.deserialize` local. **P1:** construir o índice (`Map<peerId, {socket, at}>` + `host`) UMA vez por mensagem recebida (ainda N desserializações, mas uma passagem: 74 µs) ou mantê-lo em cache de instância invalidado em toda `serializeAttachment` (1,8 µs; o cache nasce vazio ao acordar da hibernação e é reconstruído na primeira consulta — sem estado durável novo). O registry Node (`channel-registry.ts`) já é O(1) por `Map`; a presença (`viewers`) é O(N) por entrada, 1 275 mensagens para 50 entradas — fino.

### C3. Limitadores — `limits.ts`

`RateBuckets.take` é O(1) com varredura preguiçosa (só acima de 10 000 chaves, uma vez por minuto). Os tetos já foram redimensionados para 50 (`hostMessageLimit = 48 × 50`). No Worker o contador vive no attachment: uma desserialização e uma serialização por mensagem (~3 µs cada no proxy). Nada a fazer.

### C4. Quadro-chave por entrada e por PLI — o evento que multiplica por N

Cada entrada espera um IDR NA PONTA (regra H.264 da fila), e cada PLI de espectador vira pedido ao codificador único, coalescido a 1 por 500 ms (`INTERVALO_MINIMO_DE_CHAVE_MS`). Um IDR custa B_IDR·N no link: **150 KB × 50 = 7,5 MB por IDR**; num link de 100 Mbps (75 útil) são 0,8 s de cano para UM quadro — o pacer espalha, mas a latência de todos sobe e o `availableOutgoingBitrate` cai. Com 50 espectadores, a taxa agregada de PLI é 50× a de um (cada perda em cada caminho pode gerar um), e a coalescência deixa passar até 2 IDR/s = **15 MB/s, acima do link inteiro**. Isso é o modo de falha "a segunda transmissão pior que a primeira" em versão N: a rede boa de 49 paga a rede ruim de 1.

**P1 (álgebra, sem bancada):** (a) a janela de coalescência deve crescer com N — por exemplo `max(500 ms, 40 ms × N)` (2 s a N=50), e o espectador que pediu continua decodificando o que chega; (b) perda deve ser resolvida por NACK/RTX (já ligado no WebRTC) antes de PLI — conferir no espectador se `pliCount` cresce junto com `nackCount` ou sozinho; (c) na cascata, o repassador agrega os PLI da subárvore e repassa UM. O codificador já registra `pedidosDeChave` por motivo — é o contador para medir isso em `um-encode.e2e.mjs` com `ESPECTADORES=20`.

---

## D. Álgebra de rede: malha versus árvore de repasse

Tudo nesta seção sai de `rede-malha-vs-arvore.calc.mjs`, que importa a escada real (`pisoDeBitrate`, `tetoDeBitrate`, `presetForBitrate`, `P2P_LIMITS.uplinkHeadroom = 0,75`) e a reserva de áudio (141 kbps).

### D1. A escada

| degrau | nominal | piso | teto | bpp nominal |
|---|---|---|---|---|
| 1080p60 | 12,0 | 12,4 | 16,2 | 0,096 |
| 900p60 | 8,8 | 9,1 | 11,9 | 0,102 |
| 720p60 | 6,0 | 6,2 | 8,1 | 0,109 |
| 600p60 | 4,1 | 4,3 | 5,6 | 0,116 |
| 480p60 | 3,0 | 3,1 | 4,1 | 0,122 |
| 360p60 | 1,9 | 1,9 | 2,5 | 0,137 |

(Mbps. O piso fica acima do nominal porque `BPP_PISO`=0,10 > bpp da âncora 0,096 — herança da ADR 0010; o produto opera entre piso e teto.)

### D2. Malha: U_host = N·b, b = (0,75·U − 0,141)/N

| U (Mbps) | N=5 | N=10 | N=20 | N=50 |
|---|---|---|---|---|
| 10 | 360p **abaixo do piso** (1,47) | 360p **<piso** (0,74) | 360p **<piso** (0,37) | 360p **<piso** (0,15) |
| 50 | 720p (7,5) | 480p (3,7) | 360p **<piso** (1,9) | 360p **<piso** (0,75) |
| 100 | 1080p (15,0) | 720p (7,5) | 480p (3,7) | 360p **<piso** (1,5) |
| 300 | 1080p@teto (16,2) | 1080p@teto (16,2) | 900p (11,2) | 600p (4,5) |

(entre parênteses, Mbps por espectador.) A conclusão da ADR 0029 em números: **com 50 espectadores só uma subida de ~300 Mbps mantém a imagem dentro da escada (600p60); 100 Mbps põe os 50 abaixo do piso de 360p**. A adaptação coletiva (R5) está certa — todos descem juntos — mas desce para onde não há imagem.

### D3. Árvore k-ária: U_host = k·b, independente de N

Profundidade de uma árvore k-ária completa com N nós abaixo da raiz: **d = min{d : Σ_{i=1..d} k^i ≥ N}**, isto é, d = ⌈log_k((N·(k−1)/k) + 1)⌉ ≈ ⌈log_k N⌉. Repassadores necessários: ⌈(N−k)/k⌉. Latência extra: d·h.

| N | k | d | repassadores | upload do host (1080p@teto) | subida bruta por repassador | latência extra (h=60 ms) | folhas |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 2 | 2 | 32,3 Mbps | 43,1 Mbps | 120 ms | 3 |
| 5 | 5 | 1 | 0 | 80,9 | — | 60 | 5 |
| 10 | 3 | 2 | 3 | 48,5 | 64,7 | 120 | 7 |
| 20 | 3 | 3 | 6 | 48,5 | 64,7 | 180 | 14 |
| 20 | 5 | 2 | 3 | 80,9 | 107,8 | 120 | 17 |
| 50 | 2 | 5 | 24 | 32,3 | 43,1 | 300 | 26 |
| 50 | 3 | 4 | 16 | 48,5 | 64,7 | 240 | 34 |
| 50 | 5 | 3 | 9 | 80,9 | 107,8 | 180 | 41 |

**Sobre h.** Um repassador que injeta o quadro recebido nos próprios senders a partir do Encoded Transform de RECEPÇÃO não passa pelo jitter buffer nem pelo decoder: h ≈ atraso de ida (10–30 ms dentro do Brasil) + montagem do quadro a partir dos pacotes (um quadro, ~5–15 ms com pacer) + pacer de saída (≤5 ms). **25–50 ms por salto**, não os 60 ms do `JITTER_INICIAL_MS` (que só a folha paga, uma vez). 60 ms na tabela é conservador. *A confirmar no navegador:* que o transform de recepção do Chromium entrega o quadro antes do frame buffer (é o que o `RtpVideoStreamReceiver2` faz, mas a latência real precisa de câmera a 240 fps, como sempre).

### D4. Que grau cada subida brasileira paga (cópias de 1080p60)

| subida bruta | k no piso (12,4) | k no teto (16,2) | k em 720p60 no piso (6,2) |
|---|---|---|---|
| 5 Mbps (4G/ADSL) | 0 | 0 | 0 |
| 10 Mbps | **0** | 0 | 1 |
| 20 Mbps | 1 | 0 | 2 |
| 50 Mbps | 3 | 2 | 5 |
| 100 Mbps | 6 | 4 | 11 |
| 300 Mbps | 18 | 13 | 36 |

**Quem tem 10 Mbps de subida não repassa nem uma cópia de 1080p60; é folha.** A árvore se apoia nos de 50 Mbps para cima (fibra), que no Brasil urbano são comuns, mas não universais. Em 720p60, 10 Mbps já repassa 1.

### D5. O limite de fluxo (o que nenhuma árvore passa)

Com qualquer peer podendo repassar, a taxa máxima que TODOS os N recebem é **r* = min{ u_s, (u_s + Σ u_i)/N }** — u_s a subida útil do transmissor, u_i a de cada espectador (Kumar, Liu & Ross, *Stochastic fluid theory for P2P streaming systems*, INFOCOM 2007; o mesmo limite aparece em Mundinger, Weber & Weiss, 2008, para disseminação de arquivo — citações de memória, com confiança moderada; o argumento de corte é elementar: toda unidade que chega a N espectadores saiu de alguma subida).

| cenário (u = 0,75·subida − áudio) | N=5 | N=10 | N=20 | N=50 |
|---|---|---|---|---|
| host 100, todos 10 (4G/ADSL) | 22,3 | 14,8 | 11,1 | **8,9** |
| host 100, todos 50 (fibra básica) | 52,3 | 44,8 | 41,1 | **38,9** |
| host 50, metade 10 e metade 100 | 37,4 | 37,4 | 37,4 | 37,4 |
| host 300, todos 100 | 119,8 | 97,3 | 86,1 | 79,4 |
| host 10, todos 100 (host fraco) | 7,4 | 7,4 | 7,4 | 7,4 |

(Mbps por espectador; 1080p60 precisa de 12,4–16,2.) Leituras:

- **host 100 / todos 50, N=50: 38,9 Mbps por espectador** — 1080p60 no teto para 50, contra 360p abaixo do piso em malha. É o caso que justifica a cascata.
- **host 100 / todos 10, N=50: 8,9** — 720p60 no teto para 50 (hoje: 360p <piso). Mesmo sem ninguém capaz de repassar 1080p, o repasse PARCIAL (cada um repassa menos que uma cópia) chega a 720p. Uma árvore única NÃO alcança isto (cada repassador precisa bancar k≥1 cópia inteira); alcançam árvores múltiplas por *stripes* (SplitStream, Castro et al., SOSP 2003 — cada nó é interno em uma árvore e folha nas outras, e a carga por nó é 1/k de uma cópia) ou a malha *pull* por pedaço (CoolStreaming/DONet, Zhang et al., INFOCOM 2005). Para o Tela, *stripes* de H.264 significam dividir o fluxo em s subfluxos de pacotes RTP (não de quadros — a dependência P→P proíbe) e reagrupar no espectador: é possível em cima do Encoded Transform com pacotização própria, mas é uma fase à parte da árvore única.
- **host fraco (10 Mbps): 7,4 para sempre.** A árvore não cria subida no transmissor: k·b ≤ u_s. Aqui 720p60 a k=1 (uma cópia!) é o máximo — e é um caso REAL de 4G, onde a cascata vale mais do que em qualquer outro.

### D6. Árvore de profundidade mínima com graus heterogêneos

Dado o grau k_i que cada espectador paga (D4), a árvore de profundidade mínima põe os maiores graus mais perto da raiz: ordena por k_i decrescente e preenche nível a nível (BFS). É ótimo por troca — mover um nó de grau maior para um nível mais raso nunca reduz as vagas do nível seguinte (é a construção clássica de "altura mínima com restrição de grau"; a referência exata me escapa, confiança moderada). Com host de 100 Mbps (k=6) e espectadores alternando 10/20/50/100/300 Mbps:

| N | graus presentes | sem subida para repassar | d | nós por nível | latência extra |
|---|---|---|---|---|---|
| 5 | 18, 6, 3, 1, 0 | 1 | 1 | [5] | 60 ms |
| 10 | 18, 6, 3, 1, 0 | 2 | 2 | [6, 4] | 120 ms |
| 20 | 18, 6, 3, 1, 0 | 4 | 2 | [6, 14] | 120 ms |
| 50 | 18, 6, 3, 1, 0 | 10 | **2** | [6, 44] | **120 ms** |

Com 20 % da sala em fibra de 300 Mbps, 50 pessoas cabem em DOIS saltos. A condição de existência é Σ_{internos} k_i ≥ N − k_host; a de qualidade é b ≤ r* (D5).

### D7. O que a cascata muda nas malhas (para a ADR dela)

1. **Topologia:** o servidor continua opaco (R8), mas passa a dizer a cada entrante QUEM é o pai — ou o transmissor decide e manda por `signal`. A escolha do pai usa a subida DECLARADA ou MEDIDA do candidato (o `TesteDeRede` já existe no cliente).
2. **Malha de banda:** o gargalo deixa de ser `min(availableOutgoingBitrate)` dos filhos diretos e passa a ser o pior repassador — que precisa reportar para cima (`stats` do repassador viajam no canal de sinalização como payload opaco, ou o transmissor infere pelo PLI/NACK que sobem). Continua coletivo: b é um só para a árvore inteira (R5), e quem não paga k≥1 vira folha, não baixa a qualidade dos outros.
3. **Reconexão:** um repassador que sai leva ⌈N/k⌉ nós no pior caso (um filho da raiz). Hoje `MEDIA_GRACE_MS = 8 s` antes de dar a mídia por morta: na cascata a detecção deve vir do `seq` (buraco ou silêncio > 500 ms no transform de recepção), com um pai reserva pré-atribuído, para a subárvore religar em <1 s. O IDR que religa custa B_IDR × (tamanho da subárvore), não × N.
4. **Custo por repassador:** O(k·B·F) no mesmo worker de injeção (a `FilaDeInjecao` serve igual — o "codificador" passa a ser o transform de recepção). É o mesmo custo de um transmissor com N=k: pelo A2/A3, k≤6 custa <5 % de um núcleo.

---

## E. Plano de otimização, por prioridade

| Prioridade | O quê | Ganho esperado | Risco | Testes |
|---|---|---|---|---|
| **P0 — medir** | A3 e B2 em Chrome real com N=20 e N=50 (§F) | decide o teto prático por máquina e se B2 vale | nenhum | `um-encode.e2e.mjs ESPECTADORES=20` + `chrome://tracing` |
| **P1** | C4: coalescência de PLI ∝ N; conferir NACK antes de PLI; contador por motivo no console | evita 15 MB/s de IDR a N=50; a rede ruim de 1 deixa de custar a de 49 | baixo (só a janela); espectador novo pode esperar até 2 s pelo IDR | `fila-de-injecao.test.ts` + `webcodecs-codificador` com relógio fake; e2e com `ESPECTADORES=20` contando `idrs` |
| **P1** | C2: índice por mensagem/cache no Worker | 163 → 2–75 µs por sinal; 245 → 3 ms por entrada de 50 | hibernação: o cache nasce vazio e é reconstruído; `conformance.test.ts` já cobre o protocolo | `worker.test.ts` + `conformance.test.ts` (sem mudança de comportamento) |
| **P1 (condicional ao P0)** | B2: rodízio N/5 + `getStats(selector)` | 5× menos chamadas, 5–10× menos objetos por chamada | detecção de colapso até 5× mais lenta; o simulador mede | `malhas.sim.mjs` (1 200 cenários) com rodízio modelado; `qualidade.e2e.mjs` |
| P2 | A1: anel por `seq` na `FilaDeInjecao` | 4× (1,0 → 0,24 ms/s); O(1) independente de Q | baixíssimo: decisões idênticas verificadas | mover a equivalência da bancada para `fila-de-injecao.test.ts`; `um-encode.e2e.mjs` |
| P2 | A4: leitor com lista de pedaços | O(B²/c) → O(B); 1,5× a 64 KiB, 15× a 512 B | baixo; equivalência de quadros verificada | teste do leitor com fragmentação aleatória (hoje não existe) + `desktop-ao-vivo.e2e.mjs` |
| P3 | A5 (transferir no `MessagePortMain`), B4 (`useMemo` em `vagas`), A7 (`writev`), A2 (nada) | <1 ms/s cada | nenhum | os existentes |

O que NÃO fazer: otimizar a cópia por sender (A2) — é inerente e barata; "adaptar por peer" para poupar banda (R5, ADR 0015) — continua errado, agora com mais força, porque o quadro é um só.

---

## F. O que precisa de navegador ou humano, e como medir

1. **A3 — custo do envio por `RTCPeerConnection` (P0).** `pnpm dev`; `ESPECTADORES=20 node e2e/um-encode.e2e.mjs` (depois 50, em máquina com RAM para 50 Chromes — ou 50 abas num só Chrome, que compartilham processo de rede e distorcem; preferir 2 máquinas). No transmissor, `chrome://tracing` com as categorias `webrtc` e `toplevel` por 30 s: somar o tempo da thread `NetworkThread`/`PacerThread` e de `WebRTC_Signaling`. Reportar ms/s por thread para N = 1, 5, 20, 50; esperado linear em N. Em paralelo, `top -H` no processo de renderer para confirmar. Critério: a soma deve caber no que o jogo deixa (medir com MangoHud, como o D0).
2. **B2 — custo de `getStats()`.** Mesmo cenário; em `collectStats`, `performance.now()` em volta do `Promise.all` e `console.count` do tamanho dos relatórios (`report.size`). Reportar ms por tique e objetos por tique para N = 5, 20, 50. Depois repetir com `sender.getStats()` no lugar de `pc.getStats()`.
3. **A6 — encoder da isca compartilhado?** `chrome://webrtc-internals`: contar `encoderImplementation`/`framesEncoded` por sender a N=20; se cada sender codifica a isca, são 20 encoders 160×90.
4. **C4 — PLI real.** No console do transmissor, `pedidosDeChave` por motivo e `idrs` por minuto a N=20 com um espectador em rede ruim (`tc netem loss 2%`). Se `idrs` subir a 1–2/s, a janela de coalescência está curta.
5. **D3 — h por salto.** Só com dois saltos reais e câmera a 240 fps (como a latência glass-to-glass). Antes disso, o `seq` do transform de recepção contra o `seq` de saída dá a parte "montagem + pacer" em software.
6. **C2 — no Worker real.** `wrangler dev` com a suíte de conformidade e 50 sockets; medir o `cpuTime` do DO por entrada em massa (o proxy local mede `v8.deserialize`; a plataforma pode ser mais cara).

---

## G. Decisões e dúvidas

- Os benchmarks não fazem build de `@tela/shared`: usam o `dist/` existente, para não tocar na árvore enquanto outros a modificam. Se o `dist/` ficar velho, a calculadora da §D pode divergir da escada — rodar `pnpm --filter @tela/shared build` antes.
- O proxy de `serializeAttachment` é `v8.serialize`; a plataforma pode ter custo diferente (provavelmente maior: o attachment é persistido para hibernação).
- `E = 90` objetos por relatório é uma estimativa de relatório do Chromium; o número real varia com candidatos ICE (CGNAT + TURN sobem E). Não muda a conclusão de B1 (JS barato), muda a de B2 (serialização cara) na mesma direção.
- A latência por salto de 25–50 ms assume que o transform de recepção entrega antes do frame buffer. Se o Chromium entregar depois, h sobe para ~h + jitter buffer (60 ms+) e a árvore de d=3 custa 300 ms, não 150.
- Citações: Kumar–Liu–Ross 2007 (limite de fluxo) e Castro et al. 2003 (SplitStream) são de memória, com confiança razoável; a referência para "altura mínima com graus heterogêneos por BFS decrescente" é folclore de algoritmos, com o argumento de troca escrito acima para não depender da citação.
