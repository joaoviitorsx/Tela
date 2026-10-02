# ADR 0031 — Cascata de repasse: espectadores com boa subida repassam o quadro

**Data:** 2026-10-02
**Estado:** **aceita** (2026-10-02 — respostas do dono em "Respostas do dono"; implementação começa pelo experimento E2)
**Complementa:** 0029 (um encode, teto de 50 — "o passo seguinte, já decidido pelo dono"), 0030 (porta pela banda) · **Mantém:** 0005 (sem servidor de mídia), R2, R5, R8 · **Altera, se aceita:** o modelo de privacidade da sala (IP entre espectadores) e o "teto 50 pela banda" da 0030 (a capacidade passa a somar vagas de repassadores)
**Origem:** `docs/engenharia/estudo/2-transporte-e-topologia.md` §4 (T2) e `e2e/cascata.sim.mjs` (novo, desta ADR)

## Contexto

Na malha, o upload de quem transmite é `N · b`. A ADR 0029 deu o "um encode, N envios" (a CPU deixou de multiplicar) e abriu 50 vagas; a ADR 0030 fechou a porta no ponto em que o link ainda paga o piso do 360p60. O que sobra é a **banda**: com 50 pessoas o upload do anfitrião é dividido por 50, e a escada desce junto.

Em números do simulador abaixo (distribuição típica, `N = 50`): um anfitrião de 50 Mbps de subida deixa entrar 16 pessoas, a 2,1 Mbps cada (360p60, "quadriculado" no teto do degrau); um de 100 Mbps deixa entrar 33 a 2,4 Mbps; um de 300 Mbps deixa entrar 50 a 5,1 Mbps (576p60). Para a maioria dos anfitriões brasileiros (a subida é a parte pobre do plano), **a malha pura não paga nem 720p60 para uma sala de 20.**

O dono já decidiu o rumo (ADR 0029): espectadores com subida sobrando repassam o quadro **já codificado** a outros espectadores. O que esta ADR faz é pôr o desenho, os custos e os números na mesa, para o dono decidir se, quando e com quais limites.

## Opções

| | A. Manter a malha | B. Cascata, profundidade ≤ 2 (fase 1) | C. SFU |
|---|---|---|---|
| Upload do anfitrião | `N · b` | `k_h · b`, `k_h` ≈ 3–12 | `b` (vai para um servidor) |
| Qualidade com N = 50, host 100 Mbps | 2,4 Mbps (360p60), 33 de 50 entram | 8–9 Mbps (720p60/900p60), 49 de 50 entram | 16 Mbps |
| Latência | ~150 ms | **+40 ms** (+80 com profundidade 3) | +30–50 ms |
| Privacidade | só o anfitrião vê os IPs | **filho e pai veem o IP um do outro** | só o servidor |
| Custo | zero | zero | banda mensal (a ADR 0005 existe para evitar) |
| Complexidade | a de hoje | árvore, repasse, reparentamento: 3–5 semanas [H] | menor no cliente, maior em infra |

**C está rejeitada pela ADR 0005 e pela R2** (orçamento zero; sem servidor de mídia). Fica registrada só para completar a tabela. **A** é o padrão correto para a sala de 3 a 8 amigos, que é o caso de uso original, e **deve continuar sendo o padrão**: a cascata é um recurso para quando a malha não paga (ver "Quando liga").

## Proposta: B, em fases, ligada só quando a malha não basta

### O desenho

**Papéis.** *Anfitrião*: raiz, um `VideoEncoder` (como hoje), `k_h` filhos, dono da topologia. *Repassador*: espectador com subida medida ≥ 25 Mbps e opt-in, que recebe como qualquer espectador **e** reinjeta o quadro codificado nos seus senders-filhos. *Folha*: o espectador de hoje.

**Repasse sem recodificar — viabilidade contra o que foi medido.** O quadro codificado chega ao repassador pelo `RTCRtpScriptTransform` de **recepção** (`RTCEncodedVideoFrame`: `type`, `timestamp`, `data`, `getMetadata()`), segue para o decoder dele e uma cópia (`data` + `type` + metadados, por `postMessage`) vai ao mesmo worker de injeção do anfitrião (`adapters/injecao-worker.ts`: isca 160×90 por sender, troca do `data`, `FilaDeInjecao`, IDR na ponta, contrapressão). A peça nova é só **a fonte da fila**: no anfitrião é o `VideoEncoder`, no repassador é o transform de recepção. O que foi sondado em runtime (Chromium 151 headless, hoje; Chromium 152/Electron 44 em `docs/desktop/D0b`):

| API | Estado | Necessária? |
|---|---|---|
| `RTCRtpScriptTransform` (envio e recepção) | presente | sim |
| `new RTCEncodedVideoFrame(frame, options)` | presente | sim — já é o que o D0b usa; o spec proíbe mover o objeto entre senders, mas permite criar um novo com os mesmos bytes |
| `RTCEncodedVideoFrame.getMetadata()` | presente | sim (tipo do quadro, tempos) |
| `RTCEncodedVideoFrame.setMetadata` | **ausente** no Chromium 151; atrás de `RTCEncodedFrameSetMetadata` (o Electron liga) | **não na fase 1**: o repassador só troca `data`, como o anfitrião |
| `RTCRtpScriptTransformer.sendKeyFrameRequest()` | **presente** (medido hoje, em worker) | sim — o repassador pede IDR ao pai |
| `RTCRtpScriptTransformer.generateKeyFrame` | ausente | não |
| `createEncodedSource` | ausente | não (seria a API certa quando sair) |

Conclusão: **não há bloqueio de API conhecido na fase 1**; é o mesmo mecanismo do "um encode" com outra fonte. O que **não** foi medido, e o E2 mede: (i) se `data` de um quadro de recepção, copiado e injetado, mantém o decoder da folha feliz com `type` vindo da isca do repassador (no anfitrião funciona; no repassador a isca precisa produzir um `key` exatamente quando o conteúdo injetado é um IDR — a "IDR na ponta" do D0b já faz isso para quem entra); (ii) o que se perde de metadados de tempo (`captureTime`, `abs-capture-time`): o `timestamp` RTP do filho nasce no relógio da isca do repassador, não no da origem [H]; (iii) a quantização de 0 a 16,7 ms por salto por esperar o próximo quadro da isca [I]. Por isso o simulador usa 40 ms por salto (o estudo estima 25–45 ms) e a tabela de sensibilidade vai a +80.

