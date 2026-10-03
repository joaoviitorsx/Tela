/** O aviso automático por webhook (seção 3). Tudo pronto para desenhar. */
export type PropsDoAvisoAutomatico = {
  /** O webhook salvo, mascarado; `null` = nenhum. */
  readonly salvo: string | null;
  readonly ativo: boolean;
  /** Uma linha sobre o último envio; `null` = nada a dizer. */
  readonly status: { readonly texto: string; readonly tom: 'ok' | 'erro' | 'neutro' } | null;
  readonly entrada: string;
  readonly aoMudar: (v: string) => void;
  readonly erroEntrada: boolean;
  readonly aoSalvar: () => void;
  readonly aoTestar: () => void;
  readonly testando: boolean;
  readonly aoLigar: (ativo: boolean) => void;
  readonly aoRemover: () => void;
  /** Só com a transmissão no ar e ainda sem aviso nela. */
  readonly aoAvisarAgora: (() => void) | null;
};

type Props = {
  /** Abre a instalação do app na conta da pessoa, no site do Discord. */
  readonly urlInstalar: string;
  /** O nome do canal, o que vai no `canal:` do comando. */
  readonly canal: string;
  readonly copiado: boolean;
  readonly aoCopiar: () => void;
  readonly aviso: PropsDoAvisoAutomatico;
};

/**
 * "TELA NO DISCORD": o `/tela` em dois passos (docs/DISCORD.md §2).
 *
 * O app é instalado NA CONTA, não num servidor: a pessoa não precisa ser
 * administradora de nada, e o comando aparece em qualquer servidor, DM ou
 * grupo. O que ele faz e o que não faz fica escrito aqui, porque "adicionar
 * um app ao Discord" assusta quem já viu bot pedindo permissão de tudo.
 */
export function ConteudoDiscord({ urlInstalar, canal, copiado, aoCopiar, aviso }: Props) {
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

      <AvisoAutomatico {...aviso} />

      <p className="m-0 border-t-2 border-line pt-3 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
        Sem instalar nada: colar o link do canal já mostra <strong className="text-text">AO VIVO</strong> e
        quantos assistem na prévia.
      </p>
    </div>
  );
}

const TOM = { ok: 'text-ok', erro: 'text-warn', neutro: 'text-muted' } as const;

/**
 * "3 · AVISO AUTOMÁTICO": o Tela posta o link num canal do servidor quando a
 * transmissão sobe, e marca como encerrada quando acaba. Opcional — e o
 * caminho para achar o webhook está escrito, porque ninguém sabe de cabeça.
 */
function AvisoAutomatico(p: PropsDoAvisoAutomatico) {
  return (
    <section className="flex flex-col gap-2 border-t-2 border-line pt-4">
      <h3 className="rotulo m-0">3 · AVISO AUTOMÁTICO NUM CANAL (OPCIONAL)</h3>
      <p className="m-0 text-[11px] leading-relaxed text-muted [text-wrap:pretty]">
        Quando você entrar no ar, o Tela posta o link num canal do seu servidor, e marca como
        encerrada quando acabar. Precisa do webhook do canal:{' '}
        <strong className="text-text">Editar canal → Integrações → Webhooks → Novo webhook → Copiar URL</strong>. O
        endereço fica só neste aparelho e vai direto para o Discord.
      </p>

      {p.salvo === null ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            p.aoSalvar();
          }}
        >
          <input
            type="password"
            value={p.entrada}
            onChange={(e) => p.aoMudar(e.target.value)}
            placeholder="https://discord.com/api/webhooks/…"
            autoComplete="off"
            spellCheck={false}
            aria-label="URL do webhook do canal"
            aria-invalid={p.erroEntrada}
            className={[
              'min-h-11 min-w-0 flex-1 border-2 bg-deep px-3 font-[family-name:var(--font-mono)] text-[12px] text-accent-hi outline-none placeholder:text-faint focus:border-accent',
              p.erroEntrada ? 'border-danger-edge' : 'border-edge',
            ].join(' ')}
          />
          <button type="submit" className="tecla">
            SALVAR
          </button>
          {p.erroEntrada && (
            <p className="m-0 w-full text-[11px] text-warn">! Isso não é uma URL de webhook do Discord.</p>
          )}
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-h-11 min-w-0 flex-1 truncate border-2 border-edge bg-deep px-3 py-3 font-[family-name:var(--font-mono)] text-[11px] text-muted">
              {p.salvo}
            </code>
            <button
              type="button"
              onClick={() => p.aoLigar(!p.ativo)}
              aria-pressed={p.ativo}
              className={p.ativo ? 'tecla tecla-primaria' : 'tecla'}
            >
              {p.ativo ? 'AVISO LIGADO' : 'AVISO DESLIGADO'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {p.aoAvisarAgora !== null && (
              <button type="button" onClick={p.aoAvisarAgora} className="tecla tecla-primaria">
                AVISAR AGORA
              </button>
            )}
            <button type="button" onClick={p.aoTestar} disabled={p.testando} className="tecla">
              {p.testando ? 'TESTANDO…' : 'TESTAR'}
            </button>
            <button type="button" onClick={p.aoRemover} className="tecla">
              REMOVER
            </button>
          </div>
        </div>
      )}

      {p.status !== null && (
        <p role="status" className={`m-0 text-[11px] leading-relaxed ${TOM[p.status.tom]}`}>
          {p.status.texto}
        </p>
      )}
    </section>
  );
}
