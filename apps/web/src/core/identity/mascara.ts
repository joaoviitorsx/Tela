/**
 * O código do canal sem mostrar o código (R-01). Fica a quantidade de pontos
 * de sempre (não revela o tamanho exato) e o último caractere, o bastante para
 * a pessoa reconhecer o que guardou sem expor o resto a quem olha a tela.
 */
const PONTOS = 13;

export function mascararCodigo(codigo: string): string {
  if (codigo.length === 0) return '';
  return `${'•'.repeat(PONTOS)} ${codigo.slice(-1)}`;
}
