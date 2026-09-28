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

### 1b. Deploy automático a cada push (GitHub Actions)

O caminho oficial. `.github/workflows/ci.yml` publica a `main` sozinho, mas só
depois que **tudo** passou: lint, typecheck, os 349 testes, build, ciclos de
dependência, as checagens de fronteira R1/R2/R8, e o servidor de sinalização
subindo de verdade e respondendo. Depois de publicar, ele confere o carimbo de
versão no ar — publicar sem conferir é publicar no escuro.

Precisa de dois secrets, uma vez:

```bash
# Cloudflare → My Profile → API Tokens → Create Token
#   template "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID   # 26fa849be82d2a2c4752a6d5241f26c6
```

**Sem eles o CI FALHA, de propósito.** Antes ele terminava verde sem publicar,
com o argumento de que um X vermelho permanente ensina a ignorar o vermelho. O
argumento é bom e a consequência foi pior: os secrets nunca foram configurados,
todo push passava verde sem publicar, e a produção ficou **dois commits atrás**
sem que nada em lugar nenhum reclamasse. Descobriu-se por acaso.

Verde tem que significar "está no ar".

### 1c. Desconecte o Workers Builds

Se o repositório estiver conectado ao build automático da Cloudflare
(**Workers & Pages → tela → Settings → Build**), **desconecte**. Dois caminhos
publicando no mesmo Worker se atropelam, e o do painel publica sem rodar teste
nenhum — o oposto da regra do projeto.

Ele também falha de saída, e vale saber por quê, porque a mesma armadilha pega
qualquer CI que rode `wrangler deploy` na raiz:

```
✘ [ERROR] The Cloudflare application detection logic has been run in the root
  of a workspace instead of targeting a specific project.
```

`npx wrangler deploy` na raiz vê `pnpm-workspace.yaml` e duas aplicações, e se
recusa a adivinhar qual publicar. Correto da parte dele. E logo depois viria o
erro pior: `wrangler.toml` aponta `main` para `dist/worker-entry.js` e os
assets para `../web/dist`, e **nenhum dos dois existe num clone limpo** — deploy
sem build publica o vazio.

Por isso o `[build]` do `wrangler.toml` roda `scripts/check-artifacts.mjs`:
qualquer `wrangler deploy` sem build agora falha dizendo qual comando falta, em
vez de um erro sobre arquivo de entrada ausente.

Se um dia você quiser o Workers Builds de volta, os campos são
`Build command: pnpm run cf:build` e `Deploy command: pnpm run cf:deploy` —
`cf:deploy` usa `pnpm --filter … exec`, que roda o wrangler já dentro de
`apps/signaling/` e com a versão do lockfile em vez da que o `npx` baixa.

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
configure `TURN_URLS` no `wrangler.toml` com URLs UDP, TCP e TLS realmente
oferecidas pelo seu servidor. `TURN_URL` singular continua aceito durante a
migração; definir ambos impede a inicialização.

O padrão `ICE_PROVIDER=auto` tenta Cloudflare e usa coturn configurado se a
emissão falhar. `ICE_PROVIDER=coturn` escolhe apenas coturn. Cada chamada à
Cloudflare tem prazo padrão de 2,5 s, no máximo uma repetição transitória e
orçamento total de até 5 s. `/health` mostra `iceConfig` sanitizado (provedor,
presença de configuração e contagens), sem chave ou credencial. Esse resumo
confirma configuração, não prova que o relay transporta mídia. Credenciais
incompletas aparecem como códigos fixos em `iceConfig.problems` e impedem
novas conexões no Durable Object; valide também o par de secrets antes do deploy.

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
| `ICE_PROVIDER` | `auto` (padrão) ou `coturn` no Node; Worker também aceita `cloudflare` |
| `TURN_URLS` | URLs TURN separadas por vírgula; `TURN_URL` singular é legado |
| `TURN_SECRET` | segredo compartilhado com o coturn — **prefira este** |
| `TURN_TTL_SECONDS` | validade da credencial efêmera (padrão 600) |
| `TURN_FETCH_TIMEOUT_MS` | prazo por chamada Cloudflare no Worker (padrão 2500 ms) |

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
