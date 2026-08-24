/**
 * Existe WebGL neste navegador? (§2, passo 3.)
 *
 * # Por que isto NÃO cria um contexto
 *
 * A primeira versão criava um canvas descartável e pedia `getContext('webgl')`.
 * Medido, num Chrome headless: **189 ms**. Criar o primeiro contexto de uma aba
 * paga o aperto de mão com o processo de GPU, e esse custo é do navegador, não
 * da máquina. O passo 5 da §2 reprova a sondagem inteira acima de 150 ms — ou
 * seja, perguntar "tem WebGL?" bastava para a abertura nunca aparecer.
 *
 * Aqui a pergunta é respondida por presença de construtor, que custa
 * microssegundos. A resposta DE VERDADE vem depois, de graça: se o contexto não
 * puder ser criado, `abrirPalco` rejeita e a abertura some sem barulho. Um
 * navegador que tem `WebGLRenderingContext` e mesmo assim falha em abrir
 * contexto existe — é o caso de GPU em lista negra — e ele cai nesse caminho.
 */
export function suportaWebGL(): boolean {
  return 'WebGLRenderingContext' in window || 'WebGL2RenderingContext' in window;
}
