# Self-hosting

Dois modos. Escolha pelo que você tem, não pelo que soa melhor.

| | **P2P** (sua máquina/rede) | **SFU** (VPS) |
|---|---|---|
| Precisa de servidor? | Não | Sim, com IP público |
| Espectadores | até 3 | até 12 |
| Gargalo | seu upload e sua CPU | egress do servidor |
| Custo | domínio (opcional) | free tier da Oracle, ou ~R$130/mês |
| Impacto no jogo | real — mede antes | nenhum além do encode |
| Funciona atrás de CGNAT? | com TURN, na maioria | sim |

Se você quer mostrar gameplay para 2 ou 3 amigos e não quer provisionar nada:
**P2P**. Se você quer 5 ou mais espectadores, ou quer que o jogo não sinta:
**SFU**.

---

## Modo P2P — hospedar na sua própria máquina

O servidor aqui só troca SDP e ICE. O vídeo vai direto do seu browser para o
browser de cada amigo. Nenhum LiveKit, nenhum Redis.

### 1. Antes de qualquer coisa: meça seu upload

Não é opinião, é aritmética. Cada espectador consome uma cópia inteira do seu
upstream.

```
espectadores × bitrate ≤ 70% do seu upload real
```

| Seu upload | 1080p60 (8 Mbps) | 720p60 (4 Mbps) | 720p60 eco (2,5 Mbps) |
|---|---|---|---|
| 10 Mbps  | 0 | 1 | 2 |
| 35 Mbps  | 3 | 3 | 3 |
| 100 Mbps | 3 | 3 | 3 |

Os 30% de folga não são conservadorismo: sem eles o buffer do roteador enche e
o **ping do seu próprio jogo** sobe. Meça o upload real
(`fast.com`, `speedtest.net`) e use o número medido, não o do plano.

### 2. Suba

```bash
cp infra/.env.p2p.example infra/.env.p2p
# preencha SIGNAL_SECRET com: openssl rand -base64 36
# ajuste PUBLIC_BASE_URL e SIGNAL_WS_URL para o seu domínio

pnpm install && pnpm build
docker compose -f infra/compose/docker-compose.p2p.yml up -d --build
```

Sem Docker também roda:

```bash
pnpm install && pnpm build
TELA_TRANSPORT=p2p TELA_STORE=memory SIGNAL_SECRET=$(openssl rand -base64 36) \
  node apps/api/dist/server.js
```

### 3. Precisa de HTTPS

Sem TLS o browser não dá `getDisplayMedia` e não abre WebSocket seguro. Duas
saídas:

- **Domínio + Caddy** (o compose já faz): aponte um A record para o seu IP. Se o
  IP muda, use DNS dinâmico (DuckDNS, Cloudflare API).
- **Sem porta 80/443 alcançável:** use Let's Encrypt por DNS-01, que não exige
  entrada. O Caddy suporta com o plugin do seu provedor de DNS.

### 4. CGNAT — o obstáculo de verdade

Boa parte da banda larga residencial brasileira está atrás de CGNAT: você não
tem IP público e não consegue encaminhar porta.

**Descubra se é o seu caso:**

```bash
curl -s ifconfig.me                      # IP que a internet vê
ip -4 addr show | grep 'inet '           # IP da sua interface
```

Se o IP da sua interface é `100.64.x.x` a `100.127.x.x`, você está em CGNAT.
Se os dois IPs são diferentes e o seu é privado (`10.`, `192.168.`, `100.64.`),
idem.

**O que ainda funciona:** o furo de NAT via STUN resolve a maioria dos CGNATs,
porque eles costumam usar mapeamento independente de destino. Só de configurar
`STUN_URLS`, boa parte das conexões fecha.

**O que não funciona:** NAT simétrico dos dois lados. Aí só com relay.

**IPv6 é o melhor caminho.** Se você e o espectador têm IPv6, não há NAT
nenhum e o ICE prefere esse caminho sozinho. Vale conferir com o suporte da sua
operadora se o IPv6 está ativo no seu plano.

**Último recurso — TURN.** Um relay com IP público que carrega a mídia inteira.
Sim, isso reintroduz um servidor com egress; é o preço honesto da cauda de
casos que o P2P não fecha (ADR 0002).

```bash
# coturn numa VPS mínima
docker run -d --network=host --name coturn coturn/coturn \
  -n --realm=seudominio.com --fingerprint --lt-cred-mech \
  --user=tela:UMA_SENHA_LONGA \
  --no-cli --no-tls --no-dtls
```

