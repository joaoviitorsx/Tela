# D8 — Assistir no app e abrir pelo link

**Data:** 2026-10-02 · **Plano:** `PLANO-desktop.md` §3.3–3.4, §11, §14 · **Antes:** D1 (ponte, `app://`), D2

Dois caminhos que terminam na MESMA rota, `/<canal>` (o `Viewer` da web, a
`ViewerSession` de sempre, nenhuma linha de mídia nova — R1/R2/R3):

```text
 dentro do app                                   no navegador
 ─────────────                                   ────────────
 ASSISTIR (trilho) → cola link/nome              tela.gg/<canal> abre
   canalDaEntrada() ─────────┐                     │ Windows/Linux, fora do app,
 tela://assistir/<canal>     ▼                     │ sem `tela.semApp`, com foco
   main valida → IPC     /<canal>  (sem recarregar)▼
   tela:abrir-canal ──→ useCanalPorLink       tenta tela://assistir/<canal> (≤ 1,5 s)
                         (ao vivo? não navega)   abriu → "ABERTO NO APP"  (sem conectar)
                                                 não   → grava tela.semApp, conecta
```

## 1. Link profundo `tela://assistir/<canal>` (main)

| Peça | Onde |
|---|---|
| Validação pura | `apps/desktop/src/main/link-profundo.ts` (+ testes) |
| Registro, entrega, fila de link a frio | `apps/desktop/src/main/main.ts` |
| Fila até o React assinar | `apps/desktop/src/preload/preload.cts` |
| Esquema no instalador | `apps/desktop/electron-builder.yml` (`protocols`) |

**Forma aceita, só esta:** `tela://assistir/<slug>`. Esquema e "host" sem
distinção de caixa (o Windows/Chromium normalizam), barra final opcional (o
Chromium a acrescenta), consulta e fragmento descartados. Recusa: outro host,
outro caminho, segmento extra, usuário/porta, `%`, espaço, controle, mais de
256 caracteres, slug fora do `SLUG_RE` do roteador (cópia comentada, aponta
para `apps/web/src/router.ts`) e os nomes de rota `transmitir`/`recuperar`.

**Três entradas, um caminho (`abrirCanal`):**

- primeiro lançamento: `process.argv` (depois do `ready`; o canal espera o
  `did-finish-load` e vai na fila do preload se o React ainda não assinou);
- `second-instance` (Windows/Linux): o `argv` da segunda instância; o lock de
  instância única já existia;
- `open-url` (macOS, sem alvo de build hoje; barato e correto de ter).

`canalDoArgv` procura o primeiro argumento que declara `tela:` em qualquer
posição, tira aspas, e o valida. Cobre `Tela.exe -- "tela://…"` (Windows,
registro do Chromium), `tela tela://…` (Linux, `%U`) e `electron . tela://…`
(dev). Se o primeiro link do argv for inválido o resultado é nulo: não se
procura um "mais bonzinho" depois de um suspeito.

**O link NUNCA inicia captura nem transmissão.** O main só traz a janela e
manda o slug; a página só navega para a rota do espectador.

**Ao vivo:** o main não sabe (a transmissão vive no renderer). Quem decide é
`useCanalPorLink`: com `location.pathname === '/transmitir'` não navega e mostra
"Você está ao vivo — abra o canal depois de encerrar a transmissão", um aviso
sem bloqueio que some em 8 s ou no ×.

### IPC acrescentado

| Canal | Direção | Payload |
|---|---|---|
| `tela:abrir-canal` | main → renderer | `string` (slug já validado; a página valida de novo) |

Ponte: `aoAbrirCanal(ouvinte): () => void` (`ponte.ts`, `preload.cts`, espelhados).

### Registro do esquema no sistema

`app.setAsDefaultProtocolClient('tela')`; em dev (`process.defaultApp`) com
`[process.execPath, [caminhoDoApp]]`, como manda a documentação do Electron.
**Decisão:** só o app EMPACOTADO registra por padrão (`deveRegistrarEsquema`).
Registrar muda o handler padrão da máquina (`xdg-settings` no Linux, registro
no Windows): rodar `electron .` ou o e2e na máquina de quem tem o app instalado
roubaria o `tela://` dele. `TELA_REGISTRAR_ESQUEMA=1` força (para testar o
link real em dev), `0` proíbe (os e2e usam).

