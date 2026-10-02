/**
 * No lugar do campo do canal quando o navegador não captura a tela (celular,
 * quase todo navegador móvel): descobrir isso no passo 4, depois de três
 * telas, era o pior momento (B-06). Quem só vai assistir não perde nada.
 */
export function SemCaptura() {
  return (
    <div role="status" className="flex max-w-[560px] flex-col gap-4">
      <h1 id="titulo-canal" data-vidro="texto" className="rotulo m-0 !text-[13px] !text-warn">
        <span aria-hidden="true">! </span>PARA TRANSMITIR, USE UM COMPUTADOR
      </h1>
      <p className="m-0 text-[13px] leading-relaxed text-text [text-wrap:pretty]">
        Este navegador não consegue capturar a tela. Abra o Tela no Chrome ou no Firefox, num
        computador.
      </p>
      <p className="m-0 text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
        Para assistir, é só abrir o link que seu amigo mandou: funciona aqui, sem instalar nada.
      </p>
    </div>
  );
}
