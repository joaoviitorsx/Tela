# tela

Transmissão de gameplay em 1080p60 com latência sub-segundo, direto do seu
browser para o dos seus amigos. Sem cadastro, sem servidor de mídia, sem custo.

Você aperta um botão, ganha um link, manda pros amigos. Eles abrem e veem seu
jogo. Nada mais.

---

## O problema

Em 17 de agosto de 2026 a ANPD determinou a suspensão do compartilhamento de
tela do Discord no Brasil. A medida foi cirúrgica: atingiu a transmissão de
vídeo ao vivo, e não texto nem voz.

O caso de uso "mostrar meu gameplay pros amigos enquanto a gente conversa"
ficou órfão. As alternativas não servem: Twitch e YouTube têm 3 a 15 segundos
de atraso, o que mata a interação; Meet e Jitsi têm UX de reunião corporativa;
Parsec é controle remoto, não audiência.

**Este produto é um cano de vídeo, e recusa ser qualquer outra coisa.** Seus
amigos já estão numa call conversando — o Discord continua funcionando para
isso. Não há chat, voz, contas, gravação, diretório ou seguidores aqui, e não
vai haver.

---

## Arquitetura

```
┌──────────────────────────────────────────────────┐
│  Front estático  ·  Cloudflare Pages (grátis)    │
│  React + core/ (portável) + adapters/mesh        │
└──────────────────┬───────────────────────────────┘
                   │ WebSocket — só SDP e ICE, nunca mídia
                   ▼
┌──────────────────────────────────────────────────┐
│  Signaling  ·  Durable Objects (grátis)          │
│  um objeto por slug, relay de payload OPACO      │
│  hiberna com os sockets abertos → custo zero     │
└──────────────────────────────────────────────────┘

     STUN público   ·   TURN só para a cauda (CGNAT)

  Transmissor ──┬──► Espectador 1     RTCPeerConnection direta
                ├──► Espectador 2     a mídia NUNCA toca servidor
                └──► Espectador 3
```

**A invariante que define o sistema:** o servidor de sinalização não vê um byte
de mídia. Ele repassa `payload` opaco e nunca olha dentro — é regra de lint, não
de honra: ler `.sdp` em `apps/signaling/` quebra o build.

Consequência observável: **se o signaling cair no meio de uma transmissão, as
conexões já estabelecidas continuam funcionando.** Só espectadores novos não
entram. O servidor não está no caminho da mídia, então não está no caminho da
falha.

### O seam, e a prova de que ele funciona

`core/media/` fala com uma interface, `MediaTransport`. Nada nele sabe se por
baixo existe um SFU, uma malha P2P ou um app nativo.

Isso não é aspiração de design — foi testado no pior jeito possível. O projeto
nasceu com um SFU (LiveKit) e depois trocou o transporte inteiro por mesh P2P.
`BroadcastSession` e `ViewerSession` mantiveram a máquina de estados, as regras
de mídia, a degradação por CPU e a lógica de reconexão. Mudou quem implementa a
porta, não quem a usa. A implementação antiga está preservada em
`adapters/_reference/` para quem quiser comparar as duas topologias lado a lado.

---

## As decisões contraintuitivas

Três escolhas que parecem erradas até você saber por quê. Todas com o motivo
escrito no código, porque daqui a seis meses ninguém lembra.

**1. Todos os peers recebem parâmetros de encoding IDÊNTICOS.**

O instinto é adaptar por espectador: quem tem rede ruim recebe menos. Mas o
Chrome reaproveita o mesmo encoder entre `RTCRtpSender`s cujos parâmetros
batem — um encode, três envios. Variar por peer viram três encoders 1080p60
disputando a GPU com o jogo.

Então a adaptação é **coletiva**: ou o espectador aguenta o que está sendo
enviado, ou todos descem juntos um degrau. Está em `core/mesh/mesh-topology.ts`,
com teste que falha se alguém "otimizar".

**2. `track.contentHint = 'motion'`.**

Uma linha. Sem ela, o Chrome trata captura de tela como `detail`, preserva
nitidez e derruba o framerate — porque assume que você está mostrando um
documento. Gameplay a 15fps nítido é inútil. Essa linha decide se o produto
presta.

