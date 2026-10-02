import { describe, expect, it } from 'vitest';
import { divergencias, lerFuses } from './fuses.mjs';

const ENDURECIDO = `Analyzing app: tela
Fuse Version: v1
  RunAsNode is Disabled
  EnableCookieEncryption is Enabled
  EnableNodeOptionsEnvironmentVariable is Disabled
  EnableNodeCliInspectArguments is Disabled
  EnableEmbeddedAsarIntegrityValidation is Enabled
  OnlyLoadAppFromAsar is Enabled
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Disabled
  undefined is Enabled
`;

const PADRAO_DE_FABRICA = `Analyzing app: electron
Fuse Version: v1
  RunAsNode is Enabled
  EnableCookieEncryption is Disabled
  EnableNodeOptionsEnvironmentVariable is Enabled
  EnableNodeCliInspectArguments is Enabled
  EnableEmbeddedAsarIntegrityValidation is Disabled
  OnlyLoadAppFromAsar is Disabled
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Enabled
`;

describe('fuses do binário empacotado (S-03)', () => {
  it('lê a saída do @electron/fuses', () => {
    const f = lerFuses(ENDURECIDO);
    expect(f['RunAsNode']).toBe(false);
    expect(f['OnlyLoadAppFromAsar']).toBe(true);
    expect(Object.keys(f)).toHaveLength(9);
  });

  it('o binário endurecido passa nas três plataformas', () => {
    for (const p of ['linux', 'win32', 'darwin']) expect(divergencias(lerFuses(ENDURECIDO), p), p).toEqual([]);
  });

  it('o padrão de fábrica do Electron falha: RunAsNode, NODE_OPTIONS, --inspect, asar, file:', () => {
    const d = divergencias(lerFuses(PADRAO_DE_FABRICA), 'linux').join('\n');
    for (const nome of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'OnlyLoadAppFromAsar', 'GrantFileProtocolExtraPrivileges', 'EnableCookieEncryption']) {
      expect(d).toContain(nome);
    }
    // Integridade do asar não existe no Linux: só é exigida no Windows/macOS.
    expect(d).not.toContain('EnableEmbeddedAsarIntegrityValidation');
    expect(divergencias(lerFuses(PADRAO_DE_FABRICA), 'win32').join('\n')).toContain('EnableEmbeddedAsarIntegrityValidation');
  });

  it('um fuse que a leitura não mostra é divergência, não "ok"', () => {
    expect(divergencias({}, 'linux')).toHaveLength(7);
    expect(divergencias(lerFuses('lixo'), 'linux')[0]).toContain('não aparece');
  });
});
