# D4 — Segundo plano

**Data:** 2026-10-02 · **Plano:** `PLANO-desktop.md` §3.1–3.4, §5, §11 · **Antes:** D1, D2, D8

Fechar a janela, esconder na bandeja, virar uma faixa por cima do jogo, abrir
com o sistema, dormir, cair. Tudo é política do **main**, que sabe da
transmissão uma coisa só — o `EstadoAoVivo` que a página conta — e a manda
parar pelo mesmo `stop()` de sempre. Nada de mídia no main (R8 em espírito),
nada de React no `core/` (R1), e a página nunca pergunta ao main "posso?":
ela obedece ordens validadas e informa.

```text
 renderer (a janela)                         main (quase ocioso)
 ───────────────────                         ───────────────────
 BroadcastSession (rota /transmitir)         estado = EstadoAoVivo (último válido)
   └─ registrada em sessaoAoVivo ──┐           ├─ Tray: tooltip + menu (só reescreve a mudança)
 MolduraDesktop (fora da rota)     │           ├─ 'close' da janela → decidirFechar()
   ├─ PainelNoAr / ModoCompacto ◄──┘           ├─ powerMonitor: suspend/resume
   ├─ DialogoFechar / DialogoAjustes           ├─ render-process-gone → página de queda
   └─ useSegundoPlano ── estadoAoVivo ──────►  └─ before-quit: para a sessão, depois sai
        ◄── parar · pedirEncerrar · perguntarFechar · modo
```

## 1. De onde a moldura enxerga a sessão

A `BroadcastSession` nasce na rota `/transmitir`; a moldura vive FORA da rota.
Sem tocar rotas nem `core/mesh`:

- o `createBroadcastSession` de `container.desktop.ts` cria a sessão e a
  **registra** em `sessao-ao-vivo.ts`. (Na primeira versão isso morava num
  container à parte, encadeado pelo plugin de troca; foi simplificado.)
- `sessao-ao-vivo.ts` (sem React, sem DOM) guarda as sessões registradas,
  repassa os avisos e marca o instante em que foi ao ar. A fonte da verdade
  continua sendo a sessão; a moldura só assina por `useSyncExternalStore`.
  O StrictMode cria duas sessões por montagem: vale a que está no ar, senão a
  mais recente; só as `ended` são esquecidas (uma `idle` pode ser a da rota).

> **Se o outro marco mexer em `container.desktop.ts`:** nada a fazer, o wrapper
> reexporta tudo. Se alguém importar `createBroadcastSession` direto de
> `container.desktop.js`, a moldura deixa de ver a sessão — por isso o
> redirecionamento do plugin aponta para o wrapper.

## 2. IPC (todo validado no main, funções puras com testes)

| Canal | Direção | Payload | Validação / efeito |
|---|---|---|---|
| `estadoAoVivo` | renderer → main | `{noAr, inicioMs, assistindo, capacidade, link}` | `estadoAoVivoValido`: tipos, inteiros 0–1000, link `http(s)` ≤ 2048 (só é copiado, nunca aberto). "Fora do ar" vira `FORA_DO_AR`. A página envia **≤ 1 Hz e só na mudança** (`criarEmissorDeEstado`); o primeiro "fora do ar" nem sai |
| `ajustes` / `salvarAjustes` | invoke | `{ajustes, bandeja, autostartFalhou}` | `mesclarAjustes`: campo a campo, tipo errado é ignorado |
| `pedirModo` / `modo` | renderer → main / main → renderer | `'normal' \| 'compacto'` | compacto só ao vivo; o main redimensiona e responde |
| `perguntarFechar` / `responderFechar` | main → renderer / renderer → main | `{acao, lembrar}` | só aceita resposta se há pergunta pendente; "cancelar" nunca é lembrado |
| `pedirEncerrar` | main → renderer | — | roda o fluxo de encerrar DA INTERFACE (com a confirmação de quem assiste) |
| `parar` / `paradaConcluida` | main → renderer / renderer → main | `'sair' \| 'suspensao'` | `stop()` da sessão e confirmação; o main espera até 4 s (`criarPortaoDeParada`) |

