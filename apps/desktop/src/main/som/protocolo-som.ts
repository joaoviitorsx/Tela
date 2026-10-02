/**
 * O que atravessa o IPC do som (D3) e o que o main aceita do renderer.
 *
 * As formas são CÓPIA do contrato em `apps/web/src/desktop/ponte.ts`
 * (`AppComSom`, `RespostaSomJogo`…): outra compilação, mesmos nomes.
 */
import { idDeAppValido } from './grafo-pw.js';

/** Um app para o seletor de "só o jogo". `icone` é um `data:image/png` ou `null`. */
export type AppComSomIpc = {
  readonly id: string;
  readonly nome: string;
  readonly tocando: boolean;
  readonly icone: string | null;
};

export type ErroSomJogo =
  /** Faltam as ferramentas (Linux) ou o componente / a versão do Windows. */
  | 'INDISPONIVEL'
  | 'APP_NAO_ENCONTRADO'
  | 'FALHOU'
  | 'OCUPADO';

/**
 * `jogo`: o componente que separa o som por programa existe? Vale para "só o
 * jogo" e para o "Sistema" (que separa a call do resto) — os dois dependem dele.
 */
export type CapacidadesDeSom = {
  readonly jogo: { readonly disponivel: boolean; readonly motivo: string | null };
};

/**
 * `monitor`: o som chega como dispositivo de entrada (Linux) — `descricao` é o
 * que o Chromium escreve no rótulo. `porta`: chega como PCM por uma
 * `MessagePort` marcada com `MARCA_DA_PORTA_SOM` e este `id` (Windows).
 */
export type RespostaSomJogo =
  | { readonly ok: true; readonly app: string; readonly via: 'entrada'; readonly descricao: string }
  | { readonly ok: true; readonly app: string; readonly via: 'porta'; readonly id: number }
  | { readonly ok: false; readonly erro: ErroSomJogo };

/**
 * O modo "Sistema" — tudo que toca, menos a call — chega como no "só o jogo":
 * `entrada` no Linux (a fonte virtual do sink Tela-Sistema), `porta` no
 * Windows (o PCM do process loopback que exclui o app de voz).
 */
export type RespostaSomSistema =
  | { readonly ok: true; readonly via: 'entrada'; readonly descricao: string }
  | {
      readonly ok: true;
      readonly via: 'porta';
      readonly id: number;
      /** Windows: o app de call deixado de fora (`Discord`), ou `null` se não achou nenhum. */
      readonly semCall?: string | null;
    }
  | { readonly ok: false; readonly erro: ErroSomJogo };

export type FimDoSomDoJogo = {
  readonly motivo: 'SINK_CAIU' | 'PROCESSO_ENCERROU' | 'COMPONENTE_CAIU';
};

/** `iniciarJogo(appId)` vindo do renderer: só o id, e só na forma conhecida. */
export function pedidoDeJogoValido(payload: unknown): string | null {
  return idDeAppValido(payload) ? payload : null;
}

/**
 * O Windows que sabe capturar o áudio de um processo: o `ActivateAudioInterfaceAsync`
 * com `PROCESS_LOOPBACK` chegou no Windows 10 versão 2004 (build 19041). A
 * amostra oficial da Microsoft pede 20348 (Server 2022 / Windows 11), mas o
 * que ela exige é a SDK do exemplo; a API em si responde desde a 2004 (é o
 * mínimo que o OBS e o Discord declaram). `os.release()` no Windows é
 * `10.0.<build>`.
 */
export const BUILD_MINIMA_DO_WINDOWS = 19041;

export function buildDoWindows(release: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(release);
  if (m === null) return null;
  const maior = Number(m[1]);
  const build = Number(m[3]);
  // Windows 10 e 11 se apresentam como 10.0.build; nada abaixo disso serve.
  if (maior < 10) return null;
  return build;
}

export function windowsSuportaLoopbackPorProcesso(release: string): boolean {
  const b = buildDoWindows(release);
  return b !== null && b >= BUILD_MINIMA_DO_WINDOWS;
}
