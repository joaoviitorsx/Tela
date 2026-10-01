# ADR 0029 — Um encode para N envios, e teto de 50 espectadores

**Data:** 2026-10-01
**Estado:** aceita
**Altera:** R5 (a premissa "um encode, três envios"), ADR 0016 (o teto de cinco) · **Mantém:** 0005 (mesh, sem servidor de mídia), 0010/0015/0017/0018 (escada e malhas), R2, R8

## Contexto

O dono pediu para tirar o limite de espectadores — "o Discord não tinha ou, se
tiver, seguimos o limite dele". O Discord tem: **50 por Go Live**. A diferença
é a arquitetura: no Discord o vídeo sobe uma vez para um servidor deles, que
distribui. No Tela, sem servidor de mídia (ADR 0005), quem transmite manda uma
cópia para cada amigo.

Dois custos multiplicam com N:

1. **CPU/GPU.** A R5 dizia que o Chrome reaproveita um encoder entre senders de
   parâmetros iguais — "um encode, três envios". O D0 MEDIU e não é verdade:
   o Chromium codifica uma vez por `RTCPeerConnection`
   (`docs/desktop/D0-relatorio-linux.md`). Com 50 amigos seriam 50 encoders.
2. **Banda de subida.** Cada espectador recebe uma cópia inteira.

## Decisão

1. **"Um encode, N envios" é o transporte de quem transmite**, no app desktop e
   na web quando o navegador tem `MediaStreamTrackProcessor`, `VideoEncoder` e
   `RTCRtpScriptTransform` (Chromium). Um `VideoEncoder` codifica a captura; cada
   sender codifica só uma isca 160×90 e um Encoded Transform troca o conteúdo
   (`D0b-um-encode-n-envios.md`). Custo de encode fixo, qualquer N. No Linux com
   NVIDIA o app usa o encoder nativo NVENC (`D0c-nvenc-linux.md`).
2. **Teto do produto: 50** (`P2P_LIMITS.maxViewers`), paridade com o Discord.
3. **Quem transmite declara a capacidade** no `host` (`capacidade`): 50 no "um
   encode", **5** sem ele (`maxViewersSemUmEncode` — Firefox e Safari ainda
   codificam por espectador). O servidor usa o menor entre o dele e o declarado.
4. **A R5 continua valendo no que ela protege:** H.264, `maintain-framerate`
   como padrão, e parâmetros IDÊNTICOS para todos — agora literalmente, porque
   o quadro é um só. **Adaptação coletiva continua:** a malha de banda divide o
   orçamento por N e todos descem juntos (`mesh-topology.ts`).

## O que se aceita (e o que vem depois)

**Com muitos espectadores, a qualidade é a que o upload paga.** 1080p60 bom
custa ~10–12 Mbps por pessoa; 20 pessoas num link de 100 Mbps de subida descem
juntas para ~720p ou menos, e 50 vão ao piso da escada. Cair de degrau é o
comportamento correto (ADR 0015) — o que não se faz é prometer 1080p para 50.

**O passo seguinte, já decidido pelo dono, é a rede em cascata:** espectadores
com boa subida repassam o quadro codificado para outros, sem recodificar (a
mesma injeção do "um encode", do lado de quem recebe). O upload de quem
transmite fica fixo em poucas cópias e todos mantêm a qualidade, ao custo de
alguma latência por salto. É uma fase própria, com ADR própria: muda a
topologia (quem conecta em quem), a malha de banda (o gargalo passa a ser o
pior repassador) e a reconexão (repassador que sai leva a subárvore junto).

## Alternativa rejeitada

**Servidor de mídia (SFU), como o Discord:** resolveria qualidade e escala, mas
contraria a ADR 0005 e a R2 e põe custo mensal de banda no projeto.
