# Deploy

Duas peças, e a segunda é quase nada:

1. **Front estático** — HTML, CSS e JS. Qualquer hospedagem de arquivos serve.
2. **Servidor de sinalização** — um processo Node que troca SDP e ICE. Não vê
   mídia, não persiste nada, não precisa de banco.

Não há servidor de mídia, container, firewall de portas UDP nem certificado de
TURN embutido. Tudo isso saiu junto com o SFU (ADR 0005).

---

A plataforma recomendada é Cloudflare (Pages + Workers), pelos motivos
verificados na [ADR 0007](adr/0007-onde-hospedar.md). O servidor portátil
continua existindo e roda em qualquer lugar que rode Node — é a saída se a
cota apertar ou se você preferir outro provedor.

---

## Caminho recomendado — Cloudflare

Uma conta gratuita, sem cartão. Duas publicações.

### 1. Sinalização (Workers + Durable Objects)

```bash
pnpm release
```

Um comando: constrói o pacote compartilhado, o front e o Worker, confere que o
build corresponde ao HEAD e publica.

**Não use `pnpm deploy`** — `deploy` é comando EMBUTIDO do pnpm (copia um
pacote do workspace para uma pasta) e engole qualquer script com esse nome. O
deploy simplesmente não roda, e a mensagem de erro não diz isso.

O `wrangler.toml` já traz o binding do Durable Object e a migração
`new_sqlite_classes` — **obrigatória no plano gratuito**, porque Durable
Objects com backend key-value continuam sendo recurso pago.

Anote a URL que o deploy imprime (`https://tela.<conta>.workers.dev`). Ela é
o produto inteiro: o front sai dela, e o link que você manda para os amigos é
`https://tela.<conta>.workers.dev/seuslug`.

Para um link curto de verdade, aponte um domínio próprio para o Worker em
Workers → Custom Domains. É o único custo do projeto (~R$ 40/ano).

### 1b. Deploy automático a cada push (Workers Builds)

Se o repositório estiver conectado ao Cloudflare, o painel roda um build a cada
push na `main`. Ele precisa de **dois** comandos, e o padrão sugerido pelo
painel — `npx wrangler deploy` — falha por duas razões encadeadas.

Em **Workers & Pages → tela → Settings → Build**:

| Campo | Valor |
|---|---|
| Root directory | `/` |
| Build command | `pnpm run cf:build` |
| Deploy command | `pnpm run cf:deploy` |

**Por que o padrão não funciona.**

O primeiro erro é de localização:

```
✘ [ERROR] The Cloudflare application detection logic has been run in the root
  of a workspace instead of targeting a specific project.
```

`npx wrangler deploy` roda na raiz, vê `pnpm-workspace.yaml`, e se recusa a
adivinhar qual das aplicações publicar — corretamente, porque há duas.
`pnpm --filter @tela/signaling exec` resolve isso executando o wrangler já
dentro de `apps/signaling/`, que é o que `cf:deploy` faz.

O segundo erro apareceria logo depois, e é o pior dos dois: `wrangler.toml`
aponta `main` para `dist/worker-entry.js` e os assets para `../web/dist`, e
**nenhum dos dois existe num clone limpo**. Deploy sem build publica o vazio.
Por isso o campo de *build command* não pode ficar em branco — e por isso o
`[build]` do `wrangler.toml` roda `scripts/check-artifacts.mjs`, que falha com
uma mensagem dizendo qual comando falta em vez de um erro sobre arquivo
ausente.

`npx` também baixa a versão mais recente do wrangler a cada execução, ignorando
a que está no `pnpm-lock.yaml`. `pnpm exec` usa a do lockfile.

**Atenção:** com o deploy automático ligado, `pnpm release` na sua máquina e o
push para a `main` publicam no MESMO Worker. Não é erro, mas os dois correndo
juntos publicam versões diferentes — deixe um dos dois como o caminho oficial.

### 2. Front (Pages)

```bash
VITE_SIGNAL_URL=wss://tela.SUACONTA.workers.dev/signal \
  pnpm --filter @tela/web build
pnpm --filter @tela/web exec wrangler pages deploy dist --project-name tela
```

`apps/web/public/_redirects` já resolve o SPA fallback e
`apps/web/public/_headers` já manda o `Permissions-Policy` com
`display-capture=(self)` — sem ele, `getDisplayMedia` é bloqueado e o botão
TRANSMITIR não faz nada.

### 3. TURN — faça isto se o vídeo aparecer preto

Sem relay, um par atrás de NAT restritivo dos **dois** lados nunca fecha
conexão direta: o WebRTC troca SDP, monta tudo, e nenhum pacote atravessa. O
espectador vê tela preta enquanto quem transmite vê "AO VIVO". É a causa mais
comum de falha entre máquinas em redes diferentes.

**Cloudflare Realtime TURN** — 1.000 GB grátis por mês, e você já tem conta:

1. Dash → **Realtime** → **TURN** → criar uma chave
2. ```bash
   pnpm --filter @tela/signaling exec wrangler secret put TURN_KEY_ID
   pnpm --filter @tela/signaling exec wrangler secret put TURN_KEY_API_TOKEN
   pnpm release
   ```

O servidor passa a emitir credencial efêmera por espectador. O HUD mostra
quantos estão passando por relay — relay funciona, mas custa latência e cota,
então é bom saber.

Alternativa com coturn próprio: `wrangler secret put TURN_SECRET` e
descomente `TURN_URL` no `wrangler.toml`.

---

## Caminho portátil — qualquer host de Node

```bash
pnpm --filter @tela/shared build
pnpm --filter @tela/signaling build
node apps/signaling/dist/server.js
```

Serve para Koyeb, Railway, uma VPS ou a sua própria máquina. A única mudança
do lado do front é `VITE_SIGNAL_URL`.

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

### Saber o que está no ar

```bash
pnpm prod
# local : 57eb50a
# no ar : 57eb50a  (2026-08-23T22:27:29Z)
#   em dia.
```

Compara o commit publicado com o seu HEAD. Existe porque a pergunta "a versão
certa está no ar?" já foi respondida errado aqui: um build antigo ficou de pé
parecendo atual, e correções que já estavam no repositório não estavam na URL
sendo testada.

`pnpm release` também se recusa a publicar se `apps/web/dist` não corresponder
ao HEAD — `wrangler deploy` sozinho envia o que estiver na pasta, mesmo que
seja da semana passada, e isso não dá erro nenhum.

### Verificar

```bash
curl -s https://tela.SUACONTA.workers.dev/health
# {"ok":true}

# no servidor portátil o health também conta os canais abertos
curl -s http://127.0.0.1:3333/health
# {"ok":true,"channels":0}
```

Depois, com um amigo de verdade: abra `chrome://webrtc-internals` durante a
transmissão e veja qual par de candidatos ICE venceu. Se for `relay`, você
está passando por TURN — funciona, com latência a mais.

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
| Erro de cota no Worker | o free tier são 100k requisições/dia, e reseta 00:00 UTC (ADR 0007) |
| `wrangler deploy` reclama de Durable Object | falta a migração `new_sqlite_classes` — o backend key-value é pago |

Para medir latência glass-to-glass de verdade, veja a §18 da documentação
técnica — é medição humana, com câmera a 240fps. `RTCStats` mede rede, não
experiência.
