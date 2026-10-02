import type { AmbienteDoNavegador, ResultadoDaTentativa } from '../domain/abrir-no-app.js';

/**
 * Lançar o app pelo link `tela://` e descobrir se ele abriu.
 *
 * O navegador não responde "abriu?"; a única pista é a página perder o foco.
 * O adapter faz a observação, o núcleo só decide em cima do resultado.
 */
export type AbrirNoApp = {
  ambiente(): AmbienteDoNavegador;
  /** Resolve em no máximo `PRAZO_DA_TENTATIVA_MS`; nunca rejeita. */
  tentar(slug: string): Promise<ResultadoDaTentativa>;
};

/** "Este aparelho não tem o app": lembrado entre visitas. */
export type MarcaSemApp = {
  ler(): boolean;
  gravar(): void;
  limpar(): void;
};
