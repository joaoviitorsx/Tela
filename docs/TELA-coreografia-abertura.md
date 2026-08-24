# Tela — Coreografia de Abertura: Especificação Técnica

> Complemento de `PROMPT-agente-3d-abertura.md`. Aquele documento dá a
> direção; **este dá os números**.
>
> Onde houver conflito, este vence. Onde este for omisso, pergunte —
> não invente.
>
> **Implementação e desvios: `docs/adr/0011-abertura-3d-e-desvios-da-coreografia.md`.**

---

## 1. Espaço e convenções

Sistema de coordenadas com a TV na origem, tela voltada para `+z`.

| | |
|---|---|
| Altura do tubo | 1.0 unidade |
| Largura do tubo | 1.33 un (4:3 — é um CRT) |
| Plano do vidro | `z = 0` |
| Profundidade do corpo | 1.1 un, em `-z` |
| Ponta das antenas | ~1.4 un acima da origem |

Tempo em segundos a partir do mount do componente. `t = 0` é o primeiro frame renderizado, não o início do download.

---

## 2. Máquina de estados

```
                    ┌──────────────┐
   mount ──────────►│   PROBING    │  mede capacidade (≤150ms)
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        │ capaz            │ reduced-motion   │ incapaz / 2ª visita
        ▼                  ▼                  ▼
  ┌───────────┐      ┌───────────┐      ┌───────────┐
  │  PLAYING  │      │   FADE    │      │  BYPASS   │
  │   1.8s    │      │   300ms   │      │    0ms    │
  └─────┬─────┘      └─────┬─────┘      └─────┬─────┘
        │ skip / fim       │                  │
        └──────────────────┴──────────────────┘
                           ▼
                    ┌──────────────┐
                    │   HANDOFF    │  crossfade 120ms
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │     DONE     │  canvas desmontado
                    └──────────────┘
```

**PROBING** — antes de qualquer pixel:
1. `localStorage.getItem('tela.intro.seen')` → se existe, `BYPASS`
2. `matchMedia('(prefers-reduced-motion: reduce)')` → se true, `FADE`
3. Contexto WebGL disponível? Se não, `FADE`
4. Renderiza 1 frame de aquecimento e mede. `> 32ms` → `FADE`
5. Total do PROBING passou de 150ms → `BYPASS`

O passo 4 é a proteção real contra máquina fraca. Não confie em user-agent nem em contagem de núcleos — meça um frame.

Grave `tela.intro.seen` **ao entrar em HANDOFF**, não no fim. Se o usuário recarregar no meio, ele já viu o suficiente.

---

## 3. Câmera — keyframes

| t (s) | Posição (x, y, z) | LookAt | FOV | Easing até aqui |
|---|---|---|---|---|
| 0.00 | (0.38, 0.24, 2.95) | (0, 0, 0) | 32° | — |
| 0.50 | (0.38, 0.24, 2.95) | (0, 0, 0) | 32° | hold |
| 1.15 | (0.00, 0.00, 2.30) | (0, 0, 0) | 34° | `cubic-bezier(.65,0,.35,1)` |
| 1.80 | (0.00, 0.00, 0.26) | (0, 0, 0) | 64° | `cubic-bezier(.55,0,1,.45)` |

Duas decisões deliberadas:

**O 3/4 inicial existe para provar que é 3D.** Frontal desde o começo desperdiça o modelo — parece imagem estática até a câmera se mover.

**O dolly usa ease-in, não ease-out.** Acelerando ao entrar, a sensação é de ser *puxado* para dentro do tubo. Com ease-out o movimento desacelera na chegada e vira "câmera estacionando" — mata o efeito.

A abertura de FOV de 34° para 64° durante o dolly é o que vende a entrada. Sem ela, é só um zoom.

---

## 4. Conteúdo da tela — camadas

Renderize para uma textura aplicada ao vidro, empilhada assim:

