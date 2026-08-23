# Runbook

Duas árvores de decisão. Use a que descreve o sintoma, não a que descreve sua
suspeita.

---

## Árvore 1 — "o espectador não vê nada"

```
O espectador abre o link e vê "não está transmitindo"?
├─ SIM → o servidor acha que não há transmissão
│  ├─ curl -s $URL/api/live/<slug>
│  │  └─ {"live":false}
│  │     ├─ O transmissor está com a aba aberta?
│  │     │  ├─ NÃO → é isso. Fechar a aba encerra.
│  │     │  └─ SIM → o heartbeat parou
│  │     │     ├─ Console do transmissor: erro em /api/broadcast/ping?
│  │     │     │  ├─ 404 NOT_LIVE → live:{slug} expirou; mande reiniciar
│  │     │     │  └─ 401 → o ownerToken mudou (outro browser/perfil)
│  │     │     └─ docker compose logs api | grep ping
│  │     └─ Modo SFU: o webhook chegou?
│  │        └─ docker compose logs api | grep webhook
│  │           └─ nada → LiveKit não alcança 127.0.0.1:3333
│  │              → confira webhook.urls no livekit.yaml
│  └─ {"live":true} mas a UI diz offline → cache do browser; Ctrl+Shift+R
│
└─ NÃO → conecta e a tela fica preta: é ICE ou mídia
   ├─ chrome://webrtc-internals no espectador
   │  ├─ Nenhum par de candidatos "succeeded"
   │  │  ├─ Modo SFU
   │  │  │  ├─ nc -zvu <IP> 7882  (DE FORA)
   │  │  │  │  ├─ falha → firewall do PROVEDOR (o do SO não é o único)
   │  │  │  │  └─ ok   → use_external_ip: true no livekit.yaml?
   │  │  │  └─ candidatos com IP privado (172.17.x) → falta network_mode: host
   │  │  └─ Modo P2P
   │  │     ├─ Ambos atrás de CGNAT? → configure TURN (SELF-HOSTING §CGNAT)
   │  │     └─ TURN configurado e ainda falha → credencial errada; teste em
   │  │        https://icetest.info
   │  ├─ Par "succeeded" mas bytesReceived = 0
   │  │  └─ Vídeo não está sendo publicado → veja o lado do transmissor
   │  └─ Par tipo "relay" → funciona, mas passando por TURN: +30–80ms
   └─ Vídeo aparece e trava depois de alguns segundos
      └─ Árvore 2
```

---

## Árvore 2 — "está ruim: travando, borrado ou atrasado"

```
Olhe o HUD do transmissor. Ele já diz o motivo.
│
├─ "CPU no limite"
│  ├─ chrome://gpu → "Video Encode: Hardware accelerated"?
│  │  ├─ NÃO → encode em software; nenhuma config de bitrate resolve
│  │  │  ├─ Linux: --enable-features=VaapiVideoEncoder,VaapiVideoDecoder
│  │  │  └─ Não resolveu → caia para 720p60 e priorize a Fase 3 (Tauri)
│  │  └─ SIM → mais de um encoder rodando
│  │     ├─ Modo P2P com 3 espectadores → são 3 encoders. É o esperado.
│  │     │  → baixe o preset ou reduza espectadores (ADR 0002)
│  │     └─ Modo SFU → verifique se não há 3 camadas de simulcast (R5)
│  │
├─ "Rede no limite"
│  ├─ Modo P2P → some espectadores × bitrate e compare com o SEU upload
│  │  └─ passou de 70% do upload? é isso. Baixe o preset.
│  └─ Modo SFU → o limite é do espectador, não seu
│     └─ o simulcast deveria isolar. Se TODOS caíram juntos, o simulcast
│        não está funcionando → confira as duas camadas no publishTrack
│
├─ Sem aviso, mas o vídeo está borrado e o framerate ok
│  └─ Comportamento correto: degradationPreference = maintain-framerate.
│     Perder resolução é a escolha desenhada; gameplay a 30fps nítido é pior.
│
├─ Sem aviso, mas o framerate está baixo
│  └─ contentHint = 'motion' foi aplicado?
│     → chrome://webrtc-internals, contentHint na track de saída
│     → se estiver 'detail', o Chrome está preservando nitidez e matando fps
│
└─ Latência alta (>350ms) com tudo mais normal
   ├─ Onde está o servidor? Fora do Brasil = inviável, ponto final.
   ├─ O par ICE é "relay"? TURN adiciona um salto.
   ├─ Está caindo para TCP na 7881? → 7882/udp fechada
   └─ playoutDelayHint aplicado? Vale 50–100ms.
      → só existe em Chromium; no Firefox a latência é maior por design
```

---

## Comandos do dia a dia

```bash
# saúde
curl -s $URL/api/health | jq

# logs
docker compose -f infra/compose/docker-compose.yml logs -f api
docker compose -f infra/compose/docker-compose.yml logs -f livekit

# métricas do SFU (só na loopback)
curl -s 127.0.0.1:6789/metrics | grep livekit_

# estado no Redis
docker compose exec redis redis-cli --scan --pattern 'live:*'
docker compose exec redis redis-cli hgetall live:joao
docker compose exec redis redis-cli scard viewers:b_joao

# derrubar uma transmissão travada (não apaga o slug)
docker compose exec redis redis-cli del live:joao viewers:b_joao
```

## Deploy

```bash
git pull
pnpm install --frozen-lockfile
pnpm turbo lint typecheck test build

# API: reinicia sem derrubar as salas do LiveKit
docker compose -f infra/compose/docker-compose.yml up -d --build api

# LiveKit: DERRUBA todas as salas ativas. Avise antes.
docker compose -f infra/compose/docker-compose.yml pull livekit
docker compose -f infra/compose/docker-compose.yml up -d livekit
```

## O que NUNCA fazer

- Rodar o LiveKit sob Docker Swarm ou Dokploy — a rede overlay quebra o ICE
- Expor o Redis em `0.0.0.0`
- Ligar `auto_create: true` no livekit.yaml
- Subir para três camadas de simulcast "para melhorar a qualidade"
- Commitar `infra/.env` ou `infra/.env.p2p`
