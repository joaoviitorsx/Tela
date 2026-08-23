# E2E — dois browsers de verdade

```bash
pnpm dev          # num terminal
pnpm e2e          # noutro
```

Os 208 testes unitários provam a lógica com fakes. Este prova que a lógica
fala com o WebRTC que realmente existe: SDP real, ICE real, encoder real e
frames de vídeo atravessando uma `RTCPeerConnection` entre dois contextos de
browser separados.

**O que ele cobre:** carga do front, estado offline do espectador, o mesh
completo (host publica → espectador conecta sozinho → frames chegam),
estatísticas agregadas com bitrate medido, troca de qualidade ao vivo sem
derrubar quem assiste, teto de espectadores e a saída do transmissor.

**O que ele NÃO cobre:** `getDisplayMedia`. O picker de tela é do sistema
operacional e não existe em headless — a captura aqui é um canvas animado.
Tudo a jusante da trilha de vídeo é exercitado de verdade.

Ele já encontrou um bug que os testes com fake não pegavam: dois `open()`
concorrentes (React em StrictMode) faziam a tentativa obsoleta derrubar o
transporte da viva, e "canal cheio" chegava ao usuário como "não está
transmitindo".