| # | Camada | Descrição |
|---|---|---|
| L0 | Base | `#0A0F12` sólido |
| L1 | Linha de ignição | Barra branca horizontal, o gesto de CRT ligando |
| L2 | Chiado | Ruído animado |
| L3 | Interface | A UI real (§6) |
| L4 | Scanlines | Linhas horizontais escuras, período 3px |
| L5 | Roll bar | Faixa clara larga descendo lentamente |
| L6 | Vinheta | Escurecimento dos cantos, curva do tubo |

### Keyframes por camada

**L1 — linha de ignição**

| t | Altura | Largura | Opacidade | Easing |
|---|---|---|---|---|
| 0.20 | 0 | 0% | 0 | — |
| 0.26 | 2px | 100% | 1.0 | `cubic-bezier(.16,1,.3,1)` |
| 0.34 | 2px | 100% | 1.0 | hold |
| 0.50 | 100% | 100% | 0 | `cubic-bezier(.16,1,.3,1)` |

A ordem importa: **primeiro a linha abre na horizontal, depois expande na vertical.** É assim que um CRT real liga. Fazer os dois juntos parece fade genérico.

**L2 — chiado**

| t | Opacidade | Observação |
|---|---|---|
| 0.44 | 0 | — |
| 0.52 | 1.0 | entra por baixo da linha em expansão |
| 0.90 | 1.0 | hold |
| 1.10 | 0.15 | resíduo durante a sintonia |
| 1.45 | 0 | — |

**L3 — interface**

| t | Opacidade | Deslocamento |
|---|---|---|
| 0.88 | 0 | — |
| 0.90 | 1.0 | corte seco, com tear (abaixo) |
| 1.80 | 1.0 | — |

A "sintonia" não é fade. São **três rasgos horizontais** que deslocam faixas da imagem:

| t | Duração | Faixa (y) | Deslocamento x |
|---|---|---|---|
| 0.90 | 40ms | 0.30–0.45 | +6% |
| 0.96 | 30ms | 0.55–0.70 | −4% |
| 1.02 | 25ms | 0.15–0.25 | +2% |

Amplitude decrescente. É o sinal travando.

**L4 — scanlines**

| t | Opacidade |
|---|---|
| 0.52 | 0.35 |
| 1.30 | 0.35 |
| 1.70 | 0 |

Período fixo de 3px **em espaço de tela**, não em UV. Se você amarrar na UV, as linhas engrossam durante o dolly e viram listras gigantes.

**L5 — roll bar**

Faixa de 18% da altura, `#FFFFFF` a 6% de opacidade, descendo de `y = -0.2` a `y = 1.2` em 2.2s, linear, em loop. Ativa de `t = 0.52` até `t = 1.50`.

Detalhe pequeno que vende CRT mais que qualquer outro. Não corte.

**L6 — vinheta**

| t | Intensidade |
|---|---|
| 0.52 | 0.55 |
| 1.30 | 0.55 |
| 1.75 | 0 |

---

## 5. Distorção de barril

O abaulamento do tubo aplicado à textura da tela.

| t | k1 | Easing |
|---|---|---|
| 0.00 | 0.28 | — |
| 1.20 | 0.28 | hold |
| 1.75 | 0.00 | `cubic-bezier(.33,1,.68,1)` |

O relaxamento para zero é o que faz a transição para o DOM plano ficar invisível. Se `k1` ainda for maior que `0.01` no handoff, o salto aparece.

---

## 6. O conteúdo da interface dentro do tubo

Três opções, em ordem de preferência:

**A — snapshot estático.** Renderize a home uma vez para imagem no PROBING e use como textura. Barato, e nada da UI precisa estar vivo dentro do tubo.

**B — `foreignObject` / DOM-to-texture.** Mais fiel, muito mais caro. Só se A não casar bem no handoff.

**C — recriar a UI no canvas.** Não faça. Duas fontes de verdade divergem no primeiro ajuste de layout.

Vá de A. A UI dentro do tubo aparece por 0.9s, distorcida e com scanlines — ninguém vai notar que é imagem.

