# ADR 0038 — Integridade da atualização do app: assinatura do manifesto

**Data:** 2026-10-04
**Estado:** aceita e implementada — o dono escolheu chave OFFLINE e entregou a pública (2026-10-04). A verificação está no app; falta o dono ASSINAR cada release a partir da próxima e, opcionalmente, ligar immutable releases e Authenticode.
**Altera:** o modelo de confiança do auto-update descrito em `D5-atualizacao.md` e em `motor-electron-updater.ts` ("o `verifySignature` do NsisUpdater é pulado porque o instalador não é assinado") · **Mantém:** o electron-updater, o feed `generic` no GitHub, o "nunca atualizar durante uma transmissão"

## Contexto

A auditoria de segurança (2026-10-04, achado U-1) apontou o maior risco do app:

> O auto-update confia inteiramente no canal de releases do GitHub e instala em
> silêncio. Comprometer o canal (um PAT roubado com `contents: write`, ou
> qualquer workflow com esse escopo) = execução de código em todo usuário com
> auto-update ligado — dentro do app que captura a tela.

Como funciona hoje:

- o electron-updater lê `latest*.yml` do release mais novo `desktop-v…`;
- confere o **SHA-512** do instalador baixado contra o hash no `latest*.yml`;
- mas o hash mora no **mesmo** `latest*.yml`, do **mesmo** release. Quem
  consegue publicar/trocar o release troca o instalador E o hash juntos;
- no Windows o instalador é **não assinado** (decisão de §15), então o
  `verifySignature` do NsisUpdater é pulado;
- no Linux o AppImage não tem assinatura de código nenhuma;
- o NSIS por usuário (`/S`) não dispara UAC, e o caminho da abertura instala
  sem um clique. Ou seja: **um release malicioso vira RCE silencioso.**

Não é explorável por MITM (TLS, host e caminho fixos). O vetor é o **canal de
publicação**.

## Decisão

Defesa em camadas, da mais barata à que depende do dono.

### 1. `APPIMAGE` sozinho não liga auto-update (U-2) — FEITO

`modoDeAtualizacao` passou a exigir `APPIMAGE` **e** `APPDIR` (os dois env que o
runtime do AppImage põe). Uma única variável `APPIMAGE` vazada no ambiente de um
deb/rpm não liga mais a atualização automática — que no Linux pode terminar num
install privilegiado (`pkexec`/`dpkg`/`rpm`). `apps/desktop/src/main/atualizacao-release.ts`.

### 2. Assinar o INSTALADOR com uma chave offline, e verificar antes de instalar — FEITO (app)

O hash não basta porque viaja junto do instalador. A trava é uma **assinatura
Ed25519 do próprio instalador** (`.exe` e `.AppImage` — os únicos que
auto-atualizam; deb/rpm só avisam), com uma chave cuja privada o atacante do
canal do GitHub não tem, e cuja pública é **embutida no app**.

Assina-se o instalador em si, não o `latest.yml`: Ed25519 puro sobre os bytes do
arquivo dispensa parser de YAML e recomputar hash, e amarra os bytes que vão
rodar diretamente à chave do dono.

- **App** (`verificacao-de-assinatura.ts`, `motor-electron-updater.ts`): depois
  de baixar, antes de liberar o install, busca o `.sig` ao lado do instalador no
  release, lê o instalador do disco e confere a assinatura contra a pública
  embutida. Assinatura ausente, malformada, de outra chave, ou um byte trocado ⇒
  **não instala** (`autoInstallOnAppQuit` fica desligado e `instalarAgora` é
  recusado), e o download falha com erro claro. Fail-closed.
- **Dono**, por release, com a privada OFFLINE, depois que o CI publica:
  ```sh
  openssl pkeyutl -sign -rawin -inkey tela-update-private.pem \
    -in  Tela-<versão>-win-x64.exe        -out Tela-<versão>-win-x64.exe.sig
  openssl pkeyutl -sign -rawin -inkey tela-update-private.pem \
    -in  Tela-<versão>-linux-x86_64.AppImage -out Tela-<versão>-linux-x86_64.AppImage.sig
  ```
  e sobe os dois `.sig` no release (ao lado dos instaladores).

A pública embutida é a de `tela-update-public.pem`:
`MCowBQYDK2VwAyEA5DTYBhZYyTuY1k10/lFaN+OhQb6s5s3Q7gVmNuNduRo=`.

**Transição:** a verificação vale a partir do primeiro app que a traz (a próxima
beta). Esse app, ao buscar a beta seguinte, VAI exigir `.sig` — então **toda
release a partir da próxima precisa ser assinada**, senão quem está nessa beta
não recebe auto-update (falha segura: não instala, não quebra; dá para baixar à
mão). As betas já publicadas (sem a verificação) não são afetadas.

### 3. `immutable releases` + tirar `--clobber` — DEPENDE DO DONO

Hoje o job de publicação usa `gh release upload … --clobber`, que **sobrescreve**
assets de um release já publicado. Com assinatura isso é menos grave (a troca
quebraria a assinatura), mas o certo é o release ser imutável: ligar
**"immutable releases"** no repositório e tirar o `--clobber` de
`.github/workflows/desktop.yml`. Sem o `--clobber`, um re-run do workflow no
mesmo tag falha ao subir — que é o comportamento desejado (o release não muda
depois de publicado); re-publicar exige um tag novo.

### 4. Authenticode no Windows — DEPENDE DO DONO

Assinar o instalador do Windows (certificado + `win.publisherName`) reativaria o
`verifySignature` nativo do NsisUpdater e tiraria o aviso do SmartScreen. Custa
um certificado de code signing. Fora do escopo desta ADR; registrado como opção.

## O que o dono precisa decidir/fazer

1. **Gerar uma chave Ed25519 de assinatura OFFLINE** (fora do CI — uma chave
   guardada só em secret do GitHub ainda é usável por um workflow malicioso;
   offline é o que fecha o vetor de verdade). Entregar a pública para embutir.
2. **Ligar "immutable releases"** no repositório `joaoviitorsx/Tela` (é um botão
   no GitHub, ninguém liga por código).
3. **Decidir sobre Authenticode** (comprar certificado ou seguir não assinado
   com o hash + assinatura do manifesto).

Com a chave pública em mãos, a parte 2 é implementada e ligada.

## Consequências

- **Aceito até a parte 2 entrar:** o auto-update continua confiando no canal do
  GitHub. O risco é real mas exige comprometer a publicação, não a rede.
- **Depois da parte 2:** trocar um release sem a chave privada offline faz o app
  recusar o update em vez de instalar código forjado.
- **Custo:** um passo de assinatura no CI e ~50 linhas de verificação no app; a
  chave privada é responsabilidade operacional do dono.

## Não verificável por máquina aqui

- Que `immutable releases` está ligado (painel do GitHub).
- Que `quitAndInstall(true, true)` é mesmo silencioso/sem UAC no Windows.
- Que o electron-builder 26 escreve ou não `resources/package-type` em deb/rpm
  (afeta uma checagem alternativa à do §1).