**Construção da árvore (no anfitrião).** `k_h = ⌊(0,75·U − 141 kbps)/b⌋`; um repassador banca `k_i = min(K_MAX, ⌊(f·u_i − 141 kbps)/b⌋)`, com `f = 0,5` (cede metade da subida; o resto é do jogo e da call dele) e `K_MAX = 6` (0,2 núcleo por filho, D0b). BFS por níveis ordenando por `k` decrescente, filhos distribuídos em rodízio, profundidade ≤ `Dmax` (2 na fase 1); escolhe-se o **maior b da escada** para o qual todos cabem, e se nem o piso cabe, vale a porta da 0030. O algoritmo e o esboço de otimalidade estão em estudo 2 §4.4 (esboço [H]).

**O anfitrião é o hub de sinalização (R8 intacta).** O servidor só deixa o espectador falar com o anfitrião (`resolveTarget`, `channel-registry.ts`) e repassa `payload` opaco. Logo: o espectador que precisa negociar com o pai manda ao anfitrião `{tipo:'via', para, dados}` e o anfitrião responde com `{tipo:'via', de, dados}`; o anfitrião informa `{tipo:'pai', pai, reserva, epoca}`; os repassadores reportam a cada 1 s `{epoca, filhos, orcamentoMin, enviado, cpu}` (~100 B). O servidor não parseia nada, não muda de versão (`PROTOCOL_VERSION` fica em 5: cliente antigo nunca anuncia oferta de repasse e fica como folha do anfitrião — a mesma lógica da 0030). A mídia nunca passa pelo servidor; se o signaling cair, a árvore já formada continua. Custo: a negociação de cada aresta espectador-espectador dá um salto de WebSocket pelo anfitrião (20–100 ms), na **entrada**, não na mídia.

**PLI e IDR.** O anfitrião continua coalescendo IDR (500 ms; os senders dele são `k_h ≤ 12`, não `N`, então o IDR custa 4× a 12× menos no uplink dele). Um repassador atende o PLI do filho do **cache** do `FilaDeInjecao` (3 s, 180 quadros) reenviando o último IDR e os P seguintes em rajada; se o IDR guardado tem mais de 1 s, pede um novo ao pai por `sendKeyFrameRequest()` (agregando os pedidos dos irmãos num só, no máximo 1 por 500 ms). Pendente de decisão do dono do código: IDR periódico no anfitrião (a cada 4 s, ≈ +3,6 % de bits) para o cache nunca estar velho; sem ele, a cada entrada o PLI sobe até a raiz (0,5–0,7 s).

**Falha de repassador → reanexar a subárvore.** Detecção: quadros ausentes por ≥ 500 ms com o ICE ainda `connected` (hoje o vigia espera 8 s: precisa de um vigia curto só para filhos de repassador). O anfitrião é o pai reserva preferido (já tem sinalização e uma vaga a mais); do contrário, outro repassador com vaga e profundidade livre. Estimativa: 0,7–1,2 s com o anfitrião como reserva, 1,2–2,0 s sem [I]; E4 mede. Se ninguém tem vaga, o anfitrião rebaixa o b (porta) e reconstrói; se nem o piso cabe, o excedente volta à fila.

**Adaptação coletiva (R5) em árvore.** Um encoder, um b: as arestas carregam a mesma cópia, portanto são comparáveis e o orçamento da sala é o **mínimo sobre as arestas**. Cada pai lê o BWE das suas arestas e aplica a regra da 0030 (`min(b, 0,75 × enviado)`, aquecimento por caminho); o anfitrião recebe o mínimo reportado. A árvore acrescenta uma terceira opção à R5, além de "ou ele aguenta ou todos descem": **ele muda de lugar** — quando a subida de um repassador cai (jogo, call), o anfitrião reduz o `k` dele e reparenta o excesso sob outro repassador com folga; só sem folga o b desce para todos. Os parâmetros dos senders de um mesmo pai continuam idênticos (R5); a escada não muda (todo degrau continua tirando pixel). O `enviado` de cada repassador é o que ele de fato manda, então a tampa de `1,5 × acked` da ADR 0018 reaparece em **cada** pai, e a regra da 0030 precisa valer em cada um.

**Admissão.** `capacidade` do canal passa a ser `k_h + Σ k_i` ao b atual, menos uma vaga de folga; o servidor continua aplicando `min(servidor, máquina, banda)` sobre o número total de espectadores (0030), sem saber que há árvore. O anfitrião dimensiona a árvore com 10 % de lugares vazios (mínimo 2) para uma entrada não forçar reconstrução (medido no simulador: sem a folga, a árvore se refazia a cada entrada).

### Quando liga

A cascata **não** é o modo padrão. Liga só quando a malha, pela conta da 0030, não admite todos os que querem entrar ou o b da malha ficaria abaixo do piso do 720p60 (6,2 Mbps). Com subida de 300 Mbps e N ≤ 10 a malha já entrega 1080p60 sem expor IP nem somar latência (nas linhas `10 / 300` os dois modos empatam); com N = 10 e 100 Mbps ela entrega 6,8 Mbps (720p60) e a cascata 16,2 — ganho real, mas a malha ainda é boa, e é aí que a decisão é do dono (pergunta 5).

### Custos

- **Latência:** +40 ms por salto no modelo (estudo: 25–45 ms; E2 mede). Profundidade 2: ~190 ms de ponta a ponta contra ~150 ms; profundidade 3: ~230 ms. Com perda de 1 % o jitter buffer da folha precisa somar as recuperações dos saltos: +160 ms com dois saltos (estudo 2 §4.6, [I]).
- **Exposição de IP:** na malha só o anfitrião vê os IPs; na cascata, cada pai e cada filho veem o IP um do outro. A sala é **aberta por padrão** (ADR 0028): quem tem o link pode virar repassador. TURN `relay` nas arestas espectador-espectador não é saída: 16 Mbps são ~7 GB por hora por aresta, e a cota do TURN (ADR 0007) não cobre isso.
- **Churn:** cada saída de repassador derruba a subárvore por 0,7–2 s (modelo; E4 mede). Na malha um espectador só perde a imagem se o anfitrião cai.
- **Repassador joga:** 6 filhos custam ~1,2 núcleo e até 6 × b de subida (97 Mbps a 1080p60), limitado a metade da subida dele; precisa de botão "parar de ajudar" e de saída automática por `cpu`/atraso de quadro.
- **Integridade:** um repassador pode congelar ou **alterar** o vídeo da subárvore (H.264 não é assinado). Assinatura por quadro em SEI é ideia do estudo, [H], fora da fase 1.
- **ICE entre espectadores:** a cascata depende de duas pontas diretas entre espectadores atrás de CGNAT; sem TURN essas arestas podem falhar mais que as arestas para o anfitrião [H]. **O simulador não modela isso**, e é a hipótese que mais pode derrubar o ganho.

## Medido: `e2e/cascata.sim.mjs`

### Método