**Empacotamento:** `protocols: [{ name: Tela, schemes: [tela] }]`. NSIS grava o
esquema no registro. Linux deb/rpm: o electron-builder lê `protocols` e escreve
`MimeType=x-scheme-handler/tela;` no `.desktop` e acrescenta `%U` ao `Exec`
(conferido em `app-builder-lib/out/targets/LinuxTargetHelper.js`), então
`linux.mimeTypes` não é necessário. AppImage não instala nada: o esquema só
existe com integração (AppImageLauncher) — sem ela cai no navegador, que é o
comportamento previsto.

## 2. ASSISTIR no app (renderer)

- Trilho: **TRANSMITIR · ASSISTIR · CANAL** (`TrilhoDesktop.tsx`). ASSISTIR
  não é rota: abre `DialogoAssistir` (`<dialog>` nativo, foco preso, `Esc`).
  Fica aceso enquanto a rota é a de um canal (`itemAtivo`). Trava junto com os
  outros ao vivo (regra existente).
- `core/domain/entrada-de-canal.ts` (`canalDaEntrada`, `Result`): aceita
  `https://<qualquer origem>/<slug>`, `tela.gg/<slug>`, `tela://assistir/<slug>`
  e o nome. Só lê o nome — o host colado não é conferido nem usado: o app navega
  para a rota interna. Reusa `parseSlug`.
- Tela cheia e teclado: o `Viewer` já tem `F`/duplo clique (`requestFullscreen`
  do palco) e `Esc` sai (nativo do Chromium). No Electron isso depende de
  `fullscreenable` (agora explícito no `BrowserWindow`) e da permissão
  `fullscreen`, já concedida em `seguranca.ts`. Nada mudou no `Viewer` para isso.

## 3. "Abrir no app" na página do canal (web)

| Camada | Peça |
|---|---|
| `core/domain/abrir-no-app.ts` | `haAppParaEsteNavegador`, `decidirTentativa`, `ofereceAbrirNoApp`, constantes (`PRAZO_DA_TENTATIVA_MS = 1500`, `tela.semApp`) |
| `core/ports/abrir-no-app.ts` | `AbrirNoApp` (`ambiente()`, `tentar(slug)`), `MarcaSemApp` |
| `adapters/abrir-no-app.ts` | iframe escondido + `blur`/`visibilitychange` + prazo |
| `react/use-abrir-no-app.ts` | máquina `tentando → no-app \| navegador`, uma tentativa só |
| `components/AbertoNoApp.tsx` | estados `ABRINDO NO APP…` e `ABERTO NO APP` (burro) |
| `components/BarraEspectador.tsx` | botão discreto ABRIR NO APP (`! SEM APP` se falhou) |
| `container.ts` | `abrirNoApp`, `semAppMarca` (`tela.semApp` no `localStorage`) |

**Quando tenta (todas):** Windows ou Linux de mesa; não celular, não Safari, não
Mac/ChromeOS; `window.telaDesktop` ausente; sem `tela.semApp`; `document.hasFocus()`;
`navigator.webdriver` falso (Playwright não paga 1,5 s nem tem o app — protege as
medições dos e2e). Qualquer outra combinação: a fase já nasce `navegador` no
primeiro render — **zero atraso** para esses casos.

**O que faz:** cria um `<iframe hidden src="tela://assistir/<canal>">`, ouve
`blur` da janela e `visibilitychange→hidden` por até 1,5 s.

- perdeu o foco antes do prazo → `abriu` → tela **ABERTO NO APP**; a
  `ViewerSession` NÃO abre (mesma pessoa não ocupa duas vagas). Botão
  CONTINUAR NO NAVEGADOR conecta aqui e grava `tela.semApp`.
- sem sinal em 1,5 s → `nao-abriu` → grava `tela.semApp=1` e conecta normalmente.

**Custo para quem usa só o navegador:** a primeira abertura de canal num
Windows/Linux sem o app espera ≤ 1,5 s antes de conectar; da segunda em diante
a marca elimina a espera, e fora de Windows/Linux (celular, Mac, Safari) ou em
navegador automatizado não há espera nenhuma. Verificado por teste: nesses
casos `tentar` nunca é chamado e a fase é `navegador` no primeiro render. O
tempo até o primeiro quadro NÃO foi medido num navegador real (sem rede/GPU
aqui): é item de validação humana (§6).

**Botão ABRIR NO APP:** sempre presente na barra do espectador onde existe app
(Windows/Linux, fora do app). Limpa `tela.semApp`, tenta de novo SEM derrubar a
sessão da web; se abrir, a sessão da web fecha (`no-app`); se não, o botão vira
`! SEM APP` e a marca volta.

### Comportamento por navegador (expectativa; não testado em navegador real)

