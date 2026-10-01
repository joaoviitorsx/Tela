# ADR 0028 — Sala aberta por padrão; aprovação vira opção

**Data:** 2026-10-01
**Estado:** aceita
**Altera:** ADR 0025 (a aprovação deixa de ser obrigatória) · **Mantém:** 0026, R6, R8

## Contexto

O dono decidiu (2026-10-01): quem recebe o link é quem ele quer assistindo, e
fazer cada amigo pedir e esperar é atrito sem ganho nesse uso. "Por enquanto" —
a aprovação pode voltar.

## Decisão

1. **Sala aberta é o padrão.** Quem tem o link entra direto: vaga, credencial
   TURN e `watching`, sem apelido nem pedido.
2. **A aprovação não foi apagada; virou opção da sala.** O `host` leva
   `approval: true` para ligá-la; ausente = aberta. O caminho inteiro da ADR
   0025 (fila, `admit`/`deny`, impressão da chave, fila com teto, hibernação)
   continua no servidor e na suíte de conformidade. Religar é mandar a flag.
3. **Dono que volta com a sala aberta** deixa entrar quem estava esperando.
4. **Protocolo 5.** Aba na 4 pediria apelido e esperaria um aceite que não vem;
   recebe `PROTOCOL_MISMATCH` ("recarregue").
5. O cliente web não pergunta apelido. Se a pessoa tiver um guardado de antes,
   ele vai junto e aparece na lista de vagas do dono.

## O que se perde

Não há porta nenhuma: quem adivinhar ou receber de segunda mão o nome do canal
assiste, e recebe credencial TURN por conta da cota do projeto. Restam ao dono
"desconectar todos" e remover um espectador — sem banimento, quem tem o link
pode voltar. Os limites de vagas (5) e de conexões por IP continuam.