Uma sala = 1 anfitrião de subida `U` e `N` cadeiras. Subida de cada espectador sorteada das três distribuições do estudo 2 §4.3 (Mbps: 10/25/50/100/300 com pesos **típica** 15/20/30/25/10 %, **pobre** 40/25/20/10/5 %, **fibra** 5/10/25/40/20 % — premissa [A], sem fonte sobre a razão upload/download). 3600 s simulados por rodada, 3 sementes, mediana das rodadas, primeiros 180 s descartados; a **mesma sala sorteada** nos dois modos (semente por célula). Churn: permanência exponencial, média 45 min; a cadeira é reocupada por outra pessoa ~30 s depois (N constante em média). Rajadas de jogo/call em repassadores: a cada ~10 min, 20 s a 50 % da subida.

Rede: o mesmo modelo de `malhas.sim.mjs` (AIMD de 8 %/s, tampa `1,5 × acked + 10 kbps`, recuo a `0,85 × enviado`, ruído de leitura de ±20 %, partilha max-min do uplink por pai), um BWE por aresta, propagação "o filho não recebe mais do que o pai tem". Escada, pisos e tetos: a REAL de `@tela/shared` (`packages/shared/src/encoding.ts`) e `presetParaOrcamento`. Governador coletivo mínimo: orçamento por aresta `0,75 × leitura suavizada` (α = 0,25, aquecimento de 8 amostras), corte quando o mínimo cai abaixo de 70 % do b, subida de 6 % por decisão e sonda com espera 15→240 s. **Malha:** admissão da 0030 em regime (`⌊0,75·U / (1,1·(piso do 360p60 + áudio))⌋`, teto 50). **Cascata:** profundidade ≤ 2, repassador com ≥ 25 Mbps, `f = 0,5`, `K_MAX = 6`, opt-in 100 %, anfitrião como pai reserva; saída de repassador → reanexar com 0,7–1,2 s (reserva no anfitrião) ou 1,2–2,0 s; reconstrução custa 1 s por aresta movida; entrada que não cabe baixa b (porta) e reconstrói. Roda em ~14 s: `node e2e/cascata.sim.mjs` (`--md` imprime a tabela larga, `--dmax=3 --kmax=4 --cede=0.35 --optin=0.5 --premissas` etc.). Artefato: `e2e/cascata.sim.json` (no `.gitignore`).

**Colunas.** *entram* = espectadores médios com imagem, de `N` cadeiras. *Mbps* = vídeo+áudio entregue por espectador (mediana no tempo). *≥720p60* = parcela do tempo-espectador com ≥ 6,2 Mbps. *bpp* = bits por pixel entregues no degrau aplicado (piso 0,10; teto 0,13). *quedas/h* = vezes por espectador-hora que um ancestral saiu e a imagem parou. *trocas/h* = reparentamentos antecipados (rajada, reconstrução) com ~0,5–1 s de glitch. *s sem imagem/h* = soma das duas. Latência extra: **+40 ms** em toda sala com profundidade 2 (p90 igual); 0 onde só o anfitrião repassa.

### Resultados (`N` = 10, 20, 50; `U` = 10, 50, 100, 300 Mbps; profundidade ≤ 2)

**tipica**

| N | host U (Mbps) | malha: entram | malha: Mbps | malha: ≥720p60 | cascata: entram | cascata: Mbps | cascata: ≥720p60 | cascata: bpp | quedas/h | trocas/h | s sem imagem/h | host usa (Mbps) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 | 3,0 | 3,3 | 0 % | 9,9 | 3,7 | 0 % | 0,144 | 1,5 | 2,8 | 5,7 | 7 |
| 10 | 50 | 9,9 | 3,5 | 0 % | 9,9 | 16,2 | 100 % | 0,129 | 0,4 | 1,5 | 2,0 | 32 |
| 10 | 100 | 9,9 | 6,8 | 99 % | 9,9 | 16,2 | 99 % | 0,129 | 0,6 | 2,3 | 3,2 | 65 |
| 10 | 300 | 9,9 | 16,2 | 100 % | 9,9 | 16,2 | 100 % | 0,129 | 0,0 | 0,0 | 0,0 | 160 |
| 20 | 10 | 3,0 | 3,3 | 0 % | 19,8 | 2,5 | 0 % | 0,167 | 0,9 | 1,6 | 4,6 | 7 |
| 20 | 50 | 16,0 | 2,1 | 0 % | 19,7 | 9,3 | 90 % | 0,106 | 1,2 | 7,3 | 9,0 | 35 |
| 20 | 100 | 19,8 | 3,5 | 0 % | 19,8 | 15,0 | 99 % | 0,119 | 1,3 | 6,3 | 8,7 | 69 |
| 20 | 300 | 19,9 | 14,9 | 100 % | 19,9 | 16,2 | 100 % | 0,129 | 0,3 | 0,2 | 0,6 | 209 |
| 50 | 10 | 3,0 | 3,3 | 0 % | 21,0 | 2,5 | 0 % | 0,167 | 0,9 | 2,2 | 4,0 | 7 |
| 50 | 50 | 16,0 | 2,1 | 0 % | 49,5 | 4,7 | 0 % | 0,128 | 1,9 | 5,0 | 8,3 | 37 |
| 50 | 100 | 33,0 | 2,4 | 0 % | 49,4 | 8,3 | 78 % | 0,144 | 1,2 | 10,4 | 11,9 | 72 |
| 50 | 300 | 49,6 | 5,1 | 0 % | 49,5 | 16,1 | 100 % | 0,128 | 1,1 | 7,2 | 8,2 | 209 |

**pobre**

| N | host U (Mbps) | malha: entram | malha: Mbps | malha: ≥720p60 | cascata: entram | cascata: Mbps | cascata: ≥720p60 | cascata: bpp | quedas/h | trocas/h | s sem imagem/h | host usa (Mbps) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 | 3,0 | 3,3 | 0 % | 9,9 | 3,7 | 0 % | 0,144 | 1,2 | 1,7 | 5,3 | 7 |
| 10 | 50 | 9,9 | 3,5 | 0 % | 9,9 | 9,3 | 96 % | 0,106 | 1,3 | 5,4 | 9,7 | 36 |
| 10 | 100 | 9,9 | 6,7 | 100 % | 9,9 | 16,2 | 100 % | 0,129 | 0,5 | 2,1 | 2,5 | 66 |
| 10 | 300 | 9,9 | 16,2 | 100 % | 9,9 | 16,2 | 100 % | 0,129 | 0,0 | 0,0 | 0,0 | 160 |
| 20 | 10 | 3,0 | 3,3 | 0 % | 19,8 | 2,5 | 0 % | 0,167 | 1,1 | 2,7 | 5,5 | 7 |
| 20 | 50 | 16,0 | 2,1 | 0 % | 19,8 | 7,5 | 73 % | 0,133 | 1,3 | 8,6 | 10,2 | 34 |
| 20 | 100 | 19,8 | 3,5 | 0 % | 19,8 | 15,0 | 98 % | 0,122 | 1,1 | 5,8 | 8,7 | 69 |
| 20 | 300 | 19,8 | 14,9 | 100 % | 19,8 | 16,2 | 100 % | 0,129 | 0,4 | 0,3 | 0,9 | 208 |
| 50 | 10 | 3,0 | 3,3 | 0 % | 21,0 | 2,5 | 0 % | 0,167 | 0,9 | 1,7 | 4,4 | 7 |
| 50 | 50 | 16,0 | 2,1 | 0 % | 49,5 | 4,7 | 0 % | 0,128 | 1,1 | 5,9 | 7,0 | 37 |
| 50 | 100 | 33,0 | 2,4 | 0 % | 49,5 | 8,3 | 74 % | 0,147 | 1,2 | 13,2 | 13,9 | 71 |
| 50 | 300 | 49,5 | 5,1 | 0 % | 49,4 | 11,0 | 95 % | 0,125 | 1,0 | 11,8 | 12,5 | 211 |

