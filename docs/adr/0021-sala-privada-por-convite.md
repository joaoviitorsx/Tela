# ADR 0021 — Sala privada por convite e protocolo versionado

**Data:** 2026-09-28
**Estado:** aceita
**Tarefa:** TELA-018 · **Mantém:** R6 (sem conta, sem login), R8 (payload opaco)

## Contexto

O slug é endereço legível, não segredo. Qualquer um que adivinhasse `jv`
assistia — e recebia, de brinde, credencial TURN paga pela cota do projeto.
O plano global (§9.1) pede um convite independente do `ownerToken`, com pelo
menos 128 bits, verificado antes de reservar vaga ou emitir credencial.

## Decisões (as de produto são do dono, tomadas em 2026-09-28)

1. **Toda sala é privada.** Não existe modo aberto: o link é
   `https://tela.gg/<slug>#k=<convite>`. Sem o `#k=` válido, não entra.
2. **O convite é fixo** entre transmissões, guardado no navegador do dono
   (`tela.convite`), até ele clicar "renovar convite". O link continua
   "permanente" no sentido que importa: mandar uma vez no Discord basta.
3. **Renovar barra só entradas novas.** Quem já está assistindo fica. Tirar
   quem está dentro é ação separada — "desconectar todos" —, e sem renovar a
   pessoa pode voltar pelo mesmo link. O produto não promete banimento: token
   compartilhado não identifica ninguém.
4. **Fragmento, não caminho nem query.** O navegador não manda o fragmento em
   HTTP, então o convite não aparece em log de servidor, CDN ou proxy. Ele vai
   ao servidor dentro do primeiro frame do WebSocket (WSS em produção). Não
   protege de histórico, área de transferência nem de quem recebeu o link.
5. **O servidor guarda só o hash.** Node e Durable Object comparam em tempo
   constante, antes de vaga e antes de `iceServersFor`. No Worker o hash viaja
   no attachment do host, pela mesma razão do `ownerHash`: hibernação.
6. **`INVITE_INVALID` só quando há transmissão.** Sem host, qualquer convite
   recebe `NOT_HOSTING`, como antes: quem varre nomes continua sem distinguir
   "não existe" de "fora do ar". Com host, quem tem link velho precisa saber
   que o convite mudou — o custo é revelar que alguém está no ar.
7. **Protocolo versionado.** `host`/`watch` levam `protocol: 2`. Sem o campo é
   cliente v1: recusado com `BAD_MESSAGE`, que ele entende, e nunca atendido
   como sala aberta. Versão diferente recebe `PROTOCOL_MISMATCH`, e a página
   diz "recarregue".
8. **Mensagens novas:** `set-invite` → `invite-set`; `remove-viewers`
   (`peerId` opcional). Só o host atual as usa. O espectador tirado recebe
   `REMOVED` e não reconecta sozinho.

## Implantação

O Worker serve front e sinalização no mesmo deploy, então as duas pontas mudam
juntas. Abas abertas antes do deploy falam v1 e passam a receber
`BAD_MESSAGE`: recarregar resolve. Não há janela de compatibilidade porque
aceitar v1 seria reabrir a sala para quem não tem convite — exatamente o que o
§15.1 do plano proíbe.

Quem recupera a conta em outro navegador (`/recuperar`) leva o `ownerToken`,
não o convite: o aparelho novo gera outro, e o link muda.

## Fica para depois

Aprovação manual de cada espectador ("aceitar solicitação para assistir"),
pedida pelo dono para depois da refatoração do front. O ponto de encaixe é o
mesmo onde o convite é validado — antes de vaga e de credencial —, com um
estado de espera novo no protocolo.
