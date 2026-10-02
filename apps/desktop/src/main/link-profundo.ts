/**
 * O link profundo do app: `tela://assistir/<canal>` (PLANO-desktop §14).
 *
 * Quem recebe um `https://tela.gg/<canal>` no Discord e tem o app instalado
 * abre direto nele. O esquema chega ao processo por três caminhos — argv no
 * primeiro lançamento, `second-instance` (Windows/Linux) e `open-url` (macOS)
 * — e QUALQUER programa da máquina, ou uma página web, pode montá-lo. Por isso
 * a validação aqui é de forma estrita, pura e anterior a tudo: o link só
 * ABRE UM CANAL. Nunca inicia captura nem transmissão, e nada do que vem
 * depois do slug tem efeito.
 */

export const ESQUEMA_LINK = 'tela';

/**
 * A MESMA regra do roteador do site (`apps/web/src/router.ts`, `SLUG_RE`, que
 * por sua vez é a de `@tela/shared`). O main é outra compilação e não importa
 * de lá; se a regra mudar, mude nos dois — o teste daqui fixa o formato.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,23}[a-z0-9]$/;

/** Rotas do site que o roteador resolve ANTES de olhar o slug: não são canais. */
const RESERVADOS: ReadonlySet<string> = new Set(['transmitir', 'recuperar']);

/** Uma URL de lançamento de verdade tem dezenas de caracteres; acima disso é carga. */
const TAMANHO_MAXIMO = 256;

/**
 * `tela://assistir/<slug>` e nada mais: esquema e "host" sem diferenciar
 * caixa (os navegadores e o Windows normalizam), uma barra final opcional (o
 * Chromium a acrescenta ao entregar a URL ao sistema), e consulta/fragmento
 * descartados. Usuário, porta, segmentos extras e `%` não passam.
 */
const FORMA = /^tela:\/\/assistir\/([^/?#\s]+)\/?(?:[?#][^\s]*)?$/i;

/** O canal de um link `tela://assistir/<slug>`, ou `null` se não for exatamente isso. */
export function canalDoLinkProfundo(entrada: unknown): string | null {
  if (typeof entrada !== 'string' || entrada.length > TAMANHO_MAXIMO) return null;
  const achado = FORMA.exec(entrada);
  const bruto = achado?.[1];
  if (bruto === undefined) return null;
  const slug = bruto.toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVADOS.has(slug)) return null;
  return slug;
}

/** Tira as aspas que o Windows deixa em volta do argumento da linha de comando. */
function semAspas(arg: string): string {
  return arg.replace(/^["']+|["']+$/g, '');
}

/**
 * O canal de um link no argv do processo.
 *
 * Windows entrega `tela.exe -- "tela://assistir/jv"` (o Chromium registra o
 * comando com `--`), o Linux `tela tela://assistir/jv` (`%U` do `.desktop`),
 * o dev `electron . tela://…`. Procura o PRIMEIRO argumento que declara o
 * esquema, em qualquer posição e depois de qualquer `--`, e o valida: se ele
 * existir e for inválido, o resultado é `null` — não se continua procurando um
 * "mais bonzinho" depois de um suspeito.
 */
export function canalDoArgv(argv: readonly string[]): string | null {
  for (const bruto of argv) {
    const arg = semAspas(bruto);
    if (arg.toLowerCase().startsWith(`${ESQUEMA_LINK}:`)) return canalDoLinkProfundo(arg);
  }
  return null;
}

/**
 * Registrar o esquema no sistema muda o handler PADRÃO da máquina (no Linux,
 * `xdg-settings`; no Windows, o registro). Rodar `electron .` em desenvolvimento
 * ou o e2e não pode roubar o esquema do app instalado — então, sem decisão
 * explícita, só o app empacotado registra. `TELA_REGISTRAR_ESQUEMA=1` força
 * (para testar o link de ponta a ponta no dev), `0` proíbe.
 */
export function deveRegistrarEsquema(empacotado: boolean, env: Readonly<Record<string, string | undefined>>): boolean {
  const decisao = env['TELA_REGISTRAR_ESQUEMA'];
  if (decisao === '1') return true;
  if (decisao === '0') return false;
  return empacotado;
}

/**
 * Argumentos de `setAsDefaultProtocolClient`. Em dev (`process.defaultApp`) o
 * executável é o `electron` genérico e o sistema precisa de quem abrir: o
 * caminho do app vai junto, como a documentação do Electron manda. Empacotado,
 * nada — o executável já é o Tela.
 */
export function argumentosDoRegistro(
  defaultApp: boolean,
  argv: readonly string[],
  resolver: (caminho: string) => string,
): readonly string[] | null {
  if (!defaultApp) return null;
  const app = argv[1];
  return app === undefined ? null : [resolver(app)];
}