**fibra**

| N | host U (Mbps) | malha: entram | malha: Mbps | malha: ≥720p60 | cascata: entram | cascata: Mbps | cascata: ≥720p60 | cascata: bpp | quedas/h | trocas/h | s sem imagem/h | host usa (Mbps) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 | 3,0 | 3,3 | 0 % | 9,9 | 3,7 | 0 % | 0,144 | 1,4 | 1,5 | 5,8 | 7 |
| 10 | 50 | 9,9 | 3,5 | 0 % | 9,9 | 16,2 | 100 % | 0,129 | 0,6 | 1,4 | 1,5 | 33 |
| 10 | 100 | 9,9 | 6,8 | 100 % | 9,9 | 16,2 | 100 % | 0,129 | 0,7 | 0,7 | 2,0 | 64 |
| 10 | 300 | 9,9 | 16,2 | 100 % | 9,9 | 16,2 | 100 % | 0,129 | 0,0 | 0,0 | 0,0 | 160 |
| 20 | 10 | 3,0 | 3,3 | 0 % | 19,8 | 2,5 | 0 % | 0,167 | 1,2 | 2,9 | 8,0 | 7 |
| 20 | 50 | 16,0 | 2,1 | 0 % | 19,8 | 12,5 | 100 % | 0,099 | 1,6 | 4,9 | 9,4 | 37 |
| 20 | 100 | 19,8 | 3,5 | 0 % | 19,8 | 15,0 | 100 % | 0,119 | 1,1 | 3,0 | 4,7 | 68 |
| 20 | 300 | 19,8 | 14,9 | 100 % | 19,8 | 16,2 | 100 % | 0,129 | 0,4 | 0,0 | 0,6 | 208 |
| 50 | 10 | 3,0 | 3,3 | 0 % | 21,0 | 2,5 | 0 % | 0,167 | 1,2 | 0,0 | 4,0 | 7 |
| 50 | 50 | 16,0 | 2,1 | 0 % | 49,4 | 4,7 | 0 % | 0,128 | 1,3 | 2,9 | 5,3 | 37 |
| 50 | 100 | 33,0 | 2,4 | 0 % | 49,4 | 9,4 | 100 % | 0,107 | 0,7 | 3,1 | 4,5 | 75 |
| 50 | 300 | 49,4 | 5,1 | 0 % | 49,4 | 16,2 | 100 % | 0,129 | 0,8 | 1,8 | 2,6 | 210 |

### Sensibilidade (N = 50, uma variável por vez)

| variante (cascata, N = 50) | tipica U=50 | tipica U=100 | pobre U=100 | pobre U=300 |
|---|---|---|---|---|
| base: Dmax 2, K 6, cede 50 %, opt-in 100 % | 4,7 Mbps, 0 % ≥720p60, +40 ms, 1,9 q/h | 8,3 Mbps, 78 % ≥720p60, +40 ms, 1,2 q/h | 8,3 Mbps, 74 % ≥720p60, +40 ms, 1,2 q/h | 11,0 Mbps, 95 % ≥720p60, +40 ms, 1,0 q/h |
| Dmax 3 | 11,3 Mbps, 97 % ≥720p60, +80 ms, 2,9 q/h | 16,2 Mbps, 97 % ≥720p60, +40 ms, 1,6 q/h | 7,5 Mbps, 71 % ≥720p60, +40 ms, 1,4 q/h | 11,8 Mbps, 96 % ≥720p60, +40 ms, 1,0 q/h |
| K_MAX 4 | 3,4 Mbps, 0 % ≥720p60, +40 ms, 1,4 q/h | 7,5 Mbps, 98 % ≥720p60, +40 ms, 1,1 q/h | 5,6 Mbps, 10 % ≥720p60, +40 ms, 1,0 q/h | 11,8 Mbps, 95 % ≥720p60, +40 ms, 0,9 q/h |
| cede 35 % | 4,7 Mbps, 0 % ≥720p60, +40 ms, 1,3 q/h | 7,5 Mbps, 51 % ≥720p60, +40 ms, 1,2 q/h | 5,8 Mbps, 22 % ≥720p60, +40 ms, 1,0 q/h | 10,7 Mbps, 94 % ≥720p60, +40 ms, 1,0 q/h |
| opt-in 50 % | 4,7 Mbps, 0 % ≥720p60, +40 ms, 0,9 q/h | 8,3 Mbps, 74 % ≥720p60, +40 ms, 1,0 q/h | 5,3 Mbps, 26 % ≥720p60, +40 ms, 0,8 q/h | 8,0 Mbps, 80 % ≥720p60, +0 ms, 0,7 q/h |
| opt-in 25 % | 4,1 Mbps, 0 % ≥720p60, +40 ms, 1,3 q/h | 5,3 Mbps, 8 % ≥720p60, +40 ms, 1,1 q/h | 3,9 Mbps, 0 % ≥720p60, +40 ms, 0,6 q/h | 7,5 Mbps, 55 % ≥720p60, +0 ms, 0,5 q/h |

### O que a tabela diz

