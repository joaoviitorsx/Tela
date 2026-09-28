# TELA-006 — homologação das rotas ICE

Este é um ensaio de conectividade, não uma promessa de cobertura universal. O
script usa dois contextos de Chromium, uma trilha de canvas e as credenciais
efêmeras emitidas pelo signaling. Cada caso TURN passa **somente** as URLs da
variante ensaiada aos dois `RTCPeerConnection`s e usa `iceTransportPolicy:
'relay'`. Ele lê o par pelo `transport.selectedCandidatePairId` e exige
`local-candidate.relayProtocol` igual ao modo escolhido. `candidate.protocol`
não identifica o acesso ao TURN. Um par antigo `succeeded` não conta.

## Executar

No PowerShell, com o signaling de **homologação** acessível:

```powershell
$env:SIGNAL_URL = 'wss://SEU-SIGNAL/signal'
$env:MODES = 'direct,udp,tcp,tls'
$env:NETWORK_LABEL = 'rede-laboratorio-1'
$env:REPORT_PATH = 'C:\Temp\tela-relay-laboratorio-1.json'
$env:CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
pnpm e2e:relay
```

`SIGNAL_URL` é a base, sem o slug. O script abre um canal descartável com nome
aleatório para receber credenciais TURN, fecha o canal e não salva token,
credencial, IP, SDP ou candidatos. Sem `CHROME`, usa o Chromium instalado pelo
Playwright. `MODES=direct` dispensa signaling e prova só a execução local.
O relatório JSON registra versão do Chromium, plataforma, rótulo da rede,
estado ICE/DTLS, tipos do par selecionado, `relayProtocol` observado e bytes de
vídeo. Guarde o relatório fora do repositório; revise antes de compartilhá-lo.

`ENDPOINT_ABSENT` indica que a credencial emitida não contém URL daquela
variante. `PATH_OR_MEDIA_UNCONFIRMED` inclui conexão sem mídia, par ausente,
relay não selecionado ou `relayProtocol` indisponível/divergente; consulte os
campos do relatório. Uma URL `turns:` isolada testa TLS; `relay` com todas as
URLs juntas não prova TLS.

## Matriz a executar

| Caso | Condição | Evidência para aprovar |
|---|---|---|
| Direto | Rede local de referência | Par selecionado sem relay, vídeo e bytes recebidos. |
| TURN/UDP | Somente URL UDP e política relay | Par selecionado relay em ambos os lados, `relayProtocol=udp`, vídeo. |
| TURN/TCP | Somente URL TCP e política relay | Par selecionado relay, `relayProtocol=tcp`, vídeo. |
| TURN/TLS | Somente URL `turns:` na porta 443 e política relay | Par selecionado relay, `relayProtocol=tls`, vídeo. |
| UDP bloqueado | Restrição **somente em rede/laboratório autorizado** | Repetir TCP/TLS isolados; vídeo chega e o protocolo observado corresponde. |
| Falha de todas as rotas | DNS/TLS ou TURN indisponível no laboratório | Produto termina em “sem conexão”, oferece tentar novamente e diagnóstico; registrar etapa e código, sem atribuir culpa à operadora sem evidência. |
| IPv4/IPv6 | Redes com cada família disponível | Registrar família observada no `chrome://webrtc-internals`, sem copiar endereços para o relatório. |

Para testar o **produto inteiro** em máquinas e redes distintas, publique um
canvas/jogo no host, entre pelo link em outro dispositivo e confira o par
selecionado em `chrome://webrtc-internals` nos dois lados. Registre versão do
app, navegador e sistema, horário, tipo de rede, etapa da falha e se o primeiro
frame chegou. Compare com o relatório do ensaio isolado. Duas abas da mesma
máquina não homologam NAT ou firewall entre redes. Para uma sessão longa,
mantenha a transmissão por duas horas e pelo menos dois ciclos de renovação,
repetindo entrada, saída e troca de rede.

Na falha, colete o diagnóstico sanitizado dos dois participantes. Verifique na
ordem: signaling, emissão TURN, coleta ICE, par selecionado, ICE/DTLS, bytes e
reprodução. Um erro isolado de coleta não prova que todas as rotas falharam.
Não peça token do dono, senha TURN, SDP bruto nem alterações no firewall de
produção.

## Evidência disponível nesta execução

| Caso | Ambiente | Resultado |
|---|---|---|
| Direto | Windows, Chromium 153.0.8010.53, dois contextos no mesmo computador; 2026-09-28 12:42 UTC | Passou: par host/host escolhido por `transport`, ICE/DTLS conectados, 10.095 bytes e 30 frames decodificados. |
| TURN/UDP, TCP, TLS e restrições de rede | Sem configuração TURN/rede de laboratório nesta máquina | Pendente de execução humana. |

O resultado local confirma o harness e a rota direta no mesmo computador.
Não confirma nenhum cenário de relay nem rede brasileira real.
