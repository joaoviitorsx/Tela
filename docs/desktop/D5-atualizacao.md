# D5 — Atualização

**Data:** 2026-10-02 · **Plano:** `PLANO-desktop.md` §5 ("nunca baixa nem instala durante a transmissão") e §7 · **Antes:** D4, S-03, S-04

O app instalado acha, baixa e instala a versão seguinte sem que ninguém precise
voltar à página do release — e **nunca mexe numa transmissão no ar**. Windows
(NSIS) e AppImage atualizam sozinhos; RPM e DEB só avisam.

```text
 main (tudo é decidido aqui)                              renderer (AJUSTES, só mostra)
 ───────────────────────────                              ─────────────────────────────
 atualizacao-politica.ts  máquina de estados pura         linha: versão · estado · última verificação
   ▲ eventos   │ comandos                                 botões: VERIFICAR AGORA · REINICIAR E ATUALIZAR
 atualizador.ts  timers (30 s, 6 h) + executa comandos      ▲
   │                                                        │ tela:atualizacao / tela:atualizacao-mudou
 motor-electron-updater.ts  ÚNICO que importa electron-updater
   │  lista de releases (API) → tag mais nova → provider `generic`
   ▼
 github.com/joaoviitorsx/Tela/releases/download/desktop-vX/{latest*.yml, instalador, .blockmap}
```

## 1. Política (`atualizacao-politica.ts`, pura e testada)

| Situação | O que acontece |
|---|---|
| 30 s depois de abrir, e a cada 6 h, **fora do ar** e com "Atualizar automaticamente" ligado | verifica |
| Achou versão nova (Windows/AppImage) | baixa em segundo plano; ao terminar, fica **pronta** e liga "instalar ao sair" |
| **Ao vivo** | não verifica (nem a pedido), não baixa, não reinicia |
| Entrou no ar no meio do download | o download é **cancelado** e retomado quando a transmissão acaba (não disputa o upload com quem assiste) |
| Download terminou antes de entrar no ar, ou versão achada ao vivo | espera. Instala quando a pessoa sair do app (o sair ao vivo já para a sessão com `stop()`), ou no REINICIAR E ATUALIZAR depois |
| REINICIAR E ATUALIZAR (AJUSTES ou bandeja) | só com a atualização pronta **e** fora do ar; o main recusa o pedido nos outros casos. Instala em silêncio e reabre |
| "Atualizar automaticamente" desligado | o relógio não verifica; um download automático em curso é cancelado e "instalar ao sair" é retirado. **VERIFICAR AGORA** continua valendo e, se achar, baixa |
| Erro (rede, hash, API) | silencioso: vai ao terminal (`[tela] atualização: …`) e à linha *Última verificação* do AJUSTES; a próxima volta tenta de novo |
| RPM/DEB (Linux fora de AppImage) | verifica e **avisa** (AJUSTES e bandeja) com a página do release; não baixa nem instala nada |
| Fora do pacote (dev), macOS, `TELA_ATUALIZACAO=0` | desligada |

**Aviso no trilho** (`avisoNoTrilho`, desde a beta.9): quem nunca abre o
AJUSTES também fica sabendo. Com a versão nova baixada e fora do ar, aparece
um item âmbar **ATUALIZAR** no trilho, acima do DIAG: um clique reinicia e
atualiza. Em deb/rpm, com versão nova, o mesmo item leva ao AJUSTES (onde está
o link da página). Baixando, ao vivo ou em dia, o item não existe.

Cada verificação e cada download têm uma *rodada*: o que ainda responder de uma
rodada velha (um download cancelado) é ignorado. "Ao vivo" vem da mesma fonte da
bandeja (`EstadoAoVivo`, D4); a queda do renderer o zera.

Detecção de plataforma (`modoDeAtualizacao`): Windows empacotado → automática;
Linux com `APPIMAGE` no ambiente → automática; Linux sem → só avisa.

## 1b. Abertura com atualização (estilo Discord, desde a beta.22)

Ao abrir o app (não pelo autostart escondido), com atualização automática
disponível (Windows, AppImage) e ligada, uma janelinha de 320×380 aparece
ANTES da janela principal (`abertura-atualizacao.ts`, pura e testada):

