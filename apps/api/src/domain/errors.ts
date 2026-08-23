/**
 * União de literais, não enum nem classe de erro.
 *
 * O motivo é o mapeamento HTTP: com união de literais o `Record<AppError, ...>`
 * em http/error-mapping.ts é exaustivo por construção — adicionar um erro novo
 * aqui quebra a compilação lá até alguém decidir o status code.
 */
export type AppError =
  | 'SLUG_INVALID'
  | 'SLUG_RESERVED'
  | 'SLUG_TAKEN'
  | 'SLUG_UNKNOWN'
  | 'OWNER_INVALID'
  | 'NOT_LIVE'
  | 'RATE_LIMITED'
  | 'VIEWER_LIMIT'
  | 'UPSTREAM_UNAVAILABLE';
