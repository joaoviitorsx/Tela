/**
 * União de literais, não enum nem classe de erro.
 *
 * O motivo é a exaustividade: com união de literais, um `Record<AppError, …>`
 * quebra a compilação até alguém decidir o que fazer com o membro novo.
 *
 * Encolheu no changeset 001: sem API HTTP, sumiram os erros que só existiam
 * para virar status code. O que sobrou é o vocabulário do domínio.
 */
export type AppError =
  | 'SLUG_INVALID'
  | 'SLUG_RESERVED'
  | 'SLUG_TAKEN'
  | 'OWNER_INVALID'
  | 'NOT_HOSTING'
  | 'CHANNEL_FULL'
  | 'RATE_LIMITED';
