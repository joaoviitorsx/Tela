# Cortar a beta.23 — com assinatura do update (ADR 0038)

Esta é a **primeira** beta que verifica assinatura (ADR 0038). A partir daqui,
assinar faz parte de cortar uma beta. Os passos abaixo valem para todas as
próximas também — é só trocar o número.

Pré-requisitos uma vez:
- A **chave privada** `tela-update-private.pem`, offline (a mesma cuja pública
  está embutida em `apps/desktop/src/main/verificacao-de-assinatura.ts`).
- `openssl` e `gh` (GitHub CLI) na máquina.

> **Teste a chave UMA vez antes da primeira release** (prova que a sua privada
> casa com a pública que o app verifica):
> ```bash
> echo teste > /tmp/x
> openssl pkeyutl -sign -rawin -inkey tela-update-private.pem -in /tmp/x -out /tmp/x.sig
> node -e 'const{createPublicKey,verify}=require("crypto"),fs=require("fs");
>   const pub=`-----BEGIN PUBLIC KEY-----
> MCowBQYDK2VwAyEA5DTYBhZYyTuY1k10/lFaN+OhQb6s5s3Q7gVmNuNduRo=
> -----END PUBLIC KEY-----`;
>   console.log("casa:",verify(null,fs.readFileSync("/tmp/x"),createPublicKey(pub),fs.readFileSync("/tmp/x.sig")));'
> ```
> Tem de imprimir `casa: true`. Se não, a chave está errada — NÃO corte a beta.

---

## 1. Subir a versão e criar a tag

```bash
cd ~/Documentos/Projetos/Tela
git checkout main && git pull           # main já tem o código da beta.23
```

Edite `apps/desktop/package.json`: `"version": "0.1.0-beta.23"`. Commit e tag **no mesmo commit**:

```bash
git add apps/desktop/package.json
git commit -m "chore(desktop): 0.1.0-beta.23"
git push origin main                    # (ou via PR develop→main, como de praxe)

git tag desktop-v0.1.0-beta.23
git push origin desktop-v0.1.0-beta.23
```

O prefixo `desktop-v` é obrigatório; se a tag e o `package.json` discordarem, o
workflow para no primeiro passo.

## 2. Esperar o CI

Em *Actions → desktop*. Ele compila Windows e Linux, cria o release como
**pré-release em RASCUNHO** e sobe os instaladores, os `latest*.yml`, os
`.blockmap` e os `SHA256SUMS`. **O CI NÃO publica** — o release fica rascunho,
invisível para o auto-update, até você assinar e publicar (passos 3 e 4). Assim
nenhum usuário vê um release sem os `.sig`.

Confira que o passo **"addon WASAPI"** (Windows) ficou verde — senão o "Só o
jogo"/"Sistema" do Windows sai desabilitado (ver `BETA.md`).

## 3. Assinar os dois instaladores e subir os `.sig`

Com o release ainda em rascunho, baixe os dois instaladores que auto-atualizam,
assine com a privada offline e suba os `.sig`:

```bash
TAG=desktop-v0.1.0-beta.23
cd $(mktemp -d)

# baixa só o .exe e o .AppImage do release (rascunho é acessível a você)
gh release download "$TAG" --repo joaoviitorsx/Tela --pattern '*-win-x64.exe' --pattern '*-linux-x86_64.AppImage'

# assina cada um (Ed25519 cru — o formato que o app verifica)
for f in *.exe *.AppImage; do
  openssl pkeyutl -sign -rawin -inkey ~/caminho/tela-update-private.pem -in "$f" -out "$f.sig"
done

# sobe as assinaturas para o mesmo release (ainda rascunho)
gh release upload "$TAG" --repo joaoviitorsx/Tela *.sig
```

> **deb e rpm não precisam de `.sig`**: eles não auto-atualizam (modo "avisar").
> Só o `.exe` (NSIS) e o `.AppImage` instalam sozinhos e são verificados.

## 4. Publicar (tirar o rascunho)

Só agora o release vai ao ar — já com as assinaturas:

```bash
gh release edit desktop-v0.1.0-beta.23 --repo joaoviitorsx/Tela --draft=false --prerelease
gh release view desktop-v0.1.0-beta.23 --repo joaoviitorsx/Tela
```

Na lista de assets devem estar, lado a lado:
`Tela-0.1.0-beta.23-win-x64.exe` **e** `Tela-0.1.0-beta.23-win-x64.exe.sig`;
`Tela-0.1.0-beta.23-linux-x86_64.AppImage` **e** o `.AppImage.sig`.

Pronto. Quem está na beta.22 recebe a beta.23 (ver abaixo); e a partir daqui,
quem estiver na beta.23 só aceitará a beta.24 se ela tiver os `.sig`.

> **Ensaiar sem publicar nada:** rode o workflow por *Run workflow*
> (`workflow_dispatch`) — ele sai como artefato do run, não como release.

---

## Se você publicar sem assinar, ou esquecer um `.sig`

Como o release agora só vai ao ar quando VOCÊ publica (passo 4), o normal é nunca
haver release público sem `.sig`. Se mesmo assim faltar alguma assinatura da
beta.24 em diante, os usuários ficam presos na versão anterior (sem instalar nada
errado) — o conserto é subir o `.sig` que faltou; o app verifica na próxima
checagem (até 6 h, ou ao reabrir).