```bash
# infra/.env.p2p
TURN_URL=turn:turn.seudominio.com:3478
TURN_USERNAME=tela
TURN_PASSWORD=UMA_SENHA_LONGA
```

### 5. Verifique antes de chamar os amigos

```bash
curl -s https://seudominio.com/api/health | jq
# { "ok": true, "transport": "p2p", "store": true, "gateway": true, ... }
```

Depois, com um amigo de verdade: abra `chrome://webrtc-internals` durante a
transmissão e confira o par de candidatos ICE que venceu. Se for `relay`, você
está passando por TURN — funciona, mas com latência a mais.

---

## Modo SFU — VPS

### Escolha do servidor: egress, não CPU

O SFU só encaminha pacotes. Dez espectadores não passam de 15% de 2 vCPUs. O
que estoura o orçamento é banda.

| Provedor | Região | Egress | Veredito |
|---|---|---|---|
| **Oracle Cloud** | São Paulo | 10 TB/mês grátis | Melhor opção |
| Vultr | São Paulo | 4 TB | Ótimo, simples |
| Magalu / Locaweb | Brasil | varia | Leia o contrato de tráfego |
| AWS sa-east-1 | São Paulo | ~US$0,15/GB | **Não use** — 1,5TB ≈ US$225/mês |
| DigitalOcean | — | — | Sem região no Brasil |

**Latência é geografia.** De Fortaleza: São Paulo ~35–45ms, Miami ~120ms,
Frankfurt ~200ms. Servidor fora do Brasil inviabiliza o produto.

### DNS

```
A  tela.gg       →  <IP público>
A  www.tela.gg   →  <IP público>
A  turn.tela.gg  →  <IP público>
```

`turn.tela.gg` precisa existir: o TURN embutido do LiveKit usa esse hostname no
certificado TLS que ele mesmo obtém.

### Passo a passo numa VM nova

```bash
# 1. provisiona (Docker, sysctl, avisos)
sudo bash infra/scripts/bootstrap.sh

# 2. firewall do SO
sudo bash infra/scripts/firewall.sh

# 3. MESMAS portas no firewall do PROVEDOR — este é o passo esquecido
#    Oracle: Networking → VCN → Security List → Ingress Rules
#    22/tcp 80/tcp 443/tcp 7881/tcp 7882/udp 3478/udp 5349/tcp

# 4. segredos
cp infra/.env.example infra/.env
openssl rand -base64 36   # → LIVEKIT_API_SECRET no .env E no livekit.yaml

# 5. build e sobe
pnpm install && pnpm build
docker compose -f infra/compose/docker-compose.yml up -d --build

# 6. verifica
curl -s https://tela.gg/api/health | jq
nc -zvu <IP> 7882          # DE FORA da máquina
```

### Portas — e por que a UDP importa

| Porta | Proto | Para quê |
|---|---|---|
| 443 | tcp | HTTPS, front, API, signaling |
| 80 | tcp | ACME (Let's Encrypt) |
| **7882** | **udp** | **mídia — é o que faz o produto funcionar** |
| 7881 | tcp | fallback ICE/TCP |
| 3478 | udp | TURN |
| 5349 | tcp | TURN sobre TLS |

Se a 7882/udp estiver fechada, tudo cai para TCP na 7881. O TCP retransmite em
ordem, e a latência dobra ou triplica. O produto "funciona" e é ruim — o pior
tipo de falha.

---

## Armadilhas

| Sintoma | Causa provável | Correção |
|---|---|---|
| Docker trava minutos ao subir o LiveKit | Sem `network_mode: host` | Sempre host network |
| Signaling conecta, vídeo nunca aparece | `use_external_ip: false` atrás de NAT | `true`, ou fixe `node_ip` |
| Alguns conectam, outros não | Certificado do TURN faltando | `turn.<dominio>` no DNS + porta 80 aberta |
| `tela.gg/joao` dá 404 | Faltou `try_files` no Caddy | SPA fallback para `index.html` |
| Qualquer token cria sala | `auto_create: true` | `false`; só a API cria |
| ICE quebra sem explicação | LiveKit sob Swarm/Dokploy | Rode fora do Swarm, compose direto |
| Redis comprometido | Bind em `0.0.0.0` | `127.0.0.1:6379:6379` |
| P2P: um amigo nunca conecta | CGNAT simétrico | Configure TURN |
| P2P: jogo com ping alto durante a transmissão | Upstream saturado | Baixe o preset ou o número de espectadores |
