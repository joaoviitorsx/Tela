# Tela no Discord

Duas coisas, nenhuma delas é bot:

1. **Prévia do link com o estado.** Colar `https://tela.transmissao.workers.dev/joao`
   no Discord ou no WhatsApp mostra `joao · AO VIVO agora · 3 assistindo` ou
   `joao · fora do ar`. Já funciona depois do deploy, sem configurar nada.
2. **`/tela` no "+" → "Usar apps".** Um app do Discord instalado **no
   usuário**, que aparece em qualquer servidor, DM ou grupo. `/tela canal:joao`
   posta uma mensagem com o link, o estado e um botão **ASSISTIR**. Precisa do
   passo a passo abaixo, uma vez.

Nenhuma das duas lê mensagem, entra em call ou guarda coisa alguma (R6). O
Discord continua sendo onde se conversa; o Tela continua sendo só o cano de
vídeo.

O nome do canal tem de 3 a 25 caracteres (`SLUG_RE` em
`packages/shared/src/schemas.ts`). `jv` não é canal válido, nem no front: o
link `…/jv` abre a tela de "não encontrado".

---

## 1. Prévia do link

Código: `apps/signaling/src/previa.ts`. Quando um robô de prévia (Discordbot,
WhatsApp, Telegram, Twitter/X, Facebook/iMessage, Slack…) pede `/<slug>`, o
Worker pergunta ao Durable Object do canal se ele está no ar e quantos
assistem, e troca `og:title`, `og:description`, `twitter:*` e `<title>` do
`index.html` com `HTMLRewriter`. A imagem continua `/og-convite.png`.

- **Só robô.** Navegador de gente recebe o `index.html` de sempre, sem
  esperar pela consulta. Robô fora da lista recebe a prévia genérica.
- **Cache curto.** `Cache-Control: public, max-age=30` na página reescrita e
  30 s de memória por isolate na consulta (em `*.workers.dev` a Cache API não
  guarda nada). Colar o link em dez servidores não acorda o canal dez vezes.
- **Falha = página original.** Consulta que demora mais de 1,5 s, falha ou
  volta estranha devolve o HTML sem reescrita.
- **Nenhum dado de pessoa.** A consulta devolve `{ noAr, espectadores }` e
  nada mais (`ChannelRoom.estadoPublico`).
- O Discord guarda a prévia de cada URL por um tempo do lado dele. Uma prévia
  velha na conversa não se atualiza sozinha; uma colagem nova mais tarde, sim.

Para ver sem colar em lugar nenhum:

```bash
curl -s -A 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' \
  https://tela.transmissao.workers.dev/joao | grep -E 'og:title|<title>'
```

Requisito de configuração: `run_worker_first` no `wrangler.toml` faz o Worker
ver `/<slug>` antes dos assets. Arquivos (qualquer caminho com ponto),
`/assets/*`, `/`, `/transmitir` e `/recuperar` continuam indo direto aos
assets, fora da cota de requisições do Worker.

---

## 2. O app do Discord (`/tela`)

Código: `apps/signaling/src/discord.ts` (endpoint) e
`scripts/discord-registrar.mjs` (registro do comando).

O Discord manda cada uso do comando para `POST /discord/interactions`,
assinado com Ed25519. O Worker confere a assinatura com a chave pública do
app, pergunta o estado do canal e responde na mesma requisição. Sem a chave
configurada o endpoint responde 404: ele vem **desligado**.

### Passo a passo (uma vez)

1. **Criar o app.** <https://discord.com/developers/applications> → **New
   Application** → nome `Tela`. Ícone: `apps/web/public/tela-app-icon.svg`
   exportado em PNG 512×512.

2. **Copiar dois valores** em **General Information**:
   - **Application ID** (público)
   - **Public Key** (público, mas guardado como secret para não virar
     variável editada por engano)

3. **Configurar o Worker** (de `apps/signaling/`):

   ```bash
   pnpm --filter @tela/signaling exec wrangler secret put DISCORD_PUBLIC_KEY
   # cole a Public Key
   ```

   E no `apps/signaling/wrangler.toml`, descomente a linha em `[vars]`:

   ```toml
   DISCORD_APPLICATION_ID = "<seu Application ID>"
   ```

   Com ela, interação assinada de outro app é recusada. Publique: `pnpm
   release` (ou o push na `main`).

