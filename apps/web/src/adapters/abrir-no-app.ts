import {
  type AmbienteDoNavegador,
  linkDoApp,
  PRAZO_DA_TENTATIVA_MS,
  type ResultadoDaTentativa,
} from '../core/domain/abrir-no-app.js';
import type { AbrirNoApp } from '../core/ports/abrir-no-app.js';

type UserAgentData = { readonly platform?: string };

/**
 * Lança `tela://assistir/<canal>` num iframe invisível e observa o foco.
 *
 * Por que iframe e não `location.href`: num navegador sem o esquema registrado,
 * navegar a página para `tela://…` pode deixá-la em branco ou mostrar erro (o
 * Firefox antigo lançava exceção); no iframe o pior caso é nada acontecer, e a
 * página do espectador continua intacta.
 *
 * Como saber se abriu: o sistema entrega o foco ao app (ou o navegador abre o
 * "Abrir Tela?", que também o rouba). A página recebe `blur` e/ou
 * `visibilitychange` para `hidden` — qualquer um dos dois dentro do prazo vale
 * como "abriu". Sem nenhum, ninguém atendeu o esquema.
 *
 * Limites honestos, que a validação humana confere (docs/desktop/D8-assistir.md):
 * o Chrome pode se recusar a lançar esquema de um iframe sem gesto do usuário
 * (resultado: "não abriu", e o espectador vê pelo navegador, sem dano), e quem
 * cancela o diálogo "Abrir Tela?" já gerou o `blur` — o botão "continuar no
 * navegador" existe para esse caso.
 */
export function makeAbrirNoApp(
  janela: Window = window,
  prazoMs: number = PRAZO_DA_TENTATIVA_MS,
): AbrirNoApp {
  const documento = janela.document;

  return {
    ambiente(): AmbienteDoNavegador {
      const nav = janela.navigator as Navigator & { userAgentData?: UserAgentData };
      return {
        userAgent: nav.userAgent,
        plataforma: nav.userAgentData?.platform ?? null,
        dentroDoApp: janela.telaDesktop !== undefined,
        paginaEmFoco: documento.hasFocus(),
        automatizado: nav.webdriver === true,
      };
    },

    tentar(slug: string): Promise<ResultadoDaTentativa> {
      return new Promise((resolver) => {
        const quadro = documento.createElement('iframe');
        quadro.hidden = true;
        quadro.setAttribute('aria-hidden', 'true');
        quadro.tabIndex = -1;
        quadro.style.display = 'none';

        let terminou = false;
        const encerrar = (resultado: ResultadoDaTentativa): void => {
          if (terminou) return;
          terminou = true;
          janela.clearTimeout(relogio);
          janela.removeEventListener('blur', aoPerderFoco);
          documento.removeEventListener('visibilitychange', aoMudarVisibilidade);
          quadro.remove();
          resolver(resultado);
        };
        const aoPerderFoco = (): void => encerrar('abriu');
        const aoMudarVisibilidade = (): void => {
          if (documento.visibilityState === 'hidden') encerrar('abriu');
        };
        const relogio = janela.setTimeout(() => encerrar('nao-abriu'), prazoMs);

        janela.addEventListener('blur', aoPerderFoco);
        documento.addEventListener('visibilitychange', aoMudarVisibilidade);
        try {
          quadro.src = linkDoApp(slug);
          documento.body.appendChild(quadro);
        } catch {
          // Navegador que lança ao resolver o esquema: é "não abriu", não um erro.
          encerrar('nao-abriu');
        }
      });
    },
  };
}
