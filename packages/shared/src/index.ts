/**
 * Única exceção à proibição de barrel files (AGENTS.md R7): esta é a API
 * pública do pacote compartilhado. Nada mais no repositório re-exporta módulo.
 */
export * from './schemas.js';
export * from './encoding.js';
export * from './blocklist.js';
export * from './signaling.js';
