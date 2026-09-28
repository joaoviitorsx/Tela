# TELA-010 — script de áudio do Linux

`scripts/audio-linux.sh` passou a ter `setup`, `status`, `retarget` e
`cleanup`. A identidade dos módulos é a marca `tela.managed=1` nos
argumentos, não o número: IDs são reaproveitados quando o servidor de áudio
reinicia.

## Executado

`pnpm test:audio-linux` (`scripts/audio-linux.test.sh`) roda o script contra um
`pactl` falso que guarda estado em arquivo e simula reinício do servidor com
numeração recomeçando. 16 asserções, todas passando:

- `setup` dez vezes: um sink, um retorno;
- `cleanup` preserva loopback e null sink de terceiros;
- depois de reiniciar o servidor, módulos de terceiros com os IDs antigos do
  Tela sobrevivem ao `cleanup`;
- retorno nunca aponta para `tela_cap` (pedido explícito é recusado; saída
  padrão igual a `tela_cap` faz o script escolher outra saída física);
- `retarget` troca a saída sem duplicar;
- módulos da versão antiga (sem marca) bloqueiam o `setup` com instrução e só
  saem com `cleanup --legado`, sem tocar em outros loopbacks;
- `status` avisa quando `TelaCapture` é a saída padrão (a chamada de voz
  entraria na transmissão).

## Não executado

A máquina de desenvolvimento não tem `pactl`. Nada acima prova o comportamento
do PipeWire real.

| Caso | Como validar |
|---|---|
| sintaxe de propriedades aceita pelo `pipewire-pulse` | `bash scripts/audio-linux.sh setup`; `pactl list short modules \| grep tela.managed` deve listar 2 linhas |
| estéreo de fato | `status` não pode avisar mono; tocar um teste esquerda/direita no jogo e ouvir no espectador |
| `setup` ×10 no servidor real | rodar dez vezes e repetir o `grep` acima: continua 2 |
| reinício do servidor | `systemctl --user restart pipewire pipewire-pulse`; `status` deve mostrar 0 e 0; `cleanup` não remove nada |
| troca de fone | plugar outro fone, `retarget <nome>` (veja `pactl list short sinks`); o som do jogo passa a sair no fone novo |
| latência de 30 ms | ouvir o próprio jogo no fone; se houver atraso incômodo, `TELA_LATENCIA_MS=15 bash … retarget`; se estalar, subir |
| PulseAudio puro (sem PipeWire) | repetir a tabela numa distro com PulseAudio |
