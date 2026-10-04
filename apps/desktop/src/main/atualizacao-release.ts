/**
 * De onde vem uma atualização do Tela Desktop, puro.
 *
 * As versões saem como pré-releases do GitHub numa tag `desktop-vX.Y.Z[-beta.N]`
 * (electron-builder.yml, `publish`). O `GitHubProvider` do electron-updater
 * 6.8.9 IGNORA `tagNamePrefix` — o campo só vale para publicar — e descarta
 * toda tag que `semver.valid` não aceite, e `desktop-v0.1.0-beta.7` não é
 * semver: com o provider `github`, o app jamais acharia o release. Por isso o
 * main resolve a tag aqui (lista de releases da API) e entrega ao updater o
 * provider `generic` apontando para a pasta de downloads DAQUELA tag, onde
 * estão o `latest.yml`/`latest-linux.yml` e os instaladores.
 */

/** Dono e repositório: os mesmos de `publish` em electron-builder.yml (conferido por teste). */
export const DONO = 'joaoviitorsx';
export const REPOSITORIO = 'Tela';
export const PREFIXO_DA_TAG = 'desktop-v';

export const URL_DA_LISTA_DE_RELEASES = `https://api.github.com/repos/${DONO}/${REPOSITORIO}/releases?per_page=30`;

/** A lista de releases de um repositório público tem poucas dezenas de KB; o teto só barra lixo. */
export const TAMANHO_MAXIMO_DA_LISTA = 1024 * 1024;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

type Versao = {
  readonly nucleo: readonly [number, number, number];
  readonly pre: readonly string[];
};

function analisar(texto: string): Versao | null {
  const m = SEMVER.exec(texto);
  if (m === null) return null;
  return {
    nucleo: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split('.'),
  };
}

const NUMERICO = /^\d+$/;

/** Ordem do semver 2.0: sem pré-release vence com pré-release; `beta.10` > `beta.9`. */
function comparar(a: Versao, b: Versao): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a.nucleo[i] ?? 0) - (b.nucleo[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = NUMERICO.test(x);
    const ny = NUMERICO.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `versão` é mais nova que `atual`? Versão que não é semver nunca é "mais nova". */
export function ehMaisNova(versao: string, atual: string): boolean {
  const a = analisar(versao);
  const b = analisar(atual);
  return a !== null && b !== null && comparar(a, b) > 0;
}

export type ReleaseDoApp = {
  /** `desktop-v0.1.0-beta.7` */
  readonly tag: string;
  /** `0.1.0-beta.7` */
  readonly versao: string;
};

/**
 * A lista de releases da API (`unknown`, vem da rede) → a MAIS NOVA entre as
 * tags `desktop-v…` publicadas (rascunho não conta: o `latest.yml` pode ainda
 * não estar lá). `null` = nenhuma, ou resposta que não é uma lista de releases.
 * Pré-release vale: as betas são pré-releases.
 */
export function releaseMaisNova(bruto: unknown): ReleaseDoApp | null {
  if (!Array.isArray(bruto)) return null;
  let melhor: { release: ReleaseDoApp; versao: Versao } | null = null;
  for (const item of bruto as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r['draft'] !== false || typeof r['tag_name'] !== 'string') continue;
    const tag = r['tag_name'];
    if (!tag.startsWith(PREFIXO_DA_TAG)) continue;
    const texto = tag.slice(PREFIXO_DA_TAG.length);
    const versao = analisar(texto);
    if (versao === null) continue;
    if (melhor === null || comparar(versao, melhor.versao) > 0) {
      melhor = { release: { tag, versao: texto }, versao };
    }
  }
  return melhor === null ? null : melhor.release;
}

/** O texto da resposta da API → a release mais nova. JSON quebrado ou grande demais = `null`. */
export function releaseMaisNovaDoTexto(texto: string): ReleaseDoApp | null {
  if (texto.length > TAMANHO_MAXIMO_DA_LISTA) return null;
  try {
    return releaseMaisNova(JSON.parse(texto) as unknown);
  } catch {
    return null;
  }
}

/**
 * A pasta de downloads de uma release, de onde o provider `generic` lê o
 * `latest*.yml`. HTTPS, host e caminho fixos: só a tag varia, e ela já passou
 * por `releaseMaisNova` (semver depois do prefixo — nada de `/`, `?` ou `..`).
 */
export function urlDoFeed(release: ReleaseDoApp): string {
  return `https://github.com/${DONO}/${REPOSITORIO}/releases/download/${release.tag}/`;
}

/** A página da release: o que o deb/rpm abre para o usuário baixar o pacote novo. */
export function urlDaPaginaDoRelease(release: ReleaseDoApp): string {
  return `https://github.com/${DONO}/${REPOSITORIO}/releases/tag/${release.tag}`;
}

/**
 * Como esta instalação se atualiza:
 *  - `automatica`: Windows (NSIS) e AppImage — o electron-updater baixa e instala;
 *  - `avisar`: deb/rpm (Linux fora de AppImage) — instalar pacote exige o
 *    gerenciador do sistema, então o app só diz que há versão nova e leva à página;
 *  - `desligada`: fora do pacote (desenvolvimento), macOS (sem build), ou
 *    `TELA_ATUALIZACAO=0` (o smoke do binário empacotado não vai à rede).
 */
export type ModoDeAtualizacao = 'automatica' | 'avisar' | 'desligada';

export function modoDeAtualizacao(entrada: {
  readonly plataforma: NodeJS.Platform;
  readonly empacotado: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ModoDeAtualizacao {
  if (!entrada.empacotado || entrada.env['TELA_ATUALIZACAO'] === '0') return 'desligada';
  if (entrada.plataforma === 'win32') return 'automatica';
  if (entrada.plataforma === 'linux') {
    // Só AppImage atualiza sozinho. O runtime do AppImage põe DOIS env: `APPIMAGE`
    // (caminho do arquivo) e `APPDIR` (o squashfs montado). deb e rpm não têm
    // nenhum. Exigir os dois: uma única var `APPIMAGE` vazada no ambiente de um
    // deb/rpm não deve ligar a atualização automática (que no Linux pode cair
    // num install privilegiado) — U-2 da auditoria.
    const appimage = entrada.env['APPIMAGE'];
    const appdir = entrada.env['APPDIR'];
    const ehAppImage = appimage !== undefined && appimage !== '' && appdir !== undefined && appdir !== '';
    return ehAppImage ? 'automatica' : 'avisar';
  }
  return 'desligada';
}

/** Uma linha, sem pilha nem caminho do disco: é o que o AJUSTES mostra. */
export function mensagemDeErro(erro: unknown): string {
  const bruta = erro instanceof Error ? erro.message : String(erro);
  const linha = (bruta.split('\n')[0] ?? '').trim();
  return linha === '' ? 'erro desconhecido' : linha.length > 160 ? `${linha.slice(0, 157)}...` : linha;
}
