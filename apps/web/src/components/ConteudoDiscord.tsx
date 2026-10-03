type Props = {
  /** Abre a instalação do app na conta da pessoa, no site do Discord. */
  readonly urlInstalar: string;
  /** O nome do canal, o que vai no `canal:` do comando. */
  readonly canal: string;
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
};

/**
 * "TELA NO DISCORD": o `/tela` em dois passos (docs/DISCORD.md §2).
 *
 * O app é instalado NA CONTA, não num servidor: a pessoa não precisa ser
 * administradora de nada, e o comando aparece em qualquer servidor, DM ou
 * grupo. O que ele faz e o que não faz fica escrito aqui, porque "adicionar
 * um app ao Discord" assusta quem já viu bot pedindo permissão de tudo.
 */
export function ConteudoDiscord({ urlInstalar, canal, copiado, aoCopiar }: Props) {
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-5">
      <p className="m-0 text-[12px] leading-relaxed text-muted [text-wrap:pretty]">
        Mande o canal na conversa com o estado ao vivo e um botão <strong className="text-text">ASSISTIR</strong>.
        O app só responde ao comando: não lê mensagens, não entra em call e não guarda nada.
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="rotulo m-0">1 · ADICIONAR AO DISCORD (UMA VEZ SÓ)</h3>
        <a
          href={urlInstalar}
          target="_blank"
          rel="noopener noreferrer"
          className="tecla tecla-primaria self-start"
        >
          ADICIONAR O TELA AO DISCORD
        </a>
        <p className="m-0 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          Abre o Discord: escolha <strong className="text-text">Adicionar aos meus apps</strong>. Fica na
          sua conta, sem permissão em servidor nenhum.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="rotulo m-0">2 · NA CONVERSA</h3>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-h-11 flex-1 border-2 border-edge bg-deep px-3 py-2.5 font-[family-name:var(--font-mono)] text-[13px] text-accent-hi">
            /tela canal:{canal}
          </code>
          <button type="button" onClick={aoCopiar} className="tecla">
            {copiado ? 'NOME COPIADO' : 'COPIAR NOME'}
          </button>
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
          Digite <strong className="text-text">/tela</strong>, escolha o do Tela e cole o nome no campo{' '}
          <strong className="text-text">canal</strong>. O comando pode levar alguns minutos para
          aparecer na primeira vez.
        </p>
      </section>

      <p className="m-0 border-t-2 border-line pt-3 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
        Sem instalar nada: colar o link do canal já mostra <strong className="text-text">AO VIVO</strong> e
        quantos assistem na prévia.
      </p>
    </div>
  );
}