| Navegador | Com o app registrado | Sem o app |
|---|---|---|
| Chrome / Edge / Brave (Win, Linux) | Pergunta "Abrir Tela?" (uma vez, com "sempre"); a página recebe `blur` → `abriu`. Com "sempre" o app abre direto. Risco: Chrome pode recusar lançar esquema de iframe sem gesto do usuário → "não abriu", cai no navegador e o botão manual (com gesto) funciona | Nada acontece; 1,5 s; navegador |
| Firefox (Win, Linux) | Mostra a escolha de aplicativo / abre; `blur` → `abriu` | Esquema desconhecido no iframe é silencioso (a página não navega); 1,5 s; navegador |
| Safari, qualquer celular | Não tenta (sem app / alerta que prende a página) | — |
| Dentro do app | Não tenta | — |

Falso positivo conhecido: quem cancela o diálogo "Abrir Tela?" já gerou o
`blur`; vê ABERTO NO APP e usa CONTINUAR NO NAVEGADOR. Falso negativo: app lento
(> 1,5 s para pegar o foco) → segue no navegador e grava `tela.semApp`; o botão
manual desfaz.

## 4. Segurança

- O payload do main é revalidado na página; a página nunca confia na ponte para
  navegar (`canalDaEntrada` exige `value === slug`).
- Windows: um `tela://x" --flag` malicioso pode injetar argumentos NA linha de
  comando antes do app existir; isso é do Chromium/Electron e do registro, não da
  validação daqui (que rejeita espaço). Manter o Electron atualizado.
- O link nunca dispara captura; `getDisplayMedia` continua exigindo gesto e o
  seletor do app.

## 5. Testes

- main: `link-profundo.test.ts` (forma, argv Windows `--`/aspas, Linux, dev,
  suspeito antes de bom, registro).
- web: `entrada-de-canal`, `abrir-no-app` (decisão por UA/foco/automação),
  adapter (iframe, blur, visibilidade, prazo — happy-dom, timers falsos),
  `use-abrir-no-app` (uma tentativa mesmo no StrictMode, fase inicial síncrona,
  manual, desmontar), `use-canal-por-link` (revalida, ao vivo não navega, aviso
  some), `use-assistir`, `DialogoAssistir`, `AbertoNoApp`, trilho/`itemAtivo`.
- e2e (`e2e/desktop.e2e.mjs`, 2b/2c): ASSISTIR cola link e abre `/maria` sem
  recarregar e acende; `app.emit('second-instance', …)` com `-- "tela://…"` leva a
  `/joao`; link malformado é ignorado. `e2e/desktop-ao-vivo.e2e.mjs` (1b): o
  mesmo evento ao vivo NÃO sai de `/transmitir` e mostra o aviso. Ambos usam
  `TELA_REGISTRAR_ESQUEMA=0`. **Não rodados pelo autor** (abrem janela).

## 6. O que só humano verifica (app instalado)

1. **Windows, NSIS instalado:** `Win+R` → `tela://assistir/<canal>` abre o app no
   canal; com o app já aberto, só foca e navega (sem segunda janela).
2. **Windows, Chrome e Edge e Firefox:** abrir `https://<site>/<canal>` com o app
   instalado: pergunta, abre, a página diz ABERTO NO APP e NÃO aparece espectador
   extra no contador do transmissor. Marcar "sempre" e repetir.
3. **O mesmo sem o app:** a página espera ~1,5 s, conecta; segunda abertura sem
   espera (conferir `tela.semApp=1` em Application ▸ Local Storage); medir o
   tempo até o primeiro quadro das duas aberturas contra o de antes do D8.
4. **Chrome sem gesto:** confirmar se o lançamento por iframe é aceito sem
   clique; se não for, o botão ABRIR NO APP precisa funcionar (tem gesto).
5. **Linux deb/rpm:** `xdg-open tela://assistir/<canal>`; `grep MimeType
   /usr/share/applications/tela.desktop` mostra `x-scheme-handler/tela;`;
   `xdg-settings get default-url-scheme-handler tela`. AppImage: sem integração
   cai no navegador (esperado).
6. **App fechado, clique no link:** a primeira abertura (argv a frio) cai no
   canal, não na home.
7. **Ao vivo no app, clique num link do Discord:** aparece o aviso, a
   transmissão segue, nada navega.
8. **Tela cheia no espectador dentro do app:** `F` e duplo clique entram; `Esc`
   sai; o trilho some e volta; nos dois sistemas.
9. Dev: `TELA_REGISTRAR_ESQUEMA=1 pnpm --filter @tela/desktop dev:app` registra o
   esquema apontando para o checkout (desfazer depois).
