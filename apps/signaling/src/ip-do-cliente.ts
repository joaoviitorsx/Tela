/**
 * De onde vem o IP do cliente (S-17).
 *
 * `X-Forwarded-For` é um cabeçalho que QUALQUER cliente escreve. Confiar no
 * primeiro valor, como o servidor fazia, deixa quem fala direto com a porta
 * trocar de IP a cada conexão e fugir de todo limite por IP. A regra agora é
 * explícita: sem `TRUST_PROXY`, o IP é o do socket e o cabeçalho é ignorado.
 *
 * Com proxy, o cabeçalho só vale pelo que os NOSSOS proxies acrescentaram — o
 * fim da lista. Cada proxy confiável anexa o endereço de quem falou com ele,
 * então o cliente real é o N-ésimo a contar da direita; o que o cliente
 * escreveu fica à esquerda e é descartado.
 *
 *  - `TRUST_PROXY=1` (ou N): N proxies confiáveis na frente (um balanceador,
 *    um Caddy/nginx, um túnel). O IP do cliente é a N-ésima entrada da
 *    direita. Conta errada para MAIS faz o servidor ler um IP forjável; para
 *    MENOS, o do próprio proxy (todo mundo no mesmo balde).
 *  - `TRUST_PROXY=10.0.0.5,10.0.0.6`: lista de IPs dos proxies. O cabeçalho só
 *    é lido se o SOCKET vier de um deles, e o cliente é a primeira entrada
 *    da direita que NÃO seja um proxy da lista.
 */
export type ConfiancaNoProxy =
  | { readonly tipo: 'nenhuma' }
  | { readonly tipo: 'saltos'; readonly n: number }
  | { readonly tipo: 'ips'; readonly ips: ReadonlySet<string> };

/** `::ffff:1.2.3.4` e `1.2.3.4` são o mesmo endereço; minúsculas para IPv6. */
export function normalizarIp(ip: string): string {
  const baixo = ip.trim().toLowerCase();
  return baixo.startsWith('::ffff:') && baixo.includes('.') ? baixo.slice(7) : baixo;
}

export function parseTrustProxy(bruto: string | undefined): ConfiancaNoProxy | { readonly problema: string } {
  const valor = (bruto ?? '').trim();
  if (valor === '' || valor === '0' || valor.toLowerCase() === 'false') return { tipo: 'nenhuma' };
  if (/^\d+$/.test(valor)) {
    const n = Number(valor);
    if (n < 1 || n > 10) return { problema: 'TRUST_PROXY: número de saltos deve ficar entre 1 e 10' };
    return { tipo: 'saltos', n };
  }
  const ips = valor.split(',').map(normalizarIp).filter(Boolean);
  // Lista só de endereços: um `true`/`*` aqui seria "confie em todo mundo".
  if (ips.length === 0 || ips.some((ip) => !/^[0-9a-f:.]+$/.test(ip))) {
    return { problema: 'TRUST_PROXY: use 0, um número de saltos (1-10) ou uma lista de IPs separados por vírgula' };
  }
  return { tipo: 'ips', ips: new Set(ips) };
}

export function ipDoCliente(
  remoto: string | undefined,
  encaminhado: string | string[] | undefined,
  confianca: ConfiancaNoProxy,
): string {
  const socket = remoto === undefined ? 'desconhecido' : normalizarIp(remoto);
  if (confianca.tipo === 'nenhuma') return socket;

  const cadeia = (Array.isArray(encaminhado) ? encaminhado.join(',') : (encaminhado ?? ''))
    .split(',')
    .map(normalizarIp)
    .filter(Boolean);
  if (cadeia.length === 0) return socket;

  if (confianca.tipo === 'saltos') {
    // Sem entradas suficientes, o cabeçalho não veio de N proxies nossos: não confia.
    return cadeia.length >= confianca.n ? (cadeia[cadeia.length - confianca.n] as string) : socket;
  }

  // Lista de IPs: o socket tem de ser um deles, senão o cabeçalho é do cliente.
  if (!confianca.ips.has(socket)) return socket;
  for (let i = cadeia.length - 1; i >= 0; i -= 1) {
    const entrada = cadeia[i] as string;
    if (!confianca.ips.has(entrada)) return entrada;
  }
  return socket;
}
