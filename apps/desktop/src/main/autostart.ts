import { join } from 'node:path';

/**
 * "Iniciar com o sistema" (D4, PLANO §5), puro.
 *
 * Windows usa `app.setLoginItemSettings`; no Linux não há API, é um `.desktop`
 * em `~/.config/autostart`, e quem o escreve é o main — aqui só o conteúdo e o
 * caminho. O app aberto assim sobe ESCONDIDO na bandeja (`--oculto`) e jamais
 * captura: captura é sempre um clique da pessoa.
 */

/** O argumento que o autostart passa. Também vale para quem quiser abrir escondido. */
export const ARGUMENTO_OCULTO = '--oculto';

export function iniciaOculto(argv: readonly string[]): boolean {
  return argv.includes(ARGUMENTO_OCULTO);
}

/**
 * Onde mora o autostart. `TELA_USERDATA` (e2e, instalação portátil) tem
 * precedência para o teste jamais tocar o autostart REAL de quem o roda;
 * depois o padrão XDG.
 */
export function pastaDoAutostart(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const portatil = env['TELA_USERDATA'];
  if (portatil !== undefined && portatil !== '') return join(portatil, 'autostart');
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : join(home, '.config');
  return join(base, 'autostart');
}

export const NOME_DO_ARQUIVO_AUTOSTART = 'tela.desktop';

/** Caractere de controle (inclui `\n`, `\r`, NUL e DEL): em `Exec=` vira outra linha/chave do arquivo. */
function temControle(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Um argumento do `Exec=`: a especificação do Desktop Entry manda aspas duplas
 * em volta de tudo que tem espaço ou caractere reservado, e `"`, `` ` ``, `$` e
 * `\` escapados dentro delas. `%` vira `%%` (senão é código de campo).
 *
 * A barra invertida é a exceção: o valor ainda passa pela regra de escape de
 * strings do arquivo (`\\` → `\`), aplicada ANTES da de aspas — um `\` literal
 * precisa de QUATRO no arquivo (S-18). Caractere de controle é recusado, não
 * escapado: `$APPIMAGE` é variável de ambiente e `\nHidden=true` injetaria chaves
 * no `.desktop`. Quem chama (`aplicarAutostart`) trata a exceção como "não deu".
 */
export function argumentoDoExec(arg: string): string {
  if (temControle(arg)) throw new RangeError('caractere de controle no comando do autostart');
  const semCodigos = arg.replace(/%/g, '%%');
  if (!/[\s"'\\`$<>~|&;*?#()]/.test(semCodigos)) return semCodigos;
  const escapado = semCodigos.replace(/[\\"`$]/g, (c) => (c === '\\' ? '\\\\\\\\' : `\\${c}`));
  return `"${escapado}"`;
}

/**
 * O executável que o login deve abrir. No AppImage `process.execPath` aponta
 * para o ponto de montagem temporário, que some ao fechar: o caminho estável é
 * `$APPIMAGE`.
 */
export function executavelDoAutostart(env: Readonly<Record<string, string | undefined>>, execPath: string): string {
  const appImage = env['APPIMAGE'];
  return appImage !== undefined && appImage !== '' ? appImage : execPath;
}

export function conteudoDoAutostart(comando: readonly string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Tela',
    'Comment=Transmita seu jogo para quem tem o link',
    `Exec=${[...comando, ARGUMENTO_OCULTO].map(argumentoDoExec).join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}