**Requisito absoluto:** o snapshot é capturado com **a mesma largura de viewport** do DOM real. Se a escala divergir, o crossfade denuncia.

---

## 7. Handoff

### Pilha de camadas

```
z-index 0   →  DOM real, montado, interativo, opacity 1 desde t=0
z-index 10  →  canvas, pointer-events: none
```

O canvas **nunca** captura ponteiro. O skip é escutado no `document` em fase de captura.

### Sequência

| t | Ação |
|---|---|
| 1.80 | `canvas.style.opacity` 1 → 0 em 120ms, linear |
| 1.92 | `canvas.remove()`, contexto WebGL descartado, `requestAnimationFrame` cancelado |

Nunca esconda o canvas com `display: none` e o deixe montado — GPU segue alocada e o dispositivo continua esquentando.

### O problema do clique atravessado

Com `pointer-events: none`, um clique durante a abertura **passa para o botão embaixo**. Isso é bom quando intencional e ruim quando o usuário só queria pular.

Solução: escudo temporário.

```
pointerdown em qualquer lugar
  → skip imediato (§8)
  → instala escudo de 250ms que barra `click` em elementos interativos
  → escudo expira sozinho
```

Assim o primeiro toque **só pula**. O segundo já age normalmente. 250ms é longo o bastante para cobrir o `click` correspondente àquele `pointerdown` e curto o bastante para não parecer travado.

---

## 8. Skip

Dispara em: `pointerdown`, `keydown`, `touchstart`, `wheel`.

```
1. Congela a timeline no t atual
2. Salta todos os valores para o estado final (câmera, k1, opacidades)
3. Renderiza 1 frame nesse estado
4. Entra em HANDOFF (crossfade de 120ms)
5. Instala o escudo de 250ms
```

Total ≤100ms percebido. **Não** faça o skip acelerar a animação restante — usuário que pulou quer o fim agora, não a mesma coisa em 3x.

---

## 9. Variante `prefers-reduced-motion`

Estado `FADE`:

- Câmera **fixa** na posição final. Sem movimento, sem dolly, sem FOV.
- Sem chiado animado. Textura de ruído estática, uma amostra congelada, opacidade 0.2.
- Sem roll bar, sem rasgos de sintonia.
- Sem distorção de barril.
- Crossfade de 300ms do frame estático para o DOM.

Preserva a identidade visual sem nada que dispare enjoo vestibular. Movimento de câmera entrando em objeto é gatilho conhecido, e o dolly com ease-in da §3 é exatamente o tipo mais provocativo.

---

## 10. Áudio

A abertura é **muda**. Sem exceção, sem truque.

Depois do primeiro gesto do usuário, o chiado entra como recompensa da ação:

| Evento | Som |
|---|---|
| Clique em "Transmitir" | Burst de ruído, 180ms, `-18 dBFS`, envelope decaindo |
| Transmissão iniciada | Silêncio — o produto assumiu |

Gere o ruído com Web Audio, não com arquivo:

```
AudioBufferSourceNode (ruído branco, 0.5s, em loop)
  → BiquadFilter lowpass @ 4kHz, Q 0.7
  → GainNode com envelope: 0 → 0.12 em 20ms → 0 em 160ms
  → destination
```

Custo: **zero bytes**. Um WAV de chiado pesaria 40KB para soar igual.

Respeite um mute global persistido em `localStorage`.

---

## 11. Reaproveitamento no estado offline

A mesma pilha de camadas, em modo econômico — a aba pode ficar aberta por horas.

| Parâmetro | Abertura | Offline |
|---|---|---|
| Taxa de atualização | 60fps | **12fps** |
| Chiado | opacidade 1.0 | 0.55 |
| Scanlines | 0.35 | 0.20 |
| Roll bar | ativa | ativa, 2× mais lenta |
| Câmera | animada | fixa, frontal |
| Distorção | animada | fixa em 0.18 |
| Aba oculta | — | **pausa total** |