`ponte.ts` é o contrato; `preload.cts` expõe só operações nomeadas (o `modo`
guarda o último valor, porque chega antes de o React assinar).

## 3. Política de fechar (`politica-de-fechar.ts`)

| Situação | Decisão |
|---|---|
| Fora do ar | **sai** — ou **esconde**, se "fechar = segundo plano" estiver ligado E houver bandeja |
| Ao vivo, sem escolha lembrada | **pergunta** (diálogo do Tela na janela): *Continuar transmitindo em segundo plano?* — CONTINUAR NO AR (foco, saída segura) / ENCERRAR E SAIR / `Esc` cancela. "Lembrar minha escolha" grava em `userData/ajustes.json` |
| Ao vivo, lembrado "segundo plano" | **esconde** (bandeja) ou **compacto** (sem bandeja) |
| Ao vivo, lembrado "encerrar" | `stop()` e sai |
| Já no compacto | esconde (com bandeja) ou **minimiza** (sem) — nunca some sem controle |
| Sair (bandeja, Ctrl+Q, `app.quit()`) ao vivo | `before-quit` é adiado: página roda `stop()` (libera trilhas/peers e avisa a sala), confirma, e então o app sai; prazo de 4 s |

Esconder é `hide()` (a janela não é destruída), então o main avisa a visibilidade
e a página entra no modo escondido de sempre (§3.2).

## 4. Bandeja (`bandeja.ts`, `estado-ao-vivo.ts`)

- Ícone: `build/icon.png` redimensionado (24 px Linux, 32 px Windows) e pintado
  de âmbar monocromático (`monocromaAmbar`). Empacotado vai em `resources/icon.png`.
- Menu (modelo puro `modeloDoMenu`): estado em uma linha (`NO AR 00:42 · 3/50` /
  `Fora do ar`), **Copiar link**, **Mostrar/Esconder**, **Encerrar transmissão**
  (pede à página o fluxo dela, trazendo a janela para a pergunta ser vista),
  **Sair** (ao vivo: "Sair (encerra a transmissão)"). O menu só é reescrito
  quando o modelo muda; o tempo anda a cada 10 s enquanto ao vivo.
- **Linux sem AppIndicator:** o `Tray` do Electron não dá erro no GNOME do
  Fedora, só não aparece. O main pergunta ao barramento de sessão se
  `org.kde.StatusNotifierWatcher` tem dono (`dbus-send … NameHasOwner`, 1,5 s).
  Sem resposta ou sem `dbus-send`: **sem bandeja** — o app usa o compacto.
  `TELA_BANDEJA=0|1` força a resposta (e2e, quem sabe que a sonda erra).
- Aberto pelo autostart (`--oculto`) sem bandeja, a janela aparece normal.

## 5. Modo compacto, painel NO AR, ajustes

- **Compacto** = a mesma janela, 440×132, não redimensionável, `alwaysOnTop`
  opcional (`'floating'`). O main devolve a geometria anterior ao expandir.
  O tamanho é aplicado ANTES de travar o redimensionamento (vários WMs do Linux
  ignoram `setSize` em janela travada). A árvore das rotas **continua montada**,
  só `hidden` — desmontar a rota derrubaria a sessão. O compacto conta como
  "oculto" para a visibilidade (`fonteDeVisibilidadeDesktop` com o `modo`): o
  mesmo modo escondido, sem segundo caminho. ENCERRAR no compacto pergunta
  inline (a janela é pequena demais para diálogo). Acabou a transmissão → volta
  ao normal sozinho.
