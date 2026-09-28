# TELA-015 — colapso de banda

Ver ADR 0023 para a decisão e as medidas.

## Executado

- `pnpm turbo lint typecheck test build`, `pnpm depcruise`.
- `node e2e/malhas.sim.mjs` e `node e2e/malhas.sim.mjs --quedas` (tabelas na ADR).
- `node e2e/banda.e2e.mjs` com `pnpm dev` rodando: passou.
- `node e2e/qualidade.e2e.mjs`: ver relatório da tarefa.

## Não executado — roteiro manual

Precisa de uma máquina Linux com root no transmissor.

1. Transmitir um jogo com movimento para um espectador em outra máquina.
2. Esperar 1 minuto no degrau alto.
3. No transmissor: `sudo tc qdisc add dev <interface> root tbf rate 2mbit burst 32kbit latency 400ms`.
4. Esperado em até ~10 s: o degrau desce, e o console mostra "qualidade
   reduzida — sua subida não comporta…". O espectador continua vendo imagem.
5. `sudo tc qdisc del dev <interface> root`.
6. Esperado em 1–3 minutos: o degrau volta a subir.
7. Copiar o diagnóstico do transmissor e anexar ao registro de release.
