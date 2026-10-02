/**
 * Quem pode abrir o WebSocket, pelo cabeçalho `Origin` (TELA-019, §9.2).
 *
 * Defesa ADICIONAL para navegadores, não autenticação: qualquer programa fora
 * do navegador manda o `Origin` que quiser, ou nenhum. O que ela barra é uma
 * página de terceiros abrindo sinalização em nome de quem a visita — e
 * gastando credencial TURN da nossa cota com isso.
 *
 * Sem `Origin` passa (decisão da revisão S-02, mantida de propósito): navegador
 * sempre manda no upgrade, então a ausência é cliente fora do navegador — e
 * esse cliente manda o `Origin` que quiser. Recusar a ausência só barraria o
 * script preguiçoso (um `curl` que esquece o cabeçalho) e quebraria
 * ferramentas legítimas (os `e2e/*.mjs`, clientes de linha de comando), sem
 * conter ninguém que se importe. O que protege o TURN pago e as vagas é o
 * limite por IP, por conexão e por canal (`limits.ts`, `ip-do-cliente.ts`),
 * que vale com ou sem `Origin`.
 */
export function normalizarOrigem(valor: string): string {
  return valor.trim().toLowerCase().replace(/\/+$/, '');
}

export function origemPermitida(
  origin: string | null | undefined,
  permitidas: readonly string[],
  /** A origem que serve o front junto com a sinalização, quando é o caso. */
  propria: string | null = null,
): boolean {
  if (origin === null || origin === undefined || origin === '') return true;
  const alvo = normalizarOrigem(origin);
  if (propria !== null && alvo === normalizarOrigem(propria)) return true;
  // Nada configurado e nenhuma origem própria: sem regra (desenvolvimento).
  if (permitidas.length === 0 && propria === null) return true;
  return permitidas.some((p) => normalizarOrigem(p) === alvo);
}

export function listaDeOrigens(bruto: string | undefined): string[] {
  return (bruto ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