1. **Onde a malha afoga, a cascata paga.** `N = 50`: `U = 50` leva a malha a 16 entradas a 2,1 Mbps e a cascata a 49,5 entradas a 4,7 Mbps (720p60 em nenhuma das duas; só com `Dmax = 3`, 97 % ≥ 720p60 a 11,3 Mbps e +80 ms); `U = 100`: 33 a 2,4 Mbps contra 49,5 a 8,3 (típica, 78 % ≥ 720p60) ou 9,4 (fibra, 100 %); `U = 300`: 5,1 contra 16,2 (típica, fibra) e 11,0 (pobre). Com `N = 20` e `U = 50–100` a cascata sai de 2,1–3,5 Mbps para 7,5–15 Mbps. Com `U = 10` a cascata admite **21** onde a malha admite 3 (limite de profundidade 2, 6 filhos), mas a 2,5 Mbps — sala entra, qualidade não.
2. **Onde a malha já basta, a cascata é neutra ou pior.** `U = 300` com `N ≤ 10`: as duas dão 1080p60 (e 14,9 Mbps contra 16,2 em `N = 20`); a cascata só soma exposição de IP e, com repasse, 40 ms. Em `N = 10` e `U = 100` a malha já dá 6,8 Mbps (720p60) e a cascata, 16,2. Por isso "quando liga".
3. **O custo de continuidade é pequeno mas real:** 0–1,9 quedas por espectador-hora (o estudo previa 1,3–2,6) e 0–14 s sem imagem por hora, a maior parte em reparentamentos antecipados de rajada (premissa minha: 1 rajada de jogo a cada 10 min por repassador) e reconstruções. A malha tem 0 nesse modelo.
4. **O ganho depende de quantos aceitam ajudar.** Com opt-in de 25 % (`N = 50`) o ganho cai a 4,1–5,3 Mbps em `U = 50–100` (típica) e a 3,9 (pobre, `U = 100`: 0 % ≥ 720p60) — continua acima da malha (2,1–2,4 Mbps), mas não chega a 720p60. Com `K_MAX = 4` ou `cede = 35 %` os resultados em `U = 100` pobre caem de 8,3 a 5,6–5,8 Mbps.
5. **Profundidade 3 não é monotônica** no simulador (`U = 100`, pobre: 7,5 contra 8,3 de profundidade 2): a reconstrução mais frequente custa o que a profundidade extra ganha. Não foi investigado; a fase 1 fica em 2.

### Limites (o que este número NÃO prova)

- **O governador é um substituto mínimo**, não a sessão real de `malhas.sim.mjs`: com corte em 70 % de `0,75 × estimativa` ele opera a ~90 % do link, não a 75 %, então os números **absolutos** de qualidade (os dois lados) são otimistas em ~10–20 %; a comparação malha × cascata usa o mesmo governador nos dois lados. A porta da malha está em regime (sem a janela de 5 até medir e sem o atraso de 10–25 s da 0030): isso **favorece a malha**.
- **Sem perda, fila, jitter ou Wi-Fi.** Só saída de pessoa derruba subárvore; ICE entre espectadores nunca falha; a CPU do repassador não custa FPS ao jogo dele; a latência por salto é uma constante ([I]).
- **Distribuições de subida e permanência são premissa [A]**; só a mediana de 222 Mbps de download (Ookla) e os 66 % de fibra (Anatel) têm fonte, ainda sem checagem na fonte primária. Quem tiver dados troca os pesos em `DISTRIBUICOES`.
- Não há integridade, assinatura nem repassador malicioso.
- Antes de construir, o modelo precisa ser portado para `malhas.sim.mjs` com a sessão real (`UplinkGovernor`, `MeshTopology`, `StatsSampler`) e os portões da ADR 0019 (nenhum estado absorvente, `b` mediano ≥ o da malha em 100 % das células).

## Plano

| Fase | O quê | Passa se |
|---|---|---|
| **0 — E2** (decide tudo) | 3 Chrome: A (anfitrião sintético 1080p60), B (repassador com a fonte trocada), C (folha). Contador de quadro em pixels + relógio comum. RTT 20/40/80 ms entre pares, perda 0/1/2 %, 60 s cada. Mede também `data`/`type` no decoder da folha e `sendKeyFrameRequest` ponta a ponta | `A→C − A→B ≤ 60 ms` a RTT 20 ms sem perda; ≤ 160 ms a 1 % de perda; 0 congelamentos sem perda; folha decodifica sem IDR extra |
| **0b — E3/E4** | CPU de um repassador com 1/2/4/6 filhos (jogo sintético rodando); tempo de religação por `SIGKILL` do repassador, frio e quente | ≤ 0,25 núcleo por filho; religação ≤ 2,0 s frio |
| **1** | `core/mesh/arvore-de-repasse.ts` (puro, R1/R3) + `SessaoDeRepasse`; trocar a fonte do worker de injeção; mensagens `via`/`pai`/relatório; `capacidade` somada; **só desktop como repassador** (ver pergunta 2); profundidade ≤ 2; sem assinatura; sem IDR periódico; porte do modelo para `malhas.sim.mjs` | portões 0019 + `e2e/qualidade.e2e.mjs` com 3 Chrome |
| **2** | profundidade 3; pai reserva "quente"; IDR periódico; relatórios por repassador no governador | latência ≤ 400 ms; ≤ 5 s sem imagem/espectador/h |
| **3 (condicional)** | camadas temporais como "stripes" (estudo 1 §2): só se a medição mostrar salas onde nenhum nó banca uma cópia inteira de 1080p. Fere `maintain-framerate` e exige ADR | — |

Esforço: 3–5 semanas de uma pessoa [H], sem base de medição. **Recomendação:** rodar a fase 0 antes de qualquer outra coisa (é o experimento barato que derruba ou confirma o desenho); só então decidir a fase 1.

## Perguntas ao dono

1. **Exposição de IP entre espectadores é aceitável?** Hoje só o anfitrião vê os IPs. Na cascata, filho e pai se veem, e como a sala é aberta por padrão (ADR 0028) qualquer pessoa com o link pode acabar sendo pai ou filho de outra. Opções: aceitar e avisar na interface; limitar repassador a sala **com convite** (ADR 0021/0025); ou não fazer. TURN `relay` nas arestas não é viável (cota).
2. **O app desktop é o único repassador, ou o navegador também?** Desktop: um parque menor, previsível e instalado de propósito (opt-in natural), com Chromium 152 e capturas já estáveis. Navegador: mais repassadores, mais variância, e depende de `RTCRtpScriptTransform` (só Chromium; Firefox e Safari ficam folha). O simulador com opt-in de 25 % ainda ganha da malha, mas não chega ao 720p60.
3. **+40 ms por salto (+80 a +120 ms no total) é aceitável?** A imagem fica ~190 ms atrás do que o anfitrião vê, contra ~150 ms, enquanto a voz da call do Discord não atrasa. Em E2 pode sair pior que 40 ms; o limite de fase 0 é 60 ms por salto.
4. **Repassador é opt-in explícito ("ajudar a transmitir") ou automático para quem mede ≥ 25 Mbps?** O estudo supõe opt-in; o ganho cai quando poucos aceitam (sensibilidade acima). Em ambos os casos, um botão "parar de ajudar" é obrigatório.
5. *(menor)* A cascata liga **sozinha** quando a malha não basta, ou o anfitrião liga à mão ("sala grande")? Automático esconde a mudança de modelo de privacidade da pessoa que não a escolheu.