| Fase | O que a pessoa vê |
|---|---|
| Procurando (prazo de 5 s) | a TV da logo com as antenas caçando sinal; "Procurando atualização…" |
| Em dia, sem rede, erro ou prazo estourado | some (no mínimo 0,9 s na tela) e o Tela abre como sempre |
| Baixando | a barra de 20 blocos acende como fósforo de CRT; "Abrir sem atualizar" aparece |
| Instalando | a piscadinha da logo e o tubo desligando; o app fecha e volta atualizado |

- A janela principal carrega por trás e só aparece quando a abertura libera:
  sem atualização, o tempo de abrir não muda.
- "Abrir sem atualizar" (ou fechar a janelinha) cancela o download; o relógio
  de sempre (30 s, 6 h) recomeça depois, com o blockmap baixando só o que falta.
- A página é `data:` sem rede, CSP fechada e sem preload: o único sinal de
  volta é o título (`TITULO_DE_PULAR`). Animação só com `transform`/`opacity`;
  com `prefers-reduced-motion`, a TV fica parada.

## 2. Por que o provider `generic`, e não o `github`

Verificado no código do `electron-updater` 6.8.9 (`out/providers/GitHubProvider.js`):
**ele ignora `tagNamePrefix`** (o campo só vale para publicar) e descarta toda
tag que `semver.valid` não aceite. `desktop-v0.1.0-beta.7` não é semver: com o
provider `github` o app instalado jamais acharia o release (e fora do canal
beta ele ainda consulta só `/releases/latest`, que exclui pré-releases).

Por isso o main faz a parte da tag: pede a lista de releases
(`api.github.com/repos/joaoviitorsx/Tela/releases`, HTTPS, prazo de 15 s, teto
de 1 MB), filtra `desktop-v<semver>` publicadas (rascunho não conta; pré-release
conta), escolhe a maior com comparação semver 2.0 (`beta.10 > beta.9`) e aponta
o provider `generic` para `…/releases/download/<tag>/`, onde estão o
`latest.yml`/`latest-linux.yml`. A URL só tem a tag como parte variável, e ela
já passou pelo regex. O updater continua com a palavra final sobre haver versão
nova (compara o `latest*.yml` com a instalada) e `allowDowngrade` é `false`.
`electron-builder.yml` (`publish`) segue como está — é o que o CI usa para
nomear e a fonte de `app-update.yml`; um teste confere que dono, repositório e
prefixo do código batem com ele.

## 3. Dependência

`electron-updater` ^6.8.9, **dependência de runtime** de `apps/desktop`: roda no
main empacotado. Nenhuma outra biblioteca atualiza NSIS e AppImage de uma
configuração só. É JavaScript puro (sem `npmRebuild`) e entra atrás de uma porta
(`MotorDeAtualizacao`), carregada por `import()` só quando há o que atualizar.
Empacotamento verificado: `electron-builder --linux dir` coloca `electron-updater`
e as 15 dependências transitivas em `app.asar/node_modules` (o fuse
`onlyLoadAppFromAsar` não atrapalha: tudo está dentro do asar). O motor usa o
*default import* do módulo (CommonJS) — a importação nomeada não funciona no ESM
do main.

## 4. Do CI ao release

Desde a reestruturação do S-04 (`empacotar` roda `--publish never`; só o job
`publicar` escreve), os releases saíam **sem** `latest.yml`, `latest-linux.yml`
e `.blockmap`: nenhum app instalado veria atualização. Agora:

- `empacotar` falha se o arquivo do updater não foi gerado (`latest.yml` e
  `*.exe.blockmap` no Windows; `latest-linux.yml` no Linux) e os inclui no
  artefato. O AppImage leva o blockmap embutido, sem arquivo à parte.
- `publicar` confere que o `latest*.yml` descreve o instalador que está ali
  (SHA-512 do `path:` do yml contra o arquivo; se não bate, o release não sai e
  o rascunho fica), **atesta** instalador, `latest*.yml` e `.blockmap`
  (`actions/attest-build-provenance`) e os anexa. Permissões e jobs seguem os do
  S-04: nada do projeto roda onde há escrita.

## 5. Segurança — o que protege e o que não

