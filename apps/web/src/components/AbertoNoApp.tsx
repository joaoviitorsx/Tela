import { Botao } from './Botao.js';
import { Led } from './Led.js';
import { Marca } from './Marca.js';

type Props = {
  readonly slug: string;
  /** `tentando`: esperando o app responder. `aberto`: o app assumiu o canal. */
  readonly estado: 'tentando' | 'aberto';
  readonly aoContinuarNoNavegador: () => void;
};

/**
 * A tela de quem foi mandado para o app (PLANO-desktop §14).
 *
 * Enquanto esta tela existe o navegador NÃO está conectado ao canal: a mesma
 * pessoa ocuparia duas vagas da sala. Por isso o botão diz o que ele faz — vai
 * conectar AQUI — e `aberto` explica que o vídeo está na outra janela.
 */
export function AbertoNoApp({ slug, estado, aoContinuarNoNavegador }: Props) {
  const aberto = estado === 'aberto';
  return (
    <div className="chiado-suave relative flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="absolute left-4 top-4 sm:left-6 sm:top-5">
        <Marca tamanho="pequeno" />
      </div>
      <section
        role="status"
        aria-live="polite"
        className="acima-do-crt entra w-full max-w-[680px] overflow-hidden border-2 border-edge bg-[rgb(8_8_10_/_0.94)] shadow-[0_0_0_2px_#000]"
      >
        <div className="flex flex-col items-center gap-5 px-5 py-9 text-center sm:px-8 sm:py-11">
          <p className="flex items-center gap-2.5 font-[family-name:var(--font-pixel)] text-[13px] text-muted">
            <Led cor={aberto ? 'ok' : 'branco'} pisca={!aberto} />
            <span>{aberto ? 'ABERTO NO APP' : 'ABRINDO NO APP…'}</span>
          </p>
          <h1 className="numeral m-0 max-w-full truncate text-[clamp(38px,9vw,64px)] text-accent-hi [text-shadow:0_0_18px_rgb(242_169_59_/_0.4)]">
            <span className="text-dim">tela.gg/</span>
            {slug}
          </h1>
          <p className="m-0 max-w-[46ch] text-[12.5px] leading-relaxed text-muted [text-wrap:pretty]">
            {aberto
              ? 'O canal está aberto no Tela Desktop. Esta aba não está conectada à transmissão, então você não ocupa duas vagas.'
              : 'Se o Tela estiver instalado, ele abre sozinho. Se não abrir, a transmissão continua aqui em instantes.'}
          </p>
          <Botao tom={aberto ? 'padrao' : 'primaria'} onClick={aoContinuarNoNavegador}>
            CONTINUAR NO NAVEGADOR
          </Botao>
        </div>
      </section>
    </div>
  );
}
