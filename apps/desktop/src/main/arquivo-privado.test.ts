import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gravarArquivoPrivado } from './arquivo-privado.js';

describe.skipIf(process.platform === 'win32')('arquivo privado (S-22)', () => {
  let pasta = '';
  beforeEach(() => {
    pasta = mkdtempSync(join(tmpdir(), 'tela-priv-'));
  });
  afterEach(() => rmSync(pasta, { recursive: true, force: true }));

  it('cria com 0600', () => {
    const f = join(pasta, 'ajustes.json');
    gravarArquivoPrivado(f, '{}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('um arquivo antigo, criado com 0644, passa a 0600', () => {
    const f = join(pasta, 'captura-portal.json');
    writeFileSync(f, 'velho', { mode: 0o644 });
    gravarArquivoPrivado(f, '{"restaurar":"t"}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
