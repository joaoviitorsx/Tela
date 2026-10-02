/**
 * A bandeja do sistema (D4), as decisões puras.
 *
 * No Windows há sempre. No Linux o ícone vive de um serviço D-Bus, o
 * `StatusNotifierWatcher`: KDE e XFCE o trazem, o GNOME do Fedora NÃO (precisa
 * da extensão AppIndicator). O `Tray` do Electron "funciona" sem ele — não dá
 * erro, só não aparece —, e um app escondido numa bandeja invisível é um app
 * perdido. Por isso o main PERGUNTA ao barramento antes de depender dela.
 */
export const NOME_DO_WATCHER = 'org.kde.StatusNotifierWatcher';

/** O comando que pergunta ao barramento de sessão se o watcher tem dono. */
export const COMANDO_DA_SONDA = {
  arquivo: 'dbus-send',
  args: [
    '--session',
    '--dest=org.freedesktop.DBus',
    '--print-reply',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner',
    `string:${NOME_DO_WATCHER}`,
  ],
} as const;

/** A resposta do `dbus-send --print-reply`: `   boolean true`. */
export function watcherPresenteNaSaida(saida: string): boolean {
  return /boolean\s+true/.test(saida);
}

/**
 * `TELA_BANDEJA=0|1` força a resposta (e2e, quem sabe que a sonda erra).
 * `null` = não forçado, sonde.
 */
export function bandejaForcada(env: Readonly<Record<string, string | undefined>>): boolean | null {
  const v = env['TELA_BANDEJA'];
  return v === '1' ? true : v === '0' ? false : null;
}

/** Windows e macOS: sempre. Linux: só com o watcher. */
export function plataformaTemBandeja(plataforma: NodeJS.Platform): boolean | 'sondar' {
  return plataforma === 'linux' ? 'sondar' : true;
}

/** O âmbar do CRT do Tela (`--color-accent`), em RGB. */
const AMBAR = { r: 255, g: 176, b: 0 } as const;

/**
 * Pinta um bitmap BGRA (a ordem do `NativeImage.toBitmap()` em little-endian)
 * de âmbar monocromático: a luminância de cada pixel modula o âmbar, o alfa
 * fica. Barra de bandeja é pequena e vive sobre fundos claros e escuros — um
 * ícone de uma cor só lê melhor que o colorido, e é a cara do CRT.
 */
export function monocromaAmbar(bgra: Uint8Array): Uint8Array {
  const saida = new Uint8Array(bgra.length);
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    const b = bgra[i] ?? 0;
    const g = bgra[i + 1] ?? 0;
    const r = bgra[i + 2] ?? 0;
    const luz = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const fator = 0.3 + 0.7 * luz;
    saida[i] = Math.round(AMBAR.b * fator);
    saida[i + 1] = Math.round(AMBAR.g * fator);
    saida[i + 2] = Math.round(AMBAR.r * fator);
    saida[i + 3] = bgra[i + 3] ?? 0;
  }
  return saida;
}
