/**
 * Os fuses que o Tela exige no binário empacotado (S-03), e a leitura da saída
 * de `@electron/fuses read`. Puro: o script `verificar-fuses.mjs` só executa
 * a ferramenta e chama isto; o teste (`fuses.test.mjs`) o roda sem binário.
 *
 * Os nomes são os que a ferramenta imprime; o valor é o ESTADO esperado.
 * `electron-builder.yml` (`electronFuses`) é de onde saem — mudar um, mude o outro.
 */
export const FUSES_ESPERADOS = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
});

/**
 * `EnableEmbeddedAsarIntegrityValidation` só vale (e só é exigido) onde o
 * Electron implementa a conferência: Windows e macOS. No Linux o electron-builder
 * liga o fuse, mas o Electron o ignora, e não há o que verificar.
 */
export const FUSE_DE_INTEGRIDADE = 'EnableEmbeddedAsarIntegrityValidation';

/** `  RunAsNode is Enabled` → `{ RunAsNode: true }`. Linhas que não são de fuse somem. */
export function lerFuses(saida) {
  const fuses = {};
  for (const linha of String(saida).split(/\r?\n/)) {
    const m = /^\s+(\w+) is (Enabled|Disabled|Removed)\s*$/.exec(linha);
    if (m !== null) fuses[m[1]] = m[2] === 'Enabled';
  }
  return fuses;
}

/**
 * Compara com o esperado. Devolve a lista de divergências (vazia = ok). Um
 * fuse ausente da saída é divergência: se a ferramenta não o lê, não dá para
 * garantir nada sobre ele.
 */
export function divergencias(fuses, plataforma) {
  const esperado = { ...FUSES_ESPERADOS };
  if (plataforma === 'win32' || plataforma === 'darwin') esperado[FUSE_DE_INTEGRIDADE] = true;
  const problemas = [];
  for (const [nome, valor] of Object.entries(esperado)) {
    const atual = fuses[nome];
    if (atual === undefined) problemas.push(`${nome}: não aparece na leitura`);
    else if (atual !== valor) problemas.push(`${nome}: ${atual ? 'ligado' : 'desligado'}, devia estar ${valor ? 'ligado' : 'desligado'}`);
  }
  return problemas;
}