## Respostas do dono (2026-10-02)

1. **IP entre espectadores: como hoje, sem TURN.** A malha já expõe o IP
   entre o host e cada espectador; o repasse estende isso entre espectadores,
   em conexão direta, sem custo de retransmissão. Decisão do dono: **a
   interface não fala de IP** (nenhuma tela mostra endereço — conferido: o
   diagnóstico só diz "direta"/"TURN"). As opções de TURN (Cloudflare por uso,
   coturn próprio) ficam registradas para se a decisão mudar.
2. **Repassador: app e navegador** (Chromium, onde o Encoded Transform de
   recepção existe).
3. **Atraso: o mínimo possível.** Profundidade máxima de UM repassador entre
   o host e qualquer espectador; pai escolhido pelo menor RTT medido; quadro
   repassado ao chegar, sem fila. Estimativa revista: +10 a +25 ms na mesma
   região (a medir no E2 antes de construir).
4. **Automático** para quem mede upload bom.
5. **Liga sozinha** quando a malha não basta (porta da ADR 0030 cheia).

## E2 — medido

Executado em 2026-10-02 por `e2e/bench/estudo-repasse-e2.mjs` (nenhum código de produção alterado; o protótipo do repassador vive dentro do script). Saída bruta das rodadas citadas: `e2e/bench/estudo-repasse-e2.resultados.txt`.

### Método

- **Papéis**, cada um num Chromium próprio (`chromium.launchServer`, para ler a CPU da árvore de processos em `/proc`): *host* (fonte sintética 1280×720@60 com movimento, `CodificadorWebCodecs` real, H.264 6 Mbps, injeção por `FilaDeInjecao` real, isca 160×90 por sender), *A* (espectador direto, controle), *R* (espectador que repassa), *B* (navegador dos filhos de R, mais *A2*, um segundo espectador direto do host no mesmo navegador dos filhos).
- **Repasse sem recodificar:** em R, um `RTCRtpScriptTransform` de **recepção** copia `data`+tipo de cada quadro para a `FilaDeInjecao` do próprio worker de R e devolve o original (R continua decodificando). Cada filho tem uma `RTCPeerConnection` de R cujo sender leva uma isca 160×90 com o transform de injeção — o mesmo mecanismo do D0b, com o transform de recepção no lugar do `VideoEncoder`. A isca é "tocada" (`requestFrame`) por um relógio de R; ver "Tique" abaixo, que foi o achado principal. SDP trocado direto pelo orquestrador, sem trickle, só candidatos de host.
- **Latência autoritativa (contador de quadro):** a fonte desenha uma faixa binária (20 bits do número do quadro + 4 de verificação) e registra `performance.timeOrigin + performance.now()` do desenho; cada espectador lê a faixa por `requestVideoFrameCallback` + canvas e registra o `expectedDisplayTime` no mesmo relógio (mesma máquina). Atraso = exibição − desenho. Efeito por salto = exibição em B − exibição em A (mesmo número de quadro). O `expectedDisplayTime` é quantizado em 16,7 ms (vsync do headless), então a **mediana** de uma diferença cai em múltiplos de 16,7 ms; o que vale é a **média** (a fase relativa varre o ciclo ao longo de 60 s) e o controle `A2 − A` (ruído de fase entre navegadores: média entre −9 e +6 ms nas rodadas abaixo).
- **Carimbo (`abs-capture-time` + `getSynchronizationSources`)** calculado em paralelo, como em `e2e/latencia.e2e.mjs`.
- 60 s de medida após 10 s de aquecimento, 3 rodadas por configuração; custo de CPU em 40 s. `jitterBufferTarget` = 20 ms em todos os espectadores.
- **Limites:** Chromium for Testing **151.0.7922.34** (o 152/Electron 44 não foi exercitado); headless, codec de software (OpenH264/FFmpeg), loopback (RTT ≈ 0, sem perda, sem `tc netem` — não há root; a matriz de RTT 20/40/80 ms e perda 0/1/2 % do plano **não foi rodada**); 720p60, não 1080p60; Ryzen 7 7435HS (16 threads), 15 GiB. **A máquina é compartilhada** com outros agentes (build, e2e, Chromium): o loadavg de 1 min ficou em 3–7 durante as rodadas válidas (parte dele é o próprio experimento, ~4–5 Chromium) e chegou a **280** durante outro processo; duas rodadas contaminadas foram descartadas e refeitas (o script espera loadavg ≤ 4,5 antes de cada rodada e marca a contaminada). Pior: o Chromium de R medindo a faixa (rVFC + leitura de canvas a 60 fps) gasta ~0,45 núcleo só nisso — a CPU de R abaixo foi medida **sem** instrumentar R.

### Resultado 1 — repasse sem recodificar funciona no Chromium 151

Sim, no navegador (o protótipo inteiro roda numa página, então vale para "app e navegador" no que toca a API):

- B decodifica 1280×720 a **60,0 fps**, 0 perda de pacote, 0 congelamentos, **3 de 3 rodadas de 60 s** (com o tique livre, abaixo); R continua decodificando a 60 fps; o decoder de B fica feliz com `data` copiado de um quadro de **recepção** injetado num quadro de **isca** — sem IDR extra. A isca só entrega ao filho a partir de um IDR na ponta (regra da `FilaDeInjecao`), então o `type` da isca é coerente com o conteúdo.
- API sondada em runtime: `sendKeyFrameRequest()` **presente** no transformer de recepção; `RTCEncodedVideoFrame.setMetadata` **ausente** (como previsto); o metadado do quadro de recepção traz `captureTime`, `receiveTime`, `senderCaptureTimeOffset`, `rtpTimestamp`, `mimeType`, `payloadType`, mas **`width`/`height` = 0** para H.264 (o decoder lê o SPS; irrelevante na fase 1).
- Custo de **cópia** em R: 0,1 ms (p50) / 0,2 ms (p95) por quadro; chegada → entrega à isca (com o tique livre): p50 4,6–4,8 ms, p95 11,6–11,9 ms, máx. 17 ms.

### Resultado 2 — latência por salto

Um filho, 60 s por rodada, B − A (média; mediana entre parênteses) e controle A2 − A:

| tique da isca de R | rodada | B − A (ms) | B − A2 (ms) | A2 − A (ms) | chegada→isca p50 (ms) | B decodifica |
|---|---|---|---|---|---|---|
| **por chegada** (como o anfitrião de produção) | 1 | 130 (167) | 140 | −8,5 | 157 | 58,0 fps, 1 congelamento |
| | 2 | 254 (234) | 248 | +6,0 | 226 | 57,9 fps, 1 congelamento |
| | 3 | 275 (300) | 281 | −7,5 | 297 | 57,7 fps, 2 congelamentos |
| **livre, 120 Hz** | 1 | **8,4** (0) | 12,2 | −3,9 | 4,8 | 60,0 fps, 0 |
| | 2 | **12,6** (16,6) | 12,0 | +0,4 | 4,6 | 60,0 fps, 0 |
| | 3 | **9,6** (16,5) | 18,5 | −9,1 | 4,7 | 60,0 fps, 0 |

- **Com tique livre o salto custa ≈ +10 a +19 ms** (média de B − A2, o controle no mesmo navegador; ~+12 ms de B − A descontado o ruído). É o que a resposta 3 do dono estimou (+10 a +25 ms na mesma região); o limite de fase 0 (≤ 60 ms por salto a RTT 20 ms) **passa com folga, mas em loopback**: numa rede real soma-se ≈ RTT(R,B)/2 mais a serialização do quadro. Latência absoluta do host: A ≈ 41–49 ms (média; mediana 49 ms), B ≈ 57 ms (média), p95 66 ms, máx. 83 ms.
- **Com tique por chegada (o desenho de produção copiado sem pensar) o salto custa +130 a +275 ms e NÃO é estável**: cada vaga de isca leva um quadro, a isca de R só produz vaga depois de a chegada "tocá-la" e passar pelo encoder da isca, então qualquer rajada em R vira fila permanente na `FilaDeInjecao` (chegada→isca p50 157–297 ms, até 694 ms). Nas 3 rodadas R também teve um vão de 1,3–1,8 s sem quadros no início da janela, e a fila nunca mais drenou. No **anfitrião** trocar o tique por chegada pelo livre não mudou nada (A em 32,7 ms nos dois), porque lá o encoder é o gargalo e a fila não acumula; em R não há encoder, e o relógio das vagas precisa ser **independente das chegadas** (ver implicações).
- Quadros-chave: 4 por janela de 60 s em A, R e B (igual no controle direto; não é efeito da cascata).
- O fps "exibido" por rVFC em B (~53) é menor que o decodificado (60,0 pelo `getStats`): artefato do headless com várias páginas no mesmo navegador lendo canvas; vale o decodificado.

### Resultado 3 — `abs-capture-time` NÃO atravessa o repasse

O `captureTimestamp` que B lê é o carimbo da **isca de R** (instante do tique em R), não o do anfitrião: ficou em ≈ 21–25 ms (média) em B **independentemente do atraso real** — com o tique por chegada, B estava a 130–275 ms de atraso e o carimbo dizia 24–25 ms. A cascata esconde, portanto, o primeiro salto e todo atraso acumulado em R; o HUD de latência "captura até a tela" **mentiria** para filhos de repassador. O número verdadeiro só sai do contador de quadro (autoritativo, acima). Em Chromium 151 R **lê** o `captureTime` do host no metadado do quadro recebido, mas **não consegue escrevê-lo** no quadro da isca (`setMetadata` ausente), e o transform de envio não reaproveita o carimbo.

### Resultado 4 — quadro-chave: duas estratégias (host sem/ com IDR periódico)

Entrada de um filho novo em R e PLI do filho (`sendKeyFrameRequest()` no transform de recepção de B), 5 entradas por rodada × 3 rodadas:

| estratégia | IDR periódico no host | entrada → 1º quadro em B | PLI de B → chave decodificada | notas |
|---|---|---|---|---|
| **A. pedir acima** (`sendKeyFrameRequest()` de R ao host) | não | mediana 198–412 ms; saltos a 569–950 ms | 103–118 ms | cada pedido vira um IDR no host visto por **todos** (A recebeu 4); pedidos de R a menos de 2 s do anterior esbarram no limite de 2 s por sender do host |
| **A** | 1 s | mediana 208–257 ms; saltos a 576–760 ms | 103–676 ms | idem |
| **B. cache** (R reenvia do último IDR guardado) | 1 s | mediana **148–150 ms**, estável | 50–463 ms (mediana ≈ 60) | sem tráfego acima; porém o filho entra **atrasado**: latência 2,5–4,5 s depois da entrada com média de 65 a 1010 ms por entrada (mediana ≈ 380 ms; A: 41–50 ms) — a rajada de P guardados, a 1 quadro por vaga, não é drenada |

PLI de A (direto, controle) levou 57–576 ms (a janela de coalescência de 500 ms do host). A estratégia B só serve com um mecanismo de **alcançar** (vários quadros por vaga ou pular até o próximo IDR); o protótipo tentou só vagas extras (relógio de 120 Hz) e não bastou.

### Resultado 5 — custo de R por filho e o que quebra com 3 e 6 filhos

CPU de R (núcleos, 40 s, R **sem** leitura de faixa; tique livre 60 Hz; sem IDR periódico): **0,27–0,29 com 0 filhos** (o transform de recepção + cópia + decodificar/renderizar) → **0,38–0,42 com 1** → **0,55–0,57 com 3** → **0,81–0,85 com 6**. Marginal ≈ **0,09–0,11 núcleo por filho** (720p60, software, esta máquina) — abaixo dos 0,2 que a ADR usa para `K_MAX = 6`. Em CPU, 6 filhos cabem; **em estabilidade, ainda não**:

| configuração (40 s) | R decodifica | filhos decodificam | congelamentos nos filhos | entrada dos filhos 2..k | pedidos acima / feitos |
|---|---|---|---|---|---|
| 3 filhos, tique livre **120 Hz**, só pedir acima | 50 fps | 50–52 fps | 5 | 1,9 s cada | 918 / 18 |
| 6 filhos, 120 Hz | **34,6 fps** | 35–36 fps | 10–11 | 1,9 s cada | 2266 / 42 |
| 3 filhos, **60 Hz** | 57,3 fps | 57–59 fps | 2 | — | 127 / 6 |
| 6 filhos, 60 Hz | 55,6 fps | 56–58 fps | 2 | — | 63 / 6 |
| 3 filhos, 60 Hz, IDR 1 s, **cache** | 59,8 fps | 60–61 fps | 0–1 | 0,2 s | 0 / 0 (3 replays) |
| 6 filhos, 60 Hz, IDR 1 s, **cache** | 59,0 fps | 59–60 fps | 0–1 | 0,2 s | 0 / 0 (6 replays) |
| 3 filhos, 60 Hz, IDR 1 s, pedir acima | 58,6 fps | 58–59 fps | 3 | 0,65–1,35 s | 71 / 4 |
| 6 filhos, 60 Hz, IDR 1 s, pedir acima | 54,9 fps | 55–56 fps | 5 | 0,7–1,3 s | 200 / 10 |