- Transporte: a lista, o `latest*.yml` e o instalador vêm por **HTTPS** do
  GitHub. O updater confere o **SHA-512** de cada arquivo baixado contra o do
  `latest*.yml` (e do blockmap, no diferencial).
- **O instalador do Windows não é assinado** (§15) e o `electron-builder.yml` não
  tem `publisherName`, então o `electron-updater` **não** verifica Authenticode
  (`NsisUpdater.verifySignature` retorna sem checar). O SHA-512 prova que o
  arquivo é o que o `latest.yml` descreve, mas `latest.yml` e instalador moram
  no mesmo release: quem controla o release (ou a conta do GitHub, ou o
  workflow) controla os dois e entrega código que o app executa. É o mesmo risco
  de "baixar o instalador à mão", agora sem a pessoa olhar. Mitigações: a
  atestação de proveniência cobre o instalador **e** o `latest*.yml` (quem
  suspeita confere com `gh attestation verify`); o release só nasce do workflow
  numa tag; menor privilégio no CI. O app em si **não** confere a atestação.
  Fechar o buraco de verdade é assinar (certificado, ou assinatura do
  `latest.yml` verificada pelo app) — fora do escopo desta fase.
- AppImage: o updater troca o próprio arquivo; é o mesmo canal e o mesmo SHA-512.
- IPC: os canais novos (`tela:atualizacao`, `tela:verificar-atualizacao`,
  `tela:reiniciar-e-atualizar`) vêm só do frame da interface (`origemPermitida`),
  não carregam payload — o que eles podem fazer é decidido pela política (nada
  ao vivo). O ajuste novo passa por `mesclarAjustes` (só booleano). O estado
  que vai à interface não leva pilha nem caminho (`mensagemDeErro`: uma linha,
  160 caracteres). O link da página do pacote passa por `urlExternaPermitida`
  (só `https:`).

## 6. Validação humana (nada disto dá para verificar sem rede, instalador e GPU)

Não executado por mim: instalação, atualização real no Windows e no AppImage,
`quitAndInstall`, o menu da bandeja com o item novo. Roteiro:

1. Instale a beta **N** (a atual, `0.1.0-beta.6` ou a mais recente com este
   código) pelo release. **Importante:** só versões COM este código se
   atualizam; a primeira beta com o atualizador precisa ser instalada à mão.
2. Corte a beta **N+1**: suba a versão, crie a tag `desktop-vN+1`, espere o
   workflow publicar. Confira na página do release que há `latest.yml`,
   `latest-linux.yml`, o `.exe.blockmap` e as atestações.
3. Abra a beta N **sem transmitir**. Em ~30 s (ou em AJUSTES → VERIFICAR AGORA)
   a linha deve ir de *Verificando* a *Baixando 42%* a *…pronta: reinicie para
   atualizar*. O menu da bandeja ganha *Reiniciar e atualizar*.
4. **Windows e AppImage, nos dois:** clique em REINICIAR E ATUALIZAR (ou feche o
   app e reabra). O app deve voltar na versão N+1 (AJUSTES → *Versão*).
5. Repita com a atualização **pronta e a transmissão no ar**: o botão e o item
   da bandeja ficam travados; a transmissão não pode piscar. Também com o
   download em curso ao entrar no ar (ele deve parar — veja o terminal:
   `download cancelado: transmissão no ar`) e retomar ao encerrar.
   **Nunca faça este teste durante uma transmissão que importe.**
6. RPM/DEB: AJUSTES mostra *Nova versão … não se atualiza sozinho*, com ABRIR
   PÁGINA; nada é baixado.
7. Sem rede: desligue-a antes dos 30 s; AJUSTES mostra o erro e *Última
   verificação*, sem diálogo.
8. Desmarque *Atualizar automaticamente*, reabra: nada verifica sozinho.

Dúvidas assumidas: (a) a API do GitHub sem autenticação limita 60 req/h por IP —
uma verificação a cada 6 h por instalação está longe, mas uma rede com muitos
testadores atrás de um NAT é o caso a observar; (b) `quitAndInstall(true, true)`
no NSIS instala em silêncio e reabre, e o AppImage troca o arquivo — comportamento
documentado do `electron-updater`, não exercitado aqui.
