/**
 * As variáveis `TELA_*` de desenvolvimento no app EMPACOTADO (S-11), puro.
 *
 * Quem consegue definir o ambiente de um processo (um `.desktop`/atalho
 * adulterado, o RC do shell) faria o app carregar `TELA_DESKTOP_URL` — uma
 * página qualquer COM o preload e todas as IPC — ou trocar `userData` por uma
 * pasta sua. Empacotado, então, todas são ignoradas, exceto as que só
 * REDUZEM o que o app faz, e que o smoke do binário empacotado (e2e com
 * `TELA_EXE`) precisa:
 *
 *  - `TELA_NATIVO=0`: desliga o helper nativo de captura (menos capacidade);
 *  - `TELA_REGISTRAR_ESQUEMA=0`: não registra o `tela://` (menos efeito no sistema);
 *  - `TELA_ATUALIZACAO=0`: desliga a verificação de atualização (o smoke não vai à rede);
 *  - `TELA_BANDEJA=0|1`: só decide se há bandeja; não abre nada nem concede nada.
 *
 * `TELA_USERDATA` fica de fora de propósito: o smoke empacotado usa o switch
 * `--user-data-dir` do Chromium (mesmo efeito, e por argv, não por ambiente).
 */
export type Ambiente = Readonly<Record<string, string | undefined>>;

export function ambienteEfetivo(env: Ambiente, empacotado: boolean): Ambiente {
  if (!empacotado) return env;
  const limpo: Record<string, string | undefined> = {};
  for (const [chave, valor] of Object.entries(env)) {
    if (!chave.startsWith('TELA_')) limpo[chave] = valor;
  }
  if (env['TELA_NATIVO'] === '0') limpo['TELA_NATIVO'] = '0';
  if (env['TELA_REGISTRAR_ESQUEMA'] === '0') limpo['TELA_REGISTRAR_ESQUEMA'] = '0';
  if (env['TELA_ATUALIZACAO'] === '0') limpo['TELA_ATUALIZACAO'] = '0';
  const bandeja = env['TELA_BANDEJA'];
  if (bandeja === '0' || bandeja === '1') limpo['TELA_BANDEJA'] = bandeja;
  return limpo;
}
