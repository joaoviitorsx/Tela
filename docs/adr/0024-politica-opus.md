# ADR 0024 — Política de áudio Opus, verificável

**Data:** 2026-09-28
**Estado:** aceita (parcial: comparação perceptiva pendente)
**Tarefa:** TELA-011 · **Plano:** §6.5–6.6

## O que estava errado, e foi medido

O produto pagava 128 kbps por espectador "para preservar música e efeitos em
estéreo", e o estéreo não chegava. O `stereo=1` era escrito só na descrição
REMOTA do transmissor: ele codificava estéreo, e o espectador decodificava em
mono, porque o decoder do libwebrtc lê o `stereo` da descrição LOCAL de quem
recebe. Em Chrome real, um tom só no canal esquerdo chegava com a mesma
energia nos dois (0,35 / 0,35). Depois da correção: 0,706 / 0 —
`e2e/mesh.e2e.mjs`, passo 3a.

## Decisões

1. **O receptor declara a própria preferência.** Ao responder, o espectador
   usa `createAnswer`, acrescenta `stereo=1` ao `fmtp` do Opus e só então
   `setLocalDescription`. Sem `sprop-stereo` — ele não envia áudio. Se o
   navegador recusar a edição, a resposta intacta vale: mono é pior que
   estéreo, sem áudio é pior que mono.
2. **O transmissor continua escrevendo `stereo`/`sprop-stereo` na remota.**
   O receptor é sempre o espectador do Tela, e isso é a preferência dele; todo
   decoder Opus decodifica estéreo (RFC 7587 §7.1 — preferência, não
   capacidade). Não é o caso do nível H.264 (ADR 0020), que afirmava
   capacidade de decoder.
3. **Opus identificado pelo payload type do `a=rtpmap`**, não por regex em
   `fmtp`. RED (`fmtp:63 111/111`) e `telephone-event` ficam intocados; Opus
   sem `fmtp` não ganha um inventado.
4. **Padrão mantido:** 128 kbps como teto (não consumo), sem processamento de
   voz na captura (ADR/tarefa 009), FEC Opus como o navegador negociar
   (`useinbandfec=1` vem do Chrome), DTX e RED desligados.

## Pendente, e por que não se decide aqui

| Pergunta | Como decidir |
|---|---|
| 128 ou 192 kbps? | Mesma cena densa (música + efeitos), mesmo volume, mesma rede, ouvintes sem saber qual é qual. Promover 192 só com ganho perceptível reproduzível. |
| RED ligado? | Perda em rajada (`tc netem loss 5% 25%`), comparar `audioOcultacaoPct` do diagnóstico e o que se ouve, e medir o atraso a mais. |
| DTX ligado? | Passos baixos, ambiência e silêncios de jogo: ouvir se corta. Não atribuir corte a DTX sem essa evidência. |

A instrumentação para as três já existe (TELA-007): taxa, nível, ocultação e
`codecAudio.parametros` no diagnóstico dos dois lados.
