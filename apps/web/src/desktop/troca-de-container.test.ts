import { describe, expect, it } from 'vitest';
import { CONTAINER_DESKTOP, destinoDoContainer } from './troca-de-container.js';

const RAIZ = '/repo/apps/web';
const WEB = `${RAIZ}/src/container.ts`;
const DESKTOP = `${RAIZ}/${CONTAINER_DESKTOP}`;

describe('destinoDoContainer', () => {
  it('redireciona rota e hook que importam o container da web', () => {
    expect(destinoDoContainer(RAIZ, WEB, `${RAIZ}/src/routes/Home.tsx`)).toBe(DESKTOP);
    expect(destinoDoContainer(RAIZ, WEB, `${RAIZ}/src/react/use-vitrine.ts`)).toBe(DESKTOP);
  });

  it('deixa o container desktop importar o da web para estender', () => {
    expect(destinoDoContainer(RAIZ, WEB, DESKTOP)).toBeNull();
  });

  it('ignora qualquer outro módulo', () => {
    expect(destinoDoContainer(RAIZ, `${RAIZ}/src/router.ts`, `${RAIZ}/src/App.tsx`)).toBeNull();
    expect(destinoDoContainer(RAIZ, `${RAIZ}/src/container.test.ts`, undefined)).toBeNull();
  });

  it('tolera a query do dev e barras do Windows', () => {
    expect(destinoDoContainer(RAIZ, `${WEB}?v=abc`, `${RAIZ}/src/routes/Home.tsx?t=1`)).toBe(DESKTOP);
    expect(destinoDoContainer(`${RAIZ}/`, WEB, `${DESKTOP}?v=1`)).toBeNull();
    expect(destinoDoContainer('C:\\repo\\apps\\web', 'C:/repo/apps/web/src/container.ts', 'C:/repo/apps/web/src/App.tsx'))
      .toBe('C:/repo/apps/web/src/desktop/container.desktop.ts');
  });
});
