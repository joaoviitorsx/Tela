# ADR 0031 — Cascata de repasse: espectadores com boa subida repassam o quadro

**Data:** 2026-10-02
**Estado:** **proposta** (nada implementado; depende de quatro respostas do dono e do experimento E2)
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

1. **IP entre espectadores: oculto.** Conexão direta revela o IP aos dois
   lados — o repasse só esconde passando por TURN. Opções levadas ao dono:
   (a) TURN da Cloudflare só nas arestas de repasse (~160 GB/h numa sala de 50
   a ~8 Mbps: a cota grátis de 1 TB acaba em ~6 h de sala cheia, depois
   ~US$ 8/h); (b) direto só entre quem tem o app, com aviso; (c) **TURN
   próprio (coturn)**, custo fixo — recomendado. *Aguardando a escolha.*
2. **Repassador: app e navegador** (Chromium, onde o Encoded Transform de
   recepção existe).
3. **Atraso: o mínimo possível.** Profundidade máxima de UM repassador entre
   o host e qualquer espectador; pai escolhido pelo menor RTT medido; quadro
   repassado ao chegar, sem fila. Estimativa revista: +10 a +25 ms na mesma
   região (a medir no E2 antes de construir).
4. **Automático** para quem mede upload bom.
5. **Liga sozinha** quando a malha não basta (porta da ADR 0030 cheia).

## O que continua sem verificação

- **Humano:** latência glass-to-glass com a câmera a 240 fps (E2 mede um proxy por relógio comum); FPS do jogo do repassador com MangoHud; taxa de sucesso de ICE entre espectadores atrás de CGNAT brasileiro, com amigos em operadoras diferentes — **a hipótese que mais pode quebrar o ganho**.
- **Máquina:** E2, E3, E4 (`ip netns` + `tc netem`, root). Nenhum foi executado.
- Os valores de latência por salto (25–45 ms), religação (0,7–2,0 s) e esforço (3–5 semanas) são [I]/[H].

## Referências

`docs/engenharia/estudo/2-transporte-e-topologia.md` §4, §5; `docs/engenharia/estudo/1-codec.md` §2 (camadas temporais), §6.2 (APIs); `docs/desktop/D0b-um-encode-n-envios.md`; `e2e/cascata.sim.mjs`; `e2e/bench/estudo-topologia.mjs` (a calculadora estática, que previu os mesmos ganhos sem dinâmica); Kumar, Liu & Ross (INFOCOM 2007) para o limite de fluxo.