O `visibilitychange` com pausa não é opcional. Sem ele, o amigo esperando você começar a jogar fica com uma aba consumindo GPU indefinidamente — no mesmo PC que vai rodar o jogo.

---

## 12. Tabela consolidada

| t | Câmera | L1 linha | L2 chiado | L3 UI | L4 scan | L5 roll | L6 vinh. | k1 |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 3/4, 32° | — | — | — | — | — | — | 0.28 |
| 0.20 | hold | nasce | — | — | — | — | — | 0.28 |
| 0.26 | hold | 100% larg. | — | — | — | — | — | 0.28 |
| 0.34 | hold | hold | — | — | — | — | — | 0.28 |
| 0.50 | inicia giro | expandida, some | 0.6 | — | 0.35 | ativa | 0.55 | 0.28 |
| 0.52 | girando | — | 1.0 | — | 0.35 | ativa | 0.55 | 0.28 |
| 0.90 | girando | — | 1.0 | corte + rasgo | 0.35 | ativa | 0.55 | 0.28 |
| 0.96 | girando | — | 0.6 | rasgo 2 | 0.35 | ativa | 0.55 | 0.28 |
| 1.02 | girando | — | 0.3 | rasgo 3 | 0.35 | ativa | 0.55 | 0.28 |
| 1.15 | frontal, 34° | — | 0.15 | estável | 0.35 | ativa | 0.55 | 0.28 |
| 1.20 | dolly inicia | — | 0.15 | estável | 0.35 | ativa | 0.55 | inicia |
| 1.45 | dolly | — | 0 | estável | 0.30 | ativa | 0.40 | 0.16 |
| 1.50 | dolly | — | 0 | estável | 0.25 | encerra | 0.30 | 0.12 |
| 1.70 | dolly | — | 0 | estável | 0 | — | 0.10 | 0.04 |
| 1.75 | dolly | — | 0 | estável | 0 | — | 0 | 0.00 |
| 1.80 | 0.26, 64° | — | — | estável | 0 | — | 0 | 0.00 |
| 1.92 | canvas removido | | | | | | | |

---

## 13. Critérios de aceite

- [ ] Duração 1.80s ±0.05s, medida com `performance.now()`
- [ ] PROBING conclui em ≤150ms; bypass quando estoura
- [ ] Frame de aquecimento >32ms cai para FADE
- [ ] Skip percebido em ≤100ms, a partir de qualquer ponto da timeline
- [ ] Escudo de 250ms impede que o primeiro toque acione o botão
- [ ] `k1` ≤0.01 em `t = 1.80`
- [ ] CLS = 0 no handoff — cole o número medido
- [ ] Canvas removido e contexto WebGL descartado em `t = 1.92`
- [ ] `tela.intro.seen` gravado ao entrar em HANDOFF
- [ ] Segunda visita: canvas nunca é criado
- [ ] `prefers-reduced-motion`: zero movimento de câmera
- [ ] Nenhum som antes do primeiro gesto
- [ ] Offline: 12fps, pausa com aba oculta — cole o uso de CPU medido
- [ ] Scanlines com período constante em espaço de tela durante todo o dolly

---

## 14. Erros prováveis

| Erro | Como aparece | Correção |
|---|---|---|
| Dolly com ease-out | "Câmera estacionando", sem imersão | ease-in: `cubic-bezier(.55,0,1,.45)` |
| Scanlines em UV | Listras engrossam no dolly | período em espaço de tela |
| `k1` residual no handoff | Salto visível na troca | garantir 0.00 em 1.80 |
| Skip acelerando o resto | Parece bug | saltar direto ao estado final |
| Canvas com `display:none` | Dispositivo esquentando | remover do DOM |
| Linha e expansão simultâneas | Vira fade genérico | horizontal primeiro, vertical depois |
| Snapshot em viewport diferente | Crossfade denuncia | mesma largura do DOM real |
| Offline sem `visibilitychange` | GPU ocupada por horas | pausar aba oculta |