(Latência dos filhos nas linhas com cache: média 75–148 ms contra 62–76 ms com pedir acima, com picos de até 1 s; ver Resultado 4.) Duas causas distintas:

1. **Relógio da isca a 120 Hz × k senders** (720 frames de isca por segundo em R com 6 filhos) sobrecarrega R: o fps que o próprio R recebe cai para 35–50, porque o anfitrião reduz a fila dele. A 60 Hz o problema some. A conta é "taxa × k", não só a taxa.
2. **Pedido de IDR acima por entrada de filho:** cada pedido de R faz o anfitrião gerar IDR e (hipótese, não instrumentada nesta rodada) fazer o sender de R esperar o IDR na ponta descartando P — **R, e com ele todos os filhos, ficam 1,3–2 s sem quadro** (vãos de 1,3–2,0 s medidos em R e nos filhos exatamente nas configurações com mais pedidos: 18 → 42 pedidos feitos por 40 s coincidem com R caindo de 50 para 35 fps). E o filho 2..k espera ~1,9 s: o limite do anfitrião é **um IDR por sender a cada 2 s**, e para o anfitrião todos os filhos de R são o mesmo sender.

### O que quebrou, em uma lista

1. Tique por chegada em R: +130 a +275 ms e crescendo; relógio de vagas tem de ser livre.
2. Isca a 120 Hz com 3–6 filhos: R a 35–50 fps.
3. Pedir IDR acima por entrada de filho: vãos de ~1,5–2 s em R e na subárvore inteira, entrada do 2º filho em ~1,9 s.
4. Cache de GOP com 1 quadro por vaga: entra rápido (150 ms) mas fica atrasado 0,1–1 s.
5. `abs-capture-time`: some o primeiro salto.
6. Medir dentro de R inflou a CPU dele em ~0,45 núcleo (o instrumento falsificava o custo).
7. Duas rodadas lidas sob loadavg 280 (outro processo na máquina) — descartadas.

### Implicações para o desenho

- **Relógio das vagas:** a isca de R tica **livre** (sem acoplar à chegada), a ~60 Hz por filho quando houver 3 ou mais (≈ 360 vagas/s no total é o teto observado; 120 Hz serve a 1 filho e dá +10 ms; 60 Hz custa ~+8 ms a mais, em troca de estabilidade). Vaga sem quadro novo é descartada pelo transform (já é assim), então o custo ocioso é só o encoder da isca. **Nunca** acoplar vaga a chegada em quem não tem encoder para dar contrapressão.
- **Estratégia de quadro-chave:** não usar `sendKeyFrameRequest()` por entrada de filho. Preferir **IDR periódico do anfitrião (≈ 1 s) + cache de GOP em R** — mas o cache exige um mecanismo de **alcançar**: o desenho atual não drena. Opções a medir: (a) pular o filho para o próximo IDR (custa ≤ 1 s de imagem parada para o recém-chegado, nada para os demais); (b) vários quadros por vaga (não testado; mesmo `rtpTimestamp` na isca pode quebrar o depacketizer). E o `FilaDeInjecao` do anfitrião deve **tratar PLI de R como pedido "para os filhos"**: entregar o IDR **sem** reter os P do sender de R (hoje o sender espera IDR na ponta e descarta P) — a ser confirmado com um contador de quadros descartados, que esta rodada não instrumentou.
- **Carimbo de captura:** a latência medida no espectador de filho precisa de **carimbo no próprio quadro** (ex.: SEI `user_data_unregistered` com o instante de captura do host, escrito uma vez pelo anfitrião e repassado intacto — não testado), ou de `setMetadata` (Chromium 152/Electron 44 com `RTCEncodedFrameSetMetadata`, não testado). Sem isso o HUD de filho deve dizer "só a recepção" (já existe a origem `recepcao` em `PeerLink`).
- **`K_MAX`:** o custo de CPU suporta 6 (0,09–0,11 núcleo/filho a 720p60), mas a estabilidade só foi limpa com **3 filhos** (cache, IDR 1 s, tique 60 Hz) ou 6 com o cache (R 59 fps, mas filhos atrasados). Manter `K_MAX` em 3 até o mecanismo de quadro-chave estar resolvido. 1080p60 e HW não foram medidos; o custo de decodificar/copiar sobe com o bitrate (cópia medida a 6 Mbps).
- **Plano:** E2 "passa" nos critérios de latência e de congelamento **para 1 filho, em loopback**; os critérios de RTT 20/40/80 ms e perda 0/1/2 % **não foram avaliados** (precisam de `tc netem`/root). A fase 1 pode começar sobre o relógio livre, mas o quadro-chave é decisão de projeto em aberto, não detalhe.

### Reprodução

```bash
node e2e/bench/estudo-repasse-e2.mjs --cenarios=latencia --ticks=chegada,livre   # RUNS=3 SEGUNDOS=60
MEDIR_R=0 TICK_HZ=60 node e2e/bench/estudo-repasse-e2.mjs --cenarios=filhos --filhos=1,3,6 --ticks=livre
ESTRATEGIA=cache IDR_MS=1000 MEDIR_R=0 TICK_HZ=60 node e2e/bench/estudo-repasse-e2.mjs --cenarios=filhos --filhos=3,6 --ticks=livre
node e2e/bench/estudo-repasse-e2.mjs --cenarios=chave --tickchave=livre
```
Não precisa do dev server nem do signaling; o script serve a própria página e transpila `FilaDeInjecao` e `CodificadorWebCodecs` de `apps/web/src`.

## O que continua sem verificação

- **Humano:** latência glass-to-glass com a câmera a 240 fps (E2 mede um proxy por relógio comum); FPS do jogo do repassador com MangoHud; taxa de sucesso de ICE entre espectadores atrás de CGNAT brasileiro, com amigos em operadoras diferentes — **a hipótese que mais pode quebrar o ganho**.
- **Máquina:** E2 foi executado em loopback (ver "E2 — medido"); falta a matriz de RTT e perda (`ip netns` + `tc netem`, root), 1080p60 e codec de hardware. E3 e E4 não foram executados.
- Os valores de latência por salto (25–45 ms), religação (0,7–2,0 s) e esforço (3–5 semanas) são [I]/[H].

## Referências

`docs/engenharia/estudo/2-transporte-e-topologia.md` §4, §5; `docs/engenharia/estudo/1-codec.md` §2 (camadas temporais), §6.2 (APIs); `docs/desktop/D0b-um-encode-n-envios.md`; `e2e/cascata.sim.mjs`; `e2e/bench/estudo-topologia.mjs` (a calculadora estática, que previu os mesmos ganhos sem dinâmica); Kumar, Liu & Ross (INFOCOM 2007) para o limite de fluxo.