O botão de **nitidez** troca essa linha por `detail` de propósito, junto com
30fps e `maintain-resolution` — os três, ou nenhum. Serve para quando o
detalhe É a informação: um mapa, um inventário, texto. A 30fps o mesmo
orçamento paga o dobro de bits por pixel, então cabe uma resolução maior sem
um bit a mais de upload.

**3. H.264, não VP9 nem AV1.**

Comprimem melhor. Também consomem, em software, exatamente a CPU que o jogo
precisa. H.264 tem encode em hardware em qualquer GPU dos últimos doze anos.

Bônus: a degradação automática por CPU anda só entre presets de 60fps.
`720p30` existe, mas tem a mesma resolução do `720p60 econômico` — descer até
ele sob pressão de CPU cortaria framerate sem aliviar o encoder. Ele é degrau
de **upload**, não de CPU.

---

## Limitações declaradas

Estas são consequências da arquitetura, não bugs a corrigir depois:

- **Teto de 3 espectadores.** Cada um é uma cópia do seu upload saindo de casa
  e uma conexão a mais para negociar. Acima disso o jogo sente.
- **Seu upload é o gargalo.** 1080p60 são ~8 Mbps por espectador. Um link
  assimétrico de 30 Mbps comporta dois, não três.
- **~15–20% das conexões precisam de TURN.** CGNAT simétrico não fura, e o
  remédio é um relay de terceiro com cota. É o preço honesto de "sem
  servidor" — não existe topologia que sirva 100% dos usuários com zero
  infraestrutura.
- **O slug não é permanente.** O signaling não persiste nada. Seu link fica
  reservado enquanto você transmite, mais 5 minutos de carência para
  reconexão. Reiniciar o processo limpa tudo.
- **Cota diária no free tier.** 100.000 requisições/dia no Worker. Uma
  transmissão gasta dezenas de mensagens de sinalização, não milhares — mas o
  teto existe, e estourar dá erro claro, não degradação silenciosa.
- **Nada foi medido em hardware real.** Latência glass-to-glass, encode em
  hardware e impacto no FPS do jogo exigem uma pessoa com máquina, rede e
  amigos. O roteiro está na §18 da documentação técnica.

---

## Não atrapalhar o jogo

É o requisito central, e o produto trabalha em quatro frentes para cumpri-lo:

**Teto de banda com folga.** O WebRTC estima quanto cabe no link e sobe até
lá — e "até lá" é exatamente onde a fila do roteador enche e o ping do jogo
dispara. O encoder é limitado a 75% do estimado, antes disso acontecer.

E o orçamento escolhe a RESOLUÇÃO, não só o bitrate. É a diferença entre
480p60 nítido e 1080p60 borrado com os mesmos 3 Mbps — apertar bits sem tirar
pixel só sobe o QP, e o navegador acaba derrubando a resolução sozinho, sem
avisar ninguém.

Na outra ponta, banda de sobra vira imagem em vez de sobrar: quem tem link
para 25 Mbps por espectador recebe 25, e não os 12 do rótulo. O console mostra
os bits por pixel — abaixo de 0,10 a imagem borra, e 0,20 é onde o bit deixa
de virar nitidez.

**Prioridade de rede.** O vídeo é marcado como tráfego sacrificável (DSCP
baixo) e o áudio como prioritário. Roteador com fila consciente (fq_codel,
CAKE) deixa o jogo passar na frente; onde ninguém honra, é inerte.

**Tela inteira é o caminho principal.** O seletor já abre nela, e a captura
pede `crop-and-scale` para o navegador reduzir a resolução dentro do pipeline,
normalmente na GPU — sem isso, um monitor 1440p ou 4K entrega quadros em
resolução nativa e o redimensionamento vira trabalho extra 60 vezes por
segundo, na mesma máquina que roda o jogo.

**Captura ociosa a 5fps.** Sem espectador não há encoder rodando, mas a
captura de tela continua — e a 1080p60 ela custa GPU e compositor por nada.
Volta ao framerate cheio quando alguém entra.

