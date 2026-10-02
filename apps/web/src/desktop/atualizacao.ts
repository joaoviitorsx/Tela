import type { EstadoDaAtualizacao } from './ponte.js';

/**
 * Os textos da atualização no AJUSTES (D5), puros: o estado vem calculado do
 * main (`atualizacao-politica.ts`), aqui só vira frase.
 */

export type LinhaDeAtualizacao = {
  /** Tom da linha: `erro` pinta de perigo, `pronta` de destaque. */
  readonly tom: 'neutro' | 'pronta' | 'erro';
  readonly texto: string;
};

export function linhaDeAtualizacao(e: EstadoDaAtualizacao): LinhaDeAtualizacao {
  switch (e.fase) {
    case 'desligada':
      return { tom: 'neutro', texto: 'Atualização indisponível nesta execução (fora do app instalado).' };
    case 'em-dia':
      return { tom: 'neutro', texto: 'Em dia.' };
    case 'verificando':
      return { tom: 'neutro', texto: 'Verificando...' };
    case 'baixando':
      return { tom: 'neutro', texto: `Baixando ${e.versaoNova ?? 'atualização'} ${e.progresso ?? 0}%` };
    case 'pronta':
      return {
        tom: 'pronta',
        texto: e.podeReiniciar
          ? `${e.versaoNova ?? 'Atualização'} pronta: reinicie para atualizar.`
          : `${e.versaoNova ?? 'Atualização'} pronta: instala quando você sair do Tela.`,
      };
    case 'disponivel':
      if (e.modo === 'avisar') {
        return {
          tom: 'pronta',
          texto: `Nova versão ${e.versaoNova ?? ''}. Este pacote (deb/rpm) não se atualiza sozinho: baixe o novo na página.`,
        };
      }
      return {
        tom: 'neutro',
        texto: e.adiada
          ? `Nova versão ${e.versaoNova ?? ''}: baixa quando a transmissão acabar.`
          : `Nova versão ${e.versaoNova ?? ''} disponível.`,
      };
    case 'erro':
      return { tom: 'erro', texto: `Não deu para atualizar: ${e.erro ?? 'erro desconhecido'}` };
  }
}

const dois = (n: number): string => String(n).padStart(2, '0');

/** "hoje às 14:32", "ontem às 09:05", "12/10 às 18:00" ou "nunca". */
export function ultimaVerificacao(ms: number | null, agora: number): string {
  if (ms === null) return 'nunca';
  const d = new Date(ms);
  const hoje = new Date(agora);
  const hora = `${dois(d.getHours())}:${dois(d.getMinutes())}`;
  const mesmoDia = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (mesmoDia(d, hoje)) return `hoje às ${hora}`;
  const ontem = new Date(agora);
  ontem.setDate(ontem.getDate() - 1);
  if (mesmoDia(d, ontem)) return `ontem às ${hora}`;
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)} às ${hora}`;
}
