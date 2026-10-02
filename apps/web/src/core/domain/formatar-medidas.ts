/**
 * Como os números do console aparecem (auditoria C-02): inteiros onde a
 * casa decimal é ruído, vírgula onde ela informa, e unidade separada por
 * espaço. `59.441252229134705fps` não diz nada que `59 fps` não diga.
 */

const virgula = (n: number, casas: number): string => n.toFixed(casas).replace('.', ',');

/** Quadros por segundo, sempre inteiros. `0` ou inválido é ausência de medida. */
export function formatarFps(fps: number): string {
  return Number.isFinite(fps) && fps > 0 ? `${Math.round(fps)} fps` : '—';
}

/** Megabits por segundo, uma casa: `9,4 Mbps`. */
export function formatarMbps(bps: number): string {
  return Number.isFinite(bps) && bps > 0 ? `${virgula(bps / 1_000_000, 1)} Mbps` : '—';
}

/** Milissegundos inteiros: `58 ms`. */
export function formatarMs(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? `${Math.round(ms)} ms` : '—';
}

/** Custo por quadro, uma casa: `7,1 ms`. */
export function formatarMsPorQuadro(ms: number): string {
  return Number.isFinite(ms) ? `${virgula(ms, 1)} ms` : '—';
}

/** Bits por pixel, três casas: `0,107`. */
export function formatarBpp(bpp: number): string {
  return Number.isFinite(bpp) && bpp > 0 ? virgula(bpp, 3) : '—';
}
