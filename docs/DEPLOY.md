# Deploy

Duas peças, e a segunda é quase nada:

1. **Front estático** — HTML, CSS e JS. Qualquer hospedagem de arquivos serve.
2. **Servidor de sinalização** — um processo Node que troca SDP e ICE. Não vê
   mídia, não persiste nada, não precisa de banco.

Não há servidor de mídia, container, firewall de portas UDP nem certificado de
TURN embutido. Tudo isso saiu junto com o SFU (ADR 0005).

---

## O front

```bash
pnpm install
VITE_SIGNAL_URL=wss://signal.seudominio.com pnpm --filter @tela/web build
# publique apps/web/dist/
```

`VITE_SIGNAL_URL` é o endereço público do WebSocket de sinalização. Sem ela, o
front assume `/signal` no mesmo host — que é o que vale em desenvolvimento,
onde o Vite faz proxy.

**SPA fallback é obrigatório.** `tela.gg/joao` precisa servir o `index.html`,
senão o link que a pessoa mandou para os amigos dá 404. Cada hospedagem tem seu
jeito: um `_redirects` com `/* /index.html 200`, um `404.html` copiado do
`index.html`, ou uma regra de rewrite. Confira antes de mandar o primeiro link.

---

## O signaling

```bash
pnpm --filter @tela/shared build
pnpm --filter @tela/signaling build
node apps/signaling/dist/server.js
```

| Variável | Para quê |
|---|---|
| `PORT` / `HOST` | onde escutar (padrão `3333` / `0.0.0.0`) |
| `MAX_PEERS` | espectadores por canal (padrão 3) |
| `STUN_URLS` | lista separada por vírgula |
| `TURN_URL` | servidor de relay, se houver |
| `TURN_SECRET` | segredo compartilhado com o coturn — **prefira este** |
| `TURN_TTL_SECONDS` | validade da credencial efêmera (padrão 600) |

Precisa de TLS: sem `wss://`, o browser recusa a conexão a partir de uma página
`https://`. Qualquer proxy reverso com certificado resolve.

### Verificar

```bash
curl -s https://signal.seudominio.com/health
# {"ok":true,"channels":0}
```

---

## TURN — quando é necessário

Boa parte da banda larga residencial brasileira está atrás de CGNAT: sem IP
público, sem porta encaminhável. O furo de NAT via STUN resolve a maioria dos
casos, porque CGNAT costuma usar mapeamento independente de destino. O que não
resolve é NAT simétrico dos dois lados — e aí só com relay.

**Descubra se é o seu caso:**

```bash
curl -s ifconfig.me                    # IP que a internet vê
ip -4 addr show | grep 'inet '         # IP da sua interface
```

Faixa `100.64.x.x`–`100.127.x.x` na sua interface significa CGNAT.

**IPv6 é o melhor caminho.** Se os dois lados têm IPv6, não há NAT nenhum e o
ICE prefere esse caminho sozinho, sem configuração.

**Credencial efêmera, sempre.** Credencial de TURN estática num front estático
é credencial pública, e credencial pública de TURN é um relay aberto rodando na
sua cota. Use `use-auth-secret` no coturn e `TURN_SECRET` aqui — o servidor
deriva usuário e senha por HMAC, válidos por minutos.

```bash
docker run -d --network=host --name coturn coturn/coturn \
  -n --realm=seudominio.com --fingerprint \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" \
  --no-cli
```

O produto degrada com dignidade se a cota acabar: quem não precisa de relay
continua conectando, e o HUD mostra quantos espectadores estão passando por
lá. Isso é estado esperado, com mensagem clara — não é crash.

---

## Quando algo não funciona

| Sintoma | Causa provável |
|---|---|
| `tela.gg/joao` dá 404 | SPA fallback não configurado |
| Browser recusa conectar | signaling em `ws://` numa página `https://` |
| "Esse link já está sendo usado" e é seu | outro navegador seu ainda está transmitindo, ou você está dentro da carência de 5min com outro `ownerToken` |
| Um amigo específico nunca conecta | CGNAT simétrico dos dois lados: configure TURN |
| Vídeo trava e o ping do jogo sobe | upstream saturado: baixe o preset ou o número de espectadores |
| HUD diz "CPU no limite" | encode em software. Confira `chrome://gpu` → *Video Encode: Hardware accelerated* |
| Reiniciou o signaling e os slugs sumiram | esperado: ele não persiste nada. Transmissões em curso continuam; só entradas novas param |

Para medir latência glass-to-glass de verdade, veja a §18 da documentação
técnica — é medição humana, com câmera a 240fps. `RTCStats` mede rede, não
experiência.
