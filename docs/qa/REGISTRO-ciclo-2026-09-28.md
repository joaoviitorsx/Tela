# Registro do ciclo — 2026-09-28

Formato da §15.4 do plano global. Resultados observados, não "build passou".

**Base:** `develop` em `c3ef2b2` (TELA-001 a 005 feitas, 006 preparada).
**Protocolo:** v2 (convite obrigatório). Cliente v1 é recusado — recarregar resolve.
**Não publicado:** nada foi enviado ao remoto nem ao Cloudflare.

## Tarefas deste ciclo

| Tarefa | Estado do código | Verificado aqui | Depende de gente |
|---|---|---|---|
| 007 estatísticas e estados de áudio | feito | unit + Chrome (transmissor) | espectador em Firefox/Safari; perda real |
| 008 parâmetros de áudio verificáveis | feito | unit + Chrome (128 kbps aceito, prioridade alta aceita) | — |
| 009 grafo e ciclo da captura | feito | unit + Chrome (grafo, religar, fallback mudo) | contexto suspenso de verdade (aba em 2º plano, troca de fone) |
| 010 script Linux | feito | `pactl` falso, 16 asserções | PipeWire real — roteiro em `TELA-010-audio-linux.md` |
| 011 política Opus | parcial | estéreo L/R em Chrome (0,706 / 0) | 128×192, RED, DTX — ADR 0024 |
| 012 troca coordenada de áudio | feito | unit + Chrome (troca pelo mesmo sender) | troca de tela real com `getDisplayMedia` |
| 013 primeiro quadro e erros por etapa | feito | unit + Chrome (textos) | — |
| 014 nível H.264 | feito | `qualidade.e2e` (nível preservado, 1080p no software) | encoder de hardware — ADR 0020 |
| 015 colapso de banda | feito | simulador + Chrome com link estreito | colapso numa conexão viva — `TELA-015-colapso.md` |
| 017 orçamento total | parcial | unit (reserva de áudio) | admissão por capacidade depende da 016 |
| 018 convite e protocolo v2 | feito | conformidade Node + Durable Object; Chrome (sem convite / convite errado) | aprovação manual de espectador: pedida para depois |
| 019 endurecer entrada | feito | unit + conformidade | deploy real no Worker (alarme, Origin) |
| 021 PiP | parcial | unit (PiP conta como visível) | PiP nativo e tela cheia em navegador com tela |
| 022 pausa de privacidade | feito | unit + Chrome (480×270 no lugar da tela) | — |
| 023 documentação | feito | — | — |
| 024 CI | feito | YAML validado; os passos rodam local | primeira execução no GitHub |
| Interface CRT âmbar (protótipo v3) | feito | screenshots 1440/390, fluxo ao vivo com captura simulada | `getDisplayMedia` real, leitor de tela |

## Não feitas neste ciclo

- **006** homologação de relay UDP/TCP/TLS — sem ambiente de laboratório.
- **016** benchmark de encoder com 0/1/3/5 espectadores — exige hardware e jogo.
- **020** fluxo "transmitir agora" — coberto pela interface nova; o clipboard com fallback não foi conferido em navegador sem permissão.
- **025** operação: canário de relay, alertas de cota — exige infraestrutura fora do repositório.
- **026** refatoração: `broadcast-session.ts` passou de 1.700 linhas; separar governador+sonda num módulo próprio é o próximo passo, em PR só de refatoração.
- **027–034** desktop — aguardando decisão (Electron é a direção proposta, não aprovada).

## Resultados de rede

- Conexão direta: Chrome ↔ Chrome, loopback — ok.
- Relay UDP/TCP/TLS: **não executado**.

## Configuração nova

- `ALLOWED_ORIGINS`: obrigatória no Node em produção; no Worker, opcional (a própria origem já passa).

## Reversão

O protocolo v2 recusa clientes v1. Voltar o servidor para antes de `e97c3a1` reabre salas sem convite para quem adivinhar o nome: não reverter o servidor sem reverter o front junto.
