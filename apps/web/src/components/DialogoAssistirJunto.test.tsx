// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoAssistirJunto } from './DialogoAssistirJunto.js';

afterEach(cleanup);

function montar(extra: Partial<Parameters<typeof DialogoAssistirJunto>[0]> = {}) {
  const props = {
    dialogRef: createRef<HTMLDialogElement>(),
    aoClicarNoFundo: () => undefined,
    inputRef: createRef<HTMLInputElement>(),
    valor: '',
    aoMudar: () => undefined,
    erro: null,
    recentes: [] as readonly string[],
    aoEscolher: () => undefined,
    substitui: null,
    aoEnviar: () => undefined,
    aoCancelar: () => undefined,
    ...extra,
  };
  return render(<DialogoAssistirJunto {...props} />);
}

describe('DialogoAssistirJunto', () => {
  it('recentes viram teclas de um toque', () => {
    const aoEscolher = vi.fn();
    montar({ recentes: ['ana', 'bia'], aoEscolher });
    fireEvent.click(screen.getByRole('button', { name: 'bia', hidden: true }));
    expect(aoEscolher).toHaveBeenCalledWith('bia');
  });

  it('o erro diz o que aconteceu', () => {
    const { container, rerender } = montar({ erro: 'repetido' });
    expect(container.textContent).toContain('Esse canal já está na tela.');
    rerender(
      <DialogoAssistirJunto
        dialogRef={createRef()}
        aoClicarNoFundo={() => undefined}
        inputRef={createRef()}
        valor=""
        aoMudar={() => undefined}
        erro={null}
        recentes={[]}
        aoEscolher={() => undefined}
        substitui="bia"
        aoEnviar={() => undefined}
        aoCancelar={() => undefined}
      />,
    );
    expect(container.textContent).toContain('O novo canal entra no lugar de bia.');
  });
});