- **Painel NO AR** (`PainelNoAr.tsx`): LED, tempo, `n/N`, rota (direta / TURN /
  mista), encoder (`nativo·NVENC`, `WebCodecs·hardware`… como o transporte
  reporta), COMPACTAR e ENCERRAR (mesmo `DialogoConfirmar` e `useEncerrar` da
  rota). Mesma fonte da bandeja. O tempo só tica com a janela visível.
- **AJUSTES** (engrenagem no pé do trilho, nunca travado ao vivo): iniciar com o
  sistema, fechar = segundo plano, compacto sempre no topo; cada caixa grava na
  hora e mostra o que o main DEVOLVEU (autostart que falha volta desmarcado, com
  aviso). Sem bandeja, "fechar = segundo plano" fica desabilitado e explica.

## 6. Autostart, suspensão, queda, atalho

- **Autostart.** Windows: `app.setLoginItemSettings({openAtLogin, args:['--oculto']})`.
  Linux: `~/.config/autostart/tela.desktop` (`$XDG_CONFIG_HOME`; `$APPIMAGE` no
  lugar do ponto de montagem), `Exec=… --oculto`, com quoting da especificação.
  Abre escondido na bandeja e **nunca captura** (captura é sempre um clique).
  `TELA_USERDATA` põe `userData` E a pasta de autostart numa pasta temporária,
  e no Windows pula o registro: o e2e nunca toca o autostart real. No Linux
  fora do pacote o autostart só é gravado com essas variáveis (o executável
  seria o do Electron solto).
- **Suspensão.** `powerMonitor 'suspend'` ao vivo → `parar('suspensao')`: a página
  encerra a sessão e mostra *"A transmissão foi encerrada porque o computador
  entrou em suspensão."* até ser dispensada. Em `resume` o main repete a ordem
  (a página pode ter congelado antes de ouvir), mata o `tela-captura` e deixa o
  aviso à vista. O Electron não permite segurar a suspensão; o aviso é o
  melhor possível.
- **Queda do renderer.** `render-process-gone` (exceto `clean-exit`): mata o
  `tela-captura`, zera o estado, e recarrega em `?queda=<motivo>` (só se estava
  no ar — ocioso recarrega a home). A página mostra **A TRANSMISSÃO CAIU** com o
  motivo e um **VOLTAR AO INÍCIO**; nunca finge continuidade. Três quedas em 30
  s: não recarrega mais (laço).
- **Atalho global: adiado.** `globalShortcut` não é trivial de entregar certo: no
  Wayland não funciona sem o portal `org.freedesktop.portal.GlobalShortcuts` (o
  compositor decide quem recebe teclas), então seria uma promessa que só vale
  no Windows/Xorg. Fica para depois de medir a demanda; a bandeja cobre o caso.

## 7. O que foi verificado e o que precisa de gente

**Verificado (máquina de desenvolvimento, Fedora, sem tela útil):** testes
unitários dos módulos puros do main e dos componentes/hooks da moldura;
`e2e/desktop.e2e.mjs` e `e2e/desktop-ao-vivo.e2e.mjs` rodados com o Electron
em modo `--ozone-platform=headless` e `BANDEJA=0` (a bandeja derruba o GTK sem
display): ajustes e autostart na pasta temporária, validação do IPC, painel
NO AR, compacto (440×132, não redimensionável, rota montada, EXPANDIR devolve
960×600), confirmação do "Encerrar" da bandeja, fechar ao vivo (pergunta, `Esc`,
lembrar, sem bandeja vira compacto), suspensão com o motivo e **sair ao vivo**
(o espectador vê "transmissão encerrada" e o app fecha em ~100 ms). Falhas
restantes desse ambiente, fora do D4: WebGL ausente (`cena cancelada` na cena
3D) e o servidor de sinalização/CSP do build usado.

**Precisa de validação humana** (nada disso se prova sem bandeja e sem
compositor de verdade):