4. **Apontar o Discord para o Worker.** Ainda em **General Information**:
   **Interactions Endpoint URL** =
   `https://tela.transmissao.workers.dev/discord/interactions` → **Save**.
   O Discord manda um PING assinado e outro com assinatura errada antes de
   aceitar; se a chave do passo 3 não estiver no ar, ele recusa salvar. Esse
   é o teste de que o passo 3 deu certo.

5. **Instalação no usuário.** Em **Installation**:
   - **Installation Contexts**: marque **User Install** (pode deixar **Guild
     Install** também).
   - **Default Install Settings → User Install → Scopes**:
     `applications.commands`. Nenhum outro escopo, nenhuma permissão.
   - **Install Link**: `Discord Provided Link`.

   Em **Bot**, deixe **Public Bot** ligado se quiser que amigos instalem; o
   app não usa o bot para nada além de existir.

6. **Registrar o comando** (na sua máquina, uma vez; de novo só se o comando
   mudar). O token sai de **Bot → Reset Token**:

   ```bash
   DISCORD_APPLICATION_ID=<id> DISCORD_BOT_TOKEN=<token> node scripts/discord-registrar.mjs
   # registrado: /tela (id …)
   # Link de instalação: https://discord.com/oauth2/authorize?client_id=<id>
   ```

   **O token não vai para o repositório, nem para o Worker, nem para secret
   nenhum.** Ele só serve para este registro. Se vazar, faça **Reset Token** de
   novo; o endpoint não depende dele.

   Comando global pode levar alguns minutos para aparecer (até uma hora, pela
   documentação do Discord).

7. **Instalar e usar.** Abra o link de instalação → **Adicionar aos meus
   apps**. Em qualquer conversa: **+** → **Usar apps** → **Tela** → `/tela
   canal:joao`. O campo aceita o nome ou o link inteiro colado.

### O que o comando responde

| Situação | Resposta |
|---|---|
| canal no ar | pública: `**joao** · AO VIVO agora · 3 assistindo`, o link e o botão ASSISTIR |
| canal fora do ar | pública: `**joao** · fora do ar`, o link e o botão |
| estado indisponível | pública: o link e o botão, dizendo que não deu para ver o estado |
| nome inválido ou reservado | só para quem digitou: a regra do nome |
| sem `canal:` | só para quem digitou: como usar |

A mensagem pública suprime a prévia do link (o botão já leva ao canal) e não
marca ninguém (`allowed_mentions` vazio).

### Defesas do endpoint

- Assinatura Ed25519 sobre `timestamp + corpo`, com WebCrypto nativo do
  Workers. Falta de cabeçalho, assinatura malformada ou de outra chave: 401.
- Timestamp a mais de 5 minutos do relógio do Worker: 401 (reapresentação de
  interação capturada).
- Corpo acima de 32 KB: 413, antes de qualquer verificação.
- Só `POST`; o resto leva 405.
- Conteúdo de interação nunca vai para o log: ele carrega usuário, servidor e
  canal de quem digitou.

### Testar localmente

```bash
pnpm run cf:build
cd apps/signaling
pnpm exec wrangler dev --port 8799 --var DISCORD_PUBLIC_KEY:<hex de uma chave de teste>
```

Os testes (`src/discord.test.ts`) geram um par Ed25519 e assinam como o
Discord: assinatura válida, inválida, sem timestamp, PING, e o comando com
canal no ar, fora do ar e nome inválido.

---

## O que NÃO foi feito: Discord Activity

Uma **Activity** (o Tela rodando dentro do Discord, a transmissão aparecendo
na própria call) **não foi feita**, e não por limitação técnica. É decisão
pendente do dono: o produto existe porque o compartilhamento de tela do
Discord foi suspenso no Brasil por ordem da ANPD (17/08/2026), e levar a
transmissão para dentro do próprio Discord pode cair no mesmo escopo da
suspensão. Enquanto essa pergunta não tiver resposta, o Tela fica do lado de
fora: o Discord recebe um link e um estado, e o vídeo abre no navegador.
