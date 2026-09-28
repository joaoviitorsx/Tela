import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Opcoes = {
  /** As linhas do menu, na ordem em que aparecem. */
  readonly ids: readonly string[];
  /** `←`/`→` na linha `id`. A rota decide o que "ajustar" quer dizer. */
  readonly aoAjustar: (id: string, direcao: -1 | 1) => void;
  /** `Enter` numa linha, ou na página com o foco fora de qualquer controle. */
  readonly aoConfirmar?: () => void;
  /**
   * As setas e o `Enter` valem também com o foco no corpo da página, como no
   * protótipo: a pessoa chega no passo e já navega, sem tabular até o menu.
   * Desligue quando houver diálogo aberto ou outro passo na tela.
   */
  readonly global?: boolean;
};

export type MenuOsd = {
  /** A linha que carrega o `tabindex=0` (roving focus). */
  readonly ativo: string | null;
  /** "2/3" para a barra de título. Vazio se não há linhas. */
  readonly posicao: string;
  readonly selecionar: (id: string) => void;
  readonly propsContainer: {
    readonly onKeyDown: (evento: React.KeyboardEvent<HTMLElement>) => void;
  };
  readonly propsLinha: (id: string) => {
    readonly ref: (el: HTMLElement | null) => void;
    readonly tabIndex: 0 | -1;
    readonly 'data-linha': string;
    readonly onFocus: () => void;
  };
};

const CONTROLES = 'input, select, textarea, button, a, summary, [contenteditable="true"]';

/**
 * A navegação do menu de tela: `↑↓` escolhem a linha, `←→` ajustam, `Enter`
 * continua.
 *
 * # Roving focus, e por quê não `tabindex=0` em tudo
 *
 * Só UMA linha entra na ordem de tabulação. Quem navega por Tab atravessa o
 * menu inteiro numa parada e sai dele, em vez de tabular por cada linha e
 * depois por cada seta — é o padrão de `toolbar`/`listbox` da WAI-ARIA, e é o
 * que faz as setas terem significado.
 *
 * O foco DOM acompanha a seleção: o anel de foco e a linha destacada são a
 * mesma coisa, então não existe "selecionado" invisível para o leitor de tela.
 *
 * Os botões ◀ ▶ do menu são para o mouse e o toque (`tabindex=-1`): o teclado
 * ajusta pela própria linha.
 */
export function useMenuOsd({ ids, aoAjustar, aoConfirmar, global = false }: Opcoes): MenuOsd {
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const elementos = useRef(new Map<string, HTMLElement>());

  // Se a linha escolhida saiu do menu, o foco volta para a primeira.
  const ativo = escolhido !== null && ids.includes(escolhido) ? escolhido : (ids[0] ?? null);

  const ajustar = useRef(aoAjustar);
  const confirmar = useRef(aoConfirmar);
  ajustar.current = aoAjustar;
  confirmar.current = aoConfirmar;

  const focar = useCallback((id: string) => {
    setEscolhido(id);
    elementos.current.get(id)?.focus();
  }, []);

  const mover = useCallback(
    (de: string, passo: number) => {
      const i = ids.indexOf(de);
      if (i < 0 || ids.length === 0) return;
      const alvo = ids[(i + passo + ids.length) % ids.length];
      if (alvo !== undefined) focar(alvo);
    },
    [ids, focar],
  );

  const tratar = useCallback(
    (tecla: string, id: string): boolean => {
      switch (tecla) {
        case 'ArrowDown':
          mover(id, 1);
          return true;
        case 'ArrowUp':
          mover(id, -1);
          return true;
        case 'Home': {
          const primeiro = ids[0];
          if (primeiro !== undefined) focar(primeiro);
          return true;
        }
        case 'End': {
          const ultimo = ids[ids.length - 1];
          if (ultimo !== undefined) focar(ultimo);
          return true;
        }
        case 'ArrowLeft':
          ajustar.current(id, -1);
          return true;
        case 'ArrowRight':
          ajustar.current(id, 1);
          return true;
        default:
          return false;
      }
    },
    [ids, mover, focar],
  );

  const onKeyDown = useCallback(
    (evento: React.KeyboardEvent<HTMLElement>) => {
      if (evento.altKey || evento.ctrlKey || evento.metaKey) return;
      const linha = (evento.target as HTMLElement).closest<HTMLElement>('[data-linha]');
      const id = linha?.dataset['linha'];
      if (linha === null || id === undefined) return;

      if (evento.key === 'Enter' && evento.target === linha && confirmar.current !== undefined) {
        evento.preventDefault();
        confirmar.current();
        return;
      }
      if (tratar(evento.key, id)) evento.preventDefault();
    },
    [tratar],
  );

  // Teclas com o foco solto na página: entram no menu e já agem.
  useEffect(() => {
    if (!global || ids.length === 0) return;
    const aoTeclar = (evento: KeyboardEvent) => {
      if (evento.defaultPrevented || evento.altKey || evento.ctrlKey || evento.metaKey) return;
      const alvo = evento.target as HTMLElement | null;
      if (alvo !== null && alvo !== document.body && alvo.closest(CONTROLES) !== null) return;
      if (document.querySelector('dialog[open]') !== null) return;

      if (evento.key === 'Enter') {
        if (confirmar.current === undefined) return;
        evento.preventDefault();
        confirmar.current();
        return;
      }
      const inicial = escolhido !== null && ids.includes(escolhido) ? escolhido : ids[0];
      if (inicial === undefined) return;
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(evento.key)) return;
      evento.preventDefault();
      // Setas verticais só ENTRAM no menu; as horizontais ajustam a linha.
      if (evento.key === 'ArrowDown' || evento.key === 'ArrowUp') {
        focar(inicial);
        return;
      }
      focar(inicial);
      tratar(evento.key, inicial);
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [global, ids, escolhido, focar, tratar]);

  const propsLinha = useCallback(
    (id: string) => ({
      ref: (el: HTMLElement | null) => {
        if (el === null) elementos.current.delete(id);
        else elementos.current.set(id, el);
      },
      tabIndex: (id === ativo ? 0 : -1) as 0 | -1,
      'data-linha': id,
      onFocus: () => setEscolhido(id),
    }),
    [ativo],
  );

  return useMemo(
    () => ({
      ativo,
      posicao: ativo === null || ids.length === 0 ? '' : `${ids.indexOf(ativo) + 1}/${ids.length}`,
      selecionar: focar,
      propsContainer: { onKeyDown },
      propsLinha,
    }),
    [ativo, ids, focar, onKeyDown, propsLinha],
  );
}