1. **Windows, bandeja.** Ícone âmbar legível em tema claro e escuro; clique
   esquerdo alterna a janela; menu (estado, Copiar link cola o link certo,
   Mostrar/Esconder, Encerrar abre a confirmação com a janela na frente, Sair).
   Fechar ao vivo → pergunta → "continuar" → janela some e o amigo continua
   vendo; tooltip com o tempo.
2. **GNOME sem AppIndicator** (Fedora de fábrica). Confirmar que a sonda dá
   "sem bandeja" (AJUSTES explica; o diálogo de fechar fala em "faixa
   compacta"), que fechar ao vivo vira o compacto, que fechar o compacto
   minimiza (continua no Alt-Tab/Atividades) e que ENCERRAR do compacto encerra.
   Depois instalar a extensão AppIndicator, reiniciar o app e ver o ícone.
3. **KDE e XFCE.** Ícone aparece, menu funciona, Mostrar/Esconder em Wayland.
4. **Compacto sempre no topo** sobre um jogo em janela e em borderless; em
   tela cheia exclusiva nada fica por cima (limitação do sistema). No Wayland
   o compositor pode ignorar `alwaysOnTop`.
5. **Autostart.** Windows: ligar em AJUSTES, reiniciar a sessão, o app sobe só
   na bandeja, sem janela e SEM pedir captura; desligar remove a entrada
   (Gerenciador de Tarefas → Inicializar). Linux: ligar, conferir
   `~/.config/autostart/tela.desktop` (Exec com `--oculto`; AppImage com o
   caminho do `.AppImage`), relogar; desligar remove o arquivo.
6. **Suspensão.** Ao vivo com um amigo assistindo, suspender e acordar: a
   transmissão acabou, o aviso de suspensão está à vista, o amigo vê "encerrada".
   Testar suspender com o app escondido na bandeja.
7. **Sair ao vivo** pela bandeja, por Ctrl+Q e pelo fechar do sistema/logoff:
   o amigo vê o fim e o `tela-captura` não fica órfão (`pgrep tela-captura`).
8. **Queda do renderer.** `kill -9` no processo renderer (`ps` → o filho do
   Electron com `--type=renderer`) ao vivo: a janela volta com "A TRANSMISSÃO
   CAIU", o `tela-captura` morre, VOLTAR AO INÍCIO funciona.

## 8. Decisões e dúvidas

- **Wrapper de container em vez de editar `container.desktop.ts`** (§1): pedido
  explícito de não tocar o arquivo. Custo: um redirecionamento a mais no plugin.
- **"Fechar o compacto" não encerra:** minimiza/esconde. Encerrar é sempre um
  ato explícito (ENCERRAR).
- **Link do estado aceita `http:`** além de `https:`: só é copiado, e o build de
  desenvolvimento aponta para `http://localhost`.
- **Suspensão usa `USER_STOPPED` na sessão** + aviso na moldura, porque
  `BroadcastFailure` não tem "suspensão" e a tela de fim da rota (que não
  alterei) mostra "Transmissão encerrada". O motivo explícito vive no aviso.
- **A prévia do app na web (`use-previa-app.ts`) lista "INICIAR COM O SISTEMA —
  Planejado" na home mesmo dentro do app.** Agora que a opção existe de verdade
  em AJUSTES, essa linha da home do app é redundante e confusa; a rota está
  fora do escopo deste marco. Recomendo esconder a prévia quando `ofereceApp`
  for falso.
- Dúvida: o D-Bus `NameHasOwner` pode dar falso negativo em sandbox
  (Flatpak/Snap); o app então cai no compacto, que é o lado seguro.

## 9. Moldura própria e o fechar

O botão Fechar da barra da janela (Linux) e o fechar nativo (X do Windows, Alt+F4,
`win.close()`) terminam no mesmo `close` da `BrowserWindow`, logo na mesma
`decidirFechar` da §3. Detalhes da moldura em `PLANO-desktop.md` §11.1.
