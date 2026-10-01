# Tela Desktop — beta

Como sai uma beta, o que o CI produz e o roteiro de quem testa no Windows.
O empacotamento está em `apps/desktop/electron-builder.yml`; o workflow em
`.github/workflows/desktop.yml`; as decisões (NSIS sem assinatura, AppImage +
RPM + DEB) em `PLANO-desktop.md` §7 e §15.

## Cortar uma beta

1. Suba a versão em `apps/desktop/package.json` — `0.1.0-beta.1`,
   `0.1.0-beta.2`, ... — e commite.
2. Crie a tag **no mesmo commit** e envie:

   ```sh
   git tag desktop-v0.1.0-beta.2
   git push origin desktop-v0.1.0-beta.2
   ```

   O prefixo `desktop-v` é obrigatório (o site não é versionado por tag). Se a
   tag e o `package.json` discordarem, o workflow para no primeiro passo e diz
   qual é qual.
3. Acompanhe em *Actions → desktop*. O release nasce como **rascunho**, recebe
   os instaladores dos dois sistemas e só então aparece em
   <https://github.com/joaoviitorsx/Tela/releases>, marcado como pré-release.

Para ensaiar sem publicar nada, rode o workflow por *Run workflow*
(`workflow_dispatch`): os instaladores saem como artefato do run, não como
release.

## O que o workflow produz

| Arquivo | Para quem |
|---|---|
| `Tela-<versão>-win-x64.exe` | Windows 10/11 x64 — instalador NSIS, por usuário, sem assinatura |
| `Tela-<versão>-linux-x86_64.AppImage` | Qualquer distro; principal no Linux |
| `Tela-<versão>-linux-x86_64.rpm` | Fedora |
| `Tela-<versão>-linux-amd64.deb` | Ubuntu/Debian |
| `SHA256SUMS-Windows.txt`, `SHA256SUMS-Linux.txt` | Hash dos instaladores, gerado no runner que os produziu |
| `latest.yml`, `latest-linux.yml`, `*.blockmap` | Metadados do electron-builder; ignore |

O renderer é compilado contra o signaling de produção
(`wss://tela.transmissao.workers.dev/signal`), e o app não tem tela de
configuração. **Não há atualização automática ainda**: cada beta é baixar e
instalar de novo. O instalador do Windows não é assinado, por decisão (§15) —
daí o aviso abaixo e o hash.

Os pacotes não trazem o `tela-captura` (áudio só do jogo no Linux, D2). Nesta
beta, o som no Linux é o que o PipeWire oferecer ao `getDisplayMedia`.

## Roteiro de teste no Windows

### Instalar

1. Baixe o `.exe` e o `SHA256SUMS-Windows.txt` da página do release.
2. Confira o hash no PowerShell, na pasta de downloads:

   ```powershell
   Get-FileHash .\Tela-0.1.0-beta.1-win-x64.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS-Windows.txt
   ```

   Os dois hexadecimais têm que ser idênticos (maiúsculas e minúsculas não
   importam). Se diferirem, não instale: o arquivo não é o que o CI gerou.
3. Abra o `.exe`. O SmartScreen mostra **"O Windows protegeu o computador"**.
   Clique em **Mais informações → Executar assim mesmo**. É o esperado: o
   instalador não é assinado.
4. Siga o instalador (pode trocar a pasta). Ele instala só para o seu usuário,
   sem pedir administrador.

### Testar

Com o jogo aberto e um amigo numa call (texto e voz continuam no Discord —
o Tela é só o vídeo):

1. **Abrir** — o app abre, mostra a abertura e chega na tela inicial.
2. **Transmitir** — clique em transmitir, escolha o jogo (ou a tela), copie o
   link.
3. **Alguém entra** — mande o link; o amigo abre **no navegador**, sem
   instalar nada. Ele tem que ver o jogo em poucos segundos.
4. **Minimizar** — minimize o app e volte ao jogo por alguns minutos. A
   transmissão não pode cair nem travar; o amigo confirma.
5. **Qualidade e FPS** — anote o que o console da transmissão mostra
   (resolução, fps, bits por pixel) e, se tiver MangoHud/RTSS, o fps do jogo
   antes e durante. O amigo diz se a imagem borra, quadricula ou engasga.
6. **Encerrar** — pare a transmissão e feche o app. O amigo tem que ver que
   acabou, não um quadro congelado.

### O que mandar de volta

- Capturas de tela: do app, do console da transmissão e, se der, do que o
  amigo viu.
- O diagnóstico do console da transmissão (o texto que o app mostra sobre
  resolução, fps, bits por pixel, rede). É ele que diz se o encoder por
  hardware está em uso e por que a qualidade caiu, se caiu.
- GPU e driver (`Win+R` → `dxdiag` → aba *Exibição*), jogo testado, e com
  quantos espectadores.
- Se algo quebrou: o que você fez, o que esperava, o que aconteceu. Em
  ordem.

## Linux

AppImage: `chmod +x Tela-*.AppImage && ./Tela-*.AppImage`. No Fedora, se não
abrir, falta o FUSE 2: `sudo dnf install fuse-libs` — ou instale o RPM. Confira
o hash com `sha256sum -c SHA256SUMS-Linux.txt --ignore-missing`.
