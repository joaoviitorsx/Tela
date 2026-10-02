/**
 * O nome que o servidor não aceitou, de uma tela para a outra (auditoria B-02).
 *
 * "Nome em uso" só é descoberto ao ir ao ar (não há sondagem de nome no
 * servidor, de propósito: seria um oráculo de enumeração). Quem descobre é a
 * tela de transmissão; quem precisa mostrar é o passo 1 do assistente, que
 * nasce de novo ao voltar. Esta é a ponte: em memória, uma leitura, sem I/O.
 * Recarregar a página a apaga, e tudo bem: o aviso era sobre a tentativa de
 * agora.
 */
export type NomeRecusado = {
  readonly slug: string;
  readonly motivo: 'em-uso' | 'invalido';
};

let ultimo: NomeRecusado | null = null;

export function registrarNomeRecusado(recusado: NomeRecusado): void {
  ultimo = recusado;
}

/** Lê sem apagar: seguro dentro de inicializador de estado (StrictMode chama duas vezes). */
export function espiarNomeRecusado(): NomeRecusado | null {
  return ultimo;
}

export function limparNomeRecusado(): void {
  ultimo = null;
}

/** Sufixos que costumam resolver: o mesmo nome com um número ou "-tv". */
const SUFIXOS = ['-2', '-tv', '-ao-vivo'] as const;
const LIMITE = 25;

/**
 * Até duas variações do nome recusado, já cortadas para caber no limite do
 * slug. Só sugere o que o formato aceita; não afirma que estejam livres.
 */
export function sugerirNomes(slug: string): readonly string[] {
  const base = slug.replace(/-+$/, '');
  if (base.length === 0) return [];
  return SUFIXOS.map((s) => `${base.slice(0, LIMITE - s.length).replace(/-+$/, '')}${s}`)
    .filter((s) => s.length >= 3 && s !== slug)
    .slice(0, 2);
}
