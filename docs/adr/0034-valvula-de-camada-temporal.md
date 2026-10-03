# ADR 0034 — Válvula de camada temporal por espectador (SVC L1T2)

**Data:** 2026-10-03
**Estado:** aceita (o dono pediu a implementação, 2026-10-03)
**Altera:** R5 em um ponto (abaixo) · **Mantém:** "um encode, N envios" (ADR 0029), parâmetros idênticos, adaptação coletiva da malha (ADR 0015/0017)

## Contexto

No "um encode", quando o sender de UM espectador fica para trás (rede ou
CPU dele), duas coisas ruins acontecem a TODOS: a contrapressão faz o
codificador pular quadros de conteúdo enquanto ele não alcança, e depois de
~1 s ele é "solto" — congela até o próximo IDR, que custa 6–10 quadros de
banda para a sala inteira (`fila-de-injecao.ts`).

O estudo 1-codec (P2) mediu que, em L1T2, descartar a camada não-base é
bit-exato no Chromium: a camada 1 não é referência de ninguém.

## Decisão

1. Com dois ou mais espectadores, o codificador único codifica em **L1T2**
   (`scalabilityMode`), perguntado por modo de aceleração como o Main (um
   `configure` recusado não acusa a GPU).
2. Cada quadro vai à fila com a camada (`metadata.svc.temporalLayerId`).
3. **A válvula:** um sender mais de 3 quadros atrás da ponta passa a pular a
   camada 1 — alcança andando dois quadros por vaga e assiste a meia taxa,
   sem congelar e sem pedir IDR. Fecha ao voltar a até 1 quadro. Abre só
   com o atraso SUSTENTADO por 150 ms (revisão independente): a 60 fps um
   sender saudável passa de 3 quadros por instantes o tempo todo, e abrir
   nesses instantes tirava quadros da camada 1 de quem não precisava.
   L1T2 é sondado na combinação que vai rodar (modo, codec e perfil), e um
   encoder que recusa L1T2 perde só o L1T2, não o Main ou o AV1 junto.
4. A contrapressão e o "soltar" contam o atraso em VAGAS (metade, com a
   válvula aberta): um espectador a meia taxa que acompanha não segura o
   codificador de todo mundo.
5. Sem metadado de camada (NVENC nativo, repassador, encoder sem L1T2), nada
   muda.

## O que muda na R5

`maintain-framerate` continua o padrão, e a adaptação de **bitrate e
resolução** continua coletiva. O que passa a existir é uma degradação de
**framerate por espectador** — só para quem ficou para trás, só enquanto
estiver para trás, e no lugar do congelamento + IDR que ele teria hoje. Os
parâmetros de encoding seguem idênticos: o quadro é um só.

## Medido

- Chromium 151 headless: L1T2 em H.264 (Baseline e Main) aceito; camadas
  saem `0,1,0,1…`; no mesmo alvo, 3,63 contra 3,83 Mbps sem camadas.
- `ESPECTADORES=3 node e2e/um-encode.e2e.mjs`: "H.264 Main · L1T2", os três
  decodificando a taxa cheia da fonte, sem rajada de quadro-chave.
- Testes da fila: válvula abre/fecha, só camada 0 enquanto atrás, nenhum
  pedido de chave, contrapressão em vagas, sem camadas = comportamento antigo.

## Não medido

Um espectador de verdade com rede apertada: que ele passe a 30 fps em vez de
congelar, e que os outros sigam a 60. Validar com dois espectadores, um com
banda limitada (ex.: `tc` no roteador, ou Wi-Fi ruim de propósito).
