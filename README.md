# tela

Transmissão de gameplay em 1080p60 com latência sub-segundo. Self-hosted, sem
cadastro.

Você aperta um botão, ganha um link permanente, manda pros amigos. Eles abrem e
veem seu jogo com ~150ms de atraso. Nada mais.

> Desde 17/08/2026 o Discord suspendeu compartilhamento de tela no Brasil por
> medida da ANPD. O Discord **continua funcionando** para texto e voz — por isso
> este produto não tem chat, voz nem social. Seus amigos já estão na call
> conversando; nós entregamos só o cano de vídeo.

---

## Dois modos

| | **P2P** — sua máquina | **SFU** — servidor |
|---|---|---|
| Precisa de VPS? | **Não** | Sim |
| Espectadores | até 3 | até 12 |
| Gargalo | seu upload e sua CPU | egress do servidor |
| Mídia passa por onde? | direto browser ↔ browser | pelo servidor |

O modo P2P existe para quem não tem onde hospedar. O servidor encolhe para um
hub que troca SDP e ICE e **não vê um byte de mídia** — cabe num Raspberry Pi.
O preço é real e está medido em [`docs/adr/0002`](docs/adr/0002-transporte-p2p-self-host.md):
cada espectador é um encoder na sua máquina e uma cópia do seu upstream.

---

## Rodar local

```bash
pnpm install

# modo P2P — nada além de node. Nem Redis, nem LiveKit.
TELA_TRANSPORT=p2p TELA_STORE=memory SIGNAL_SECRET=$(openssl rand -base64 36) pnpm dev

# modo SFU — precisa das dependências de pé
docker compose -f infra/compose/docker-compose.dev.yml up -d
pnpm dev
```

API em `:3333`, front em `:5173`.

```bash
pnpm turbo lint typecheck test build   # tem que passar antes de qualquer entrega
pnpm depcruise                         # ciclos de dependência
```

---

## Arquitetura em uma frase

**As setas apontam para dentro.**

```
apps/api/src/
  domain/        puro, zero I/O            → só @tela/shared
  ports/         interfaces                → domain
  application/   casos de uso              → domain + ports
  infra/         adapters (redis/livekit/p2p)
  http/          rotas Fastify
  composition.ts fiação — único que importa tudo

apps/web/src/
  core/          sem React, portável para Tauri (Fase 3)
  adapters/      LiveKit, WebRTC, browser APIs
  react/         hooks finos (useSyncExternalStore)
  components/    burros: props → JSX
  routes/        composição de página
```

Isso não é convenção — é lint. Um `import` de `ioredis` em `domain/`, ou de
`livekit-client` em `core/`, quebra o build. A CI verifica que a regra ainda
morde.

O ganho concreto: trocar SFU por P2P foi adicionar um adapter. Nenhum caso de
uso, nenhuma rota e nenhum componente mudou.

---

## O que este produto recusa

Chat, voz, contas, senhas, e-mail, gravação, clipes, emotes, reações,
seguidores, diretório público, busca, múltiplos transmissores por sala,
analytics de terceiros.

Cada item dessa lista transformaria isto em "mais um Discord ruim". A força do
projeto está na recusa.

## Dados pessoais

| Dado | Coletado? |
|---|---|
| Nome, e-mail, telefone, senha | Não |
| Cookie de rastreamento, analytics | Não |
| Gravação de vídeo ou áudio | Não |
| IP | Sim — log do Caddy, retenção 7 dias |
| Slug + hash do ownerToken | Sim — expira em 180 dias de inatividade |

Não há login. O `ownerToken` no `localStorage` **é** a credencial. Perdeu o
`localStorage`, perdeu o link — trade-off consciente, com página de exportação
em `/recuperar`.

---

## Documentação

| Arquivo | Quando ler |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Antes de qualquer tarefa. As sete regras. |
| [`docs/TELA-documentacao-tecnica.md`](docs/TELA-documentacao-tecnica.md) | Arquitetura, infra, contrato de API |
| [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) | Subir na sua máquina ou numa VPS |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Quando quebrar |
| [`docs/adr/`](docs/adr/) | Por que as decisões são o que são |

## Estado

Fase 1 (MVP) implementada: API, núcleo de mídia, UI, os dois transportes, infra.

**Nada foi medido em hardware real.** Latência glass-to-glass, encode por
hardware, impacto no FPS do jogo, áudio de sistema no Linux e comportamento do
simulcast com espectadores reais exigem um humano com máquina, rede e amigos —
o roteiro está em `docs/TELA-documentacao-tecnica.md` §18 e a lista completa em
`docs/adr/0002`.