**Aba escondida não faz rede.** Quem deixa a página do espectador aberta e vai
jogar não recebe nem uma conexão. Medido: 4 conexões em 45s com a aba visível,
**zero** com ela escondida.

E a degradação automática reage tanto a CPU quanto a **banda** — quando o
WebRTC diz que a rede é o limitador, o preset desce sozinho.

## Áudio do jogo — o que muda entre sistemas

Seus amigos precisam **ouvir** o gameplay, e é aqui que Windows e Linux
divergem de verdade.

| Sistema | Como funciona | O que você faz |
|---|---|---|
| **Windows** | O Chrome entrega o áudio junto com a tela | No picker: escolha **"Tela inteira"** e marque **"Compartilhar áudio do sistema"** |
| **Linux** | O Chrome **não** entrega áudio do sistema, só de aba | `bash scripts/audio-linux.sh`, mande o jogo para "TelaCapture" no pavucontrol, e escolha o monitor na tela inicial |
| **macOS** | Exige driver de terceiro (BlackHole, Loopback) | Fora do escopo — a tela inicial avisa em vez de prometer |

A tela inicial detecta o sistema e mostra a instrução certa, com o comando
pronto para copiar no Linux. Áudio de jogo vai a 128 kbps, e DTX e RED ficam
desligados de propósito: DTX corta o que ele acha que é silêncio e vira
gaguejo; RED manda redundância, e redundância custa latência.

## Rodar

```bash
pnpm install
pnpm dev     # signaling :3333 + web :5173
```

Não há Docker, banco nem servidor de mídia.

```bash
pnpm turbo lint typecheck test build   # tem que passar antes de qualquer entrega
pnpm depcruise                         # ciclos de dependência
```

272 testes, todos sem browser e sem rede: a lógica de mídia vive em classes
puras com `RTCPeerConnection` injetada, então a negociação inteira é
exercitável em milissegundos.

O servidor tem duas implementações — Node portátil e Durable Object — porque
sob hibernação o modelo de estado é genuinamente diferente. Uma bateria de
conformidade roda as mesmas expectativas contra as duas — incluindo o ciclo de
hibernação, que é o motivo de a segunda existir e o caminho onde um estranho
já conseguiu assumir um canal ao vivo.

---

## Dados pessoais

| Dado | Coletado? |
|---|---|
| Nome, e-mail, telefone, senha | Não |
| Cookie de rastreamento, analytics | Não |
| Gravação de vídeo ou áudio | Não |
| Vídeo passando por servidor nosso | Não — é P2P |
| Slug e hash do ownerToken | Em memória, enquanto o canal existe |

Não há login. Um token de 32 bytes no `localStorage` **é** a credencial —
trade-off consciente, com página de exportação em `/recuperar`.

---

## Documentação

| Arquivo | Quando ler |
|---|---|
| [`AGENTS.md`](AGENTS.md) | As oito regras inegociáveis |
| [`docs/adr/`](docs/adr/) | Por que as decisões são o que são |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Subir o front e o signaling |
| [`docs/adr/0007`](docs/adr/0007-onde-hospedar.md) | Por que Cloudflare, e o que foi descartado |
| [`docs/TELA-changeset-mesh.md`](docs/TELA-changeset-mesh.md) | A mudança de SFU para mesh |
| [`docs/adr/0015`](docs/adr/0015-o-teto-de-upload-escolhe-o-degrau.md) | Por que a imagem borrava, e o que decide a qualidade agora |
| [`docs/adr/0016`](docs/adr/0016-perfil-h264-nivel-e-jitter-buffer.md) | Perfil H.264, nível anunciado e jitter buffer |
| [`docs/adr/0017`](docs/adr/0017-o-governador-mede-orcamento-nao-teto.md) | Por que 800 Mbps de subida entregavam 12, e o que mudou |

Comece pela [ADR 0005](docs/adr/0005-mesh-p2p.md) se quiser entender a
arquitetura atual, e pela [0002](docs/adr/0002-transporte-p2p-self-host.md) se
quiser a análise de por que P2P não é mágica.
