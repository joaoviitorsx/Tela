
/**
 * O estado da transmissão que o renderer entrega ao main (D4), validado, e o
 * que o main faz com ele: texto e menu da bandeja. Puro — o `Tray` é do main.
 *
 * É a ÚNICA coisa sobre a transmissão que o main sabe, e ele a trata como o que
 * é: dado de uma página. Nada daqui decide mídia (R8 vale em espírito: o main
 * não toca a transmissão, só a descreve e a manda parar).
 */
export type EstadoAoVivo = {
  readonly noAr: boolean;
  /** `Date.now()` de quando foi ao ar; `null` fora do ar. */
  readonly inicioMs: number | null;
  readonly assistindo: number;
  readonly capacidade: number;
  /** O link público (http/https), ou `null`. É o que "Copiar link" copia. */
  readonly link: string | null;
};

export const FORA_DO_AR: EstadoAoVivo = { noAr: false, inicioMs: null, assistindo: 0, capacidade: 0, link: null };

const TAMANHO_MAXIMO_DO_LINK = 2048;

/**
 * O link só vai para a área de transferência — nunca é aberto —, então aceita
 * `http:` além de `https:` (o build de desenvolvimento aponta para
 * `http://localhost`). Qualquer outro esquema (`javascript:`, `file:`, `app:`)
 * é recusado: o texto copiado não deve ser um vetor.
 */
function linkValido(bruto: unknown): string | null {
  if (typeof bruto !== 'string' || bruto.length > TAMANHO_MAXIMO_DO_LINK) return null;
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    return null;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.host !== '' ? url.href : null;
}

/** A sala nunca passa de algumas dezenas; o teto só barra lixo. */
const TETO_DE_PESSOAS = 1000;

function inteiro(valor: unknown, maximo: number): number | null {
  if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < 0 || valor > maximo) return null;
  return valor;
}

/**
 * `unknown` → estado, ou `null` quando o payload não é um estado. Fora do ar
 * vira SEMPRE `FORA_DO_AR`: um "fora do ar" com link e espectadores é incoerente
 * e não deve chegar ao menu.
 */
export function estadoAoVivoValido(bruto: unknown): EstadoAoVivo | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const d = bruto as Record<string, unknown>;
  if (typeof d['noAr'] !== 'boolean') return null;
  if (!d['noAr']) return FORA_DO_AR;

  const assistindo = inteiro(d['assistindo'], TETO_DE_PESSOAS);
  const capacidade = inteiro(d['capacidade'], TETO_DE_PESSOAS);
  if (assistindo === null || capacidade === null) return null;

  let inicioMs: number | null = null;
  if (d['inicioMs'] !== null) {
    if (typeof d['inicioMs'] !== 'number' || !Number.isFinite(d['inicioMs']) || d['inicioMs'] <= 0) return null;
    inicioMs = Math.floor(d['inicioMs']);
  }

  let link: string | null = null;
  if (d['link'] !== null) {
    link = linkValido(d['link']);
    if (link === null) return null;
  }
  return { noAr: true, inicioMs, assistindo, capacidade, link };
}

export function mesmoEstado(a: EstadoAoVivo, b: EstadoAoVivo): boolean {
  return (
    a.noAr === b.noAr &&
    a.inicioMs === b.inicioMs &&
    a.assistindo === b.assistindo &&
    a.capacidade === b.capacidade &&
    a.link === b.link
  );
}

const dois = (n: number): string => String(n).padStart(2, '0');

/** `42` → `00:42`; `3725` → `1:02:05`. */
export function tempoNoAr(inicioMs: number | null, agora: number): string {
  if (inicioMs === null) return '--:--';
  const total = Math.max(0, Math.floor((agora - inicioMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${dois(m)}:${dois(s)}`;
}

/** "NO AR 00:42 · 3/50" ou "Fora do ar". */
export function rotuloDoEstado(estado: EstadoAoVivo, agora: number): string {
  if (!estado.noAr) return 'Fora do ar';
  return `NO AR ${tempoNoAr(estado.inicioMs, agora)} · ${estado.assistindo}/${estado.capacidade}`;
}

export type IdDoMenu = 'estado' | 'copiar' | 'mostrar' | 'encerrar' | 'sair';

export type ItemDoMenu =
  | { readonly tipo: 'item'; readonly id: IdDoMenu; readonly rotulo: string; readonly habilitado: boolean }
  | { readonly tipo: 'separador' };

/** O menu da bandeja como dado; o main só o converte em `MenuItem`s. */
export function modeloDoMenu(estado: EstadoAoVivo, janelaVisivel: boolean, agora: number): readonly ItemDoMenu[] {
  return [
    { tipo: 'item', id: 'estado', rotulo: rotuloDoEstado(estado, agora), habilitado: false },
    { tipo: 'separador' },
    { tipo: 'item', id: 'copiar', rotulo: 'Copiar link', habilitado: estado.noAr && estado.link !== null },
    { tipo: 'item', id: 'mostrar', rotulo: janelaVisivel ? 'Esconder' : 'Mostrar', habilitado: true },
    { tipo: 'item', id: 'encerrar', rotulo: 'Encerrar transmissão', habilitado: estado.noAr },
    { tipo: 'separador' },
    { tipo: 'item', id: 'sair', rotulo: estado.noAr ? 'Sair (encerra a transmissão)' : 'Sair', habilitado: true },
  ];
}
