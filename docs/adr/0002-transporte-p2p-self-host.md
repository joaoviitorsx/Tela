# ADR 0002 — Transporte P2P para self-host na própria máquina

**Status:** aceita, e ampliada pela ADR 0005 · **Data:** 2026-08-23

> A 0005 promove o P2P de alternativa a único transporte. A análise abaixo
> (N encoders, N× upstream, CGNAT, TURN na cauda) continua válida na íntegra
> e passa a descrever o custo permanente do produto, não um modo opcional.
**Substitui parcialmente:** §12 da documentação técnica (que pressupõe VPS)

## Contexto

A §12 resolve self-hosting assumindo uma VPS em São Paulo. O critério de
escolha ali é **egress**, e a conclusão é o free tier da Oracle.

A objeção real não é custo — é **não ter onde hospedar**. Pedir a um gamer que
provisione Oracle Cloud, configure DNS, abra dois firewalls e suba quatro
containers para mostrar gameplay a cinco amigos é uma barreira que a maior
parte das pessoas não atravessa. O produto morre no funil, não na fatura.

A pergunta que esta ADR responde: **dá para o próprio PC do usuário ser o
servidor?**

## Decisão

Sim, com um segundo transporte. `TELA_TRANSPORT=p2p` troca o SFU por conexões
WebRTC diretas entre o browser do transmissor e o de cada espectador. O
componente central encolhe de "SFU + Redis + TURN" para **um hub de
sinalização que troca SDP e ICE e não vê um byte de mídia**.

Os dois modos coexistem atrás da mesma porta `MediaTransport` (AGENTS.md R2).
Nenhum caso de uso, nenhuma rota e nenhum tipo de domínio muda entre eles — a
escolha acontece só em `composition.ts` e na fábrica de transportes do web.

## O que P2P realmente elimina, e o que não elimina

**Elimina:** egress de servidor, CPU de encaminhamento, LiveKit, Redis, e a
necessidade de uma VPS. O hub cabe num Raspberry Pi e consome kilobytes por
sessão.

**Não elimina — e este é o ponto que costuma ser vendido errado:**

### 1. N encoders na máquina do transmissor

No browser, **cada `RTCPeerConnection` codifica por conta própria**. Anexar a
mesma `MediaStreamTrack` a três conexões roda três encoders 1080p60. Não existe
compartilhamento de encoder entre peer connections no Chromium.

É o mesmo argumento que a R5 usa para proibir três camadas de simulcast, agora
aplicado a espectadores — e o recurso em disputa é o mesmo: a CPU/GPU que o
jogo está usando.

### 2. N× o upstream, saindo do link de casa

O SFU replica no datacenter. Aqui a réplica sai da casa do usuário e disputa
banda com o netcode do próprio jogo. Saturar o upload não degrada só o vídeo:
enche o buffer do roteador e o ping do jogo sobe junto.

```
1080p60 = 8 Mbps por espectador
3 espectadores = 24 Mbps sustentados de UPLOAD
```

Muito plano de fibra brasileiro é assimétrico. 24 Mbps sustentados não são
dados para a maioria.

### 3. NAT e CGNAT

O IPv4 acabou e boa parte da banda larga residencial brasileira está atrás de
CGNAT: sem IP público, sem porta encaminhável. O furo de NAT via STUN resolve a
maioria dos casos (CGNAT costuma ter mapeamento independente de destino), mas
não todos — NAT simétrico dos dois lados não fura.

O fallback para esses casos é **TURN, que é um relay e carrega a mídia
inteira**. Ou seja: o remédio para o pior caso do P2P é exatamente o servidor
com egress que o P2P foi criado para evitar. Não existe topologia que sirva
100% dos usuários com zero infraestrutura. IPv6, onde os dois lados têm,
dispensa NAT e é o caminho mais rápido — o ICE já o prefere sozinho.

## Consequências aceitas

| Decisão | Valor | Por quê |
|---|---|---|
| Teto de espectadores em P2P | 3 (`P2P_MAX_VIEWERS`) | Acima disso são 4+ encoders 1080p60 concorrendo com o jogo |
| Simulcast em P2P | desligado | Uma conexão, um receptor: o congestion control dela já adapta o encoding àquele espectador |
| Store em memória | permitido | Um host doméstico é um usuário e um punhado de slugs; Redis seria cerimônia |
| Terceiro preset (720p60 eco) | adicionado | Em P2P o gargalo é upstream, e o usuário precisa de um degrau abaixo de 720p60 |

**Sobre o simulcast:** perder simulcast não recria o problema que a ADR 0001
resolve. Aquele problema era *um único stream compartilhado* sendo puxado para
baixo pelo pior receptor. Em malha, cada conexão tem um receptor só e adapta
sozinha — o amigo no 4G recebe menos sem estragar a imagem dos outros. Mesmo
resultado, outro caminho, custo diferente (N encoders em vez de 2).

## Alternativas rejeitadas

**SFU local na máquina do transmissor.** Resolveria os N encoders (2 camadas em
vez de N conexões), mas não resolve upstream — a réplica continua saindo da
mesma casa — e ainda exige porta de entrada alcançável, que é justamente o que
o CGNAT impede. Custo alto, resolve metade.

**Árvore de relay (espectador retransmite para espectador).** Manteria o
upstream do transmissor em 2×, mas adiciona 30–50ms por nível e faz a saída de
um espectador derrubar toda a subárvore. Para 3 a 5 amigos, complexidade e modo
de falha desproporcionais ao ganho.

**Túnel (Cloudflare Tunnel, Tailscale).** Cloudflare Tunnel no plano gratuito é
HTTP apenas — não passa mídia UDP. Tailscale funciona através de CGNAT, mas
exige que cada espectador instale e entre no tailnet, o que destrói o requisito
RF-04 ("abre o link e vê"). Ambos descartados.

## Como reverter

Trocar `TELA_TRANSPORT` de volta para `sfu` e subir LiveKit + Redis. Nenhum
código de domínio, aplicação ou UI muda — o adapter P2P pode ficar no
repositório sem custo. Essa reversibilidade é o motivo de a decisão ser barata.

## Não verificado por agente

Nada abaixo foi medido; tudo precisa de um humano com máquina, rede e amigos:

- latência glass-to-glass real do caminho P2P
- se o encode continua em hardware com 2 e 3 conexões simultâneas
- taxa de sucesso de ICE em CGNAT de operadora brasileira
- impacto real no FPS e no ping do jogo com 3 espectadores
- se o TURN é mesmo necessário para a cauda, e em que fração
