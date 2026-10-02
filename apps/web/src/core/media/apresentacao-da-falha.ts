import type { BroadcastFailure } from './broadcast-session.js';

/**
 * O que a tela de "acabou" diz para cada motivo (auditoria B-02, B-03, B-11).
 *
 * Um título por causa, porque o mesmo "SEM SINAL" para seis situações mandava
 * a pessoa fazer a coisa errada: "tentar de novo" num nome ocupado não resolve,
 * e cancelar o seletor de tela é escolha, não falha.
 *
 * `Record` sobre a união (R4): um motivo novo em `BroadcastFailure` quebra a
 * compilação aqui até alguém decidir o que mostrar.
 */
export type TomDaFalha =
  /** Fim normal: a TV desligando, sem alarme. */
  | 'normal'
  /** Escolha da pessoa ou algo que ela resolve: moldura âmbar, sem barras de teste. */
  | 'aviso'
  /** Falha técnica: barras de cor e chiado, o "fora do ar" de uma TV. */
  | 'falha';

/** O que o botão principal faz. `nenhuma`: insistir não muda a resposta. */
export type AcaoDaFalha = 'tentar-de-novo' | 'escolher-nome' | 'recarregar' | 'nenhuma';

export type ApresentacaoDaFalha = {
  readonly titulo: string;
  readonly mensagem: string;
  readonly tom: TomDaFalha;
  readonly acao: AcaoDaFalha;
  /** Rótulo do botão principal; vazio quando `acao` é `nenhuma`. */
  readonly rotuloAcao: string;
  /** "ver diagnóstico da tentativa" só onde há o que diagnosticar. */
  readonly comDiagnostico: boolean;
};

export const APRESENTACAO_DA_FALHA: Record<BroadcastFailure, ApresentacaoDaFalha> = {
  CAPTURE_DENIED: {
    titulo: 'COMPARTILHAMENTO CANCELADO',
    mensagem:
      'Você fechou a caixa de escolha sem selecionar uma tela, ou o navegador não deu permissão. Nada foi ao ar.',
    tom: 'aviso',
    acao: 'tentar-de-novo',
    rotuloAcao: 'ESCOLHER A TELA DE NOVO',
    comDiagnostico: false,
  },
  CAPTURE_FAILED: {
    titulo: 'NÃO FOI POSSÍVEL CAPTURAR A TELA',
    mensagem:
      'O navegador não conseguiu capturar a tela, e não foi escolha sua. Tente de novo; se repetir, feche outros programas que estejam gravando ou compartilhando a tela.',
    tom: 'falha',
    acao: 'tentar-de-novo',
    rotuloAcao: 'TENTAR DE NOVO',
    comDiagnostico: true,
  },
  CAPTURE_UNSUPPORTED: {
    titulo: 'ESTE NAVEGADOR NÃO CAPTURA A TELA',
    mensagem: 'Para transmitir, abra o Tela no Chrome ou no Firefox, num computador.',
    tom: 'falha',
    acao: 'nenhuma',
    rotuloAcao: '',
    comDiagnostico: false,
  },
  CAPTURE_ENDED: {
    titulo: 'COMPARTILHAMENTO ENCERRADO',
    mensagem:
      'O compartilhamento de tela parou (pelo aviso do navegador ou pelo sistema), e a transmissão acabou junto.',
    tom: 'aviso',
    acao: 'tentar-de-novo',
    rotuloAcao: 'ESCOLHER A TELA DE NOVO',
    comDiagnostico: false,
  },
  SLUG_TAKEN: {
    titulo: 'NOME EM USO',
    mensagem: 'Outra pessoa está no ar com esse nome. Escolha outro para o seu canal.',
    tom: 'aviso',
    acao: 'escolher-nome',
    rotuloAcao: 'ESCOLHER OUTRO NOME',
    comDiagnostico: false,
  },
  SLUG_INVALID: {
    titulo: 'NOME INVÁLIDO',
    mensagem: 'Esse nome de canal não é aceito. Use de 3 a 25 letras minúsculas, números e hífen.',
    tom: 'aviso',
    acao: 'escolher-nome',
    rotuloAcao: 'ESCOLHER OUTRO NOME',
    comDiagnostico: false,
  },
  RATE_LIMITED: {
    titulo: 'MUITAS TENTATIVAS',
    mensagem: 'Espere um minuto e tente de novo.',
    tom: 'aviso',
    acao: 'tentar-de-novo',
    rotuloAcao: 'TENTAR DE NOVO',
    comDiagnostico: false,
  },
  OUTDATED: {
    titulo: 'PÁGINA DESATUALIZADA',
    mensagem: 'O Tela foi atualizado desde que esta página abriu. Recarregue e transmita de novo.',
    tom: 'aviso',
    acao: 'recarregar',
    rotuloAcao: 'RECARREGAR A PÁGINA',
    comDiagnostico: false,
  },
  SIGNALING_UNAVAILABLE: {
    titulo: 'SEM CONEXÃO COM O TELA',
    mensagem:
      'Não foi possível falar com o servidor do Tela. Verifique a sua internet; extensões de privacidade e proxy também bloqueiam.',
    tom: 'falha',
    acao: 'tentar-de-novo',
    rotuloAcao: 'TENTAR DE NOVO',
    comDiagnostico: true,
  },
  TRANSPORT_FAILED: {
    titulo: 'A TRANSMISSÃO CAIU',
    mensagem: 'A conexão de vídeo com os seus amigos caiu. Transmita de novo para voltar ao ar.',
    tom: 'falha',
    acao: 'tentar-de-novo',
    rotuloAcao: 'TENTAR DE NOVO',
    comDiagnostico: true,
  },
  USER_STOPPED: {
    titulo: 'FIM DA TRANSMISSÃO',
    mensagem: 'Seus amigos já não recebem imagem. O link continua seu: é só transmitir de novo.',
    tom: 'normal',
    acao: 'tentar-de-novo',
    rotuloAcao: 'TRANSMITIR DE NOVO',
    comDiagnostico: false,
  },
};
