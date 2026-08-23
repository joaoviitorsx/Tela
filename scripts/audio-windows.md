# Áudio do jogo no Windows

Não precisa de script. O Chrome entrega o áudio do sistema junto com a tela —
mas só se você fizer as duas coisas no picker:

1. escolha a aba **"Tela inteira"** (não "Janela" — janela não leva áudio)
2. marque **"Compartilhar áudio do sistema"** no canto inferior

É o passo que todo mundo esquece, e o sintoma é uma transmissão muda sem
nenhuma mensagem de erro. A tela inicial do Tela lembra disso.

## Se mesmo assim sair mudo

- Firefox não suporta `systemAudio`. Use Chrome ou Edge.
- Compartilhar **janela** ou **aba** nunca leva o áudio do sistema, só o da
  aba. Para jogo nativo, tem que ser tela inteira.
