/**
 * O som do jogo, ligado ao Electron (D3): escolhe a implementação da
 * plataforma, sobe o utility process no Windows e entrega as portas.
 *
 * Fino de propósito — a lógica de cada plataforma está em `som-jogo-linux.ts`
 * e `som-jogo-windows.ts`, testadas com processos de mentira; aqui só se
 * embrulha `utilityProcess` e `MessageChannelMain` e se traduz o resultado
 * para o que atravessa o IPC (`protocolo-som.ts`).
 */
import { release } from 'node:os';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, MessageChannelMain, type MessagePortMain, type NativeImage, utilityProcess, type WebContents } from 'electron';
import { type ArmazemDoRegistro, efeitosLinux } from './efeitos-linux.js';
import {
  type AppComSomIpc,
  type CapacidadesDeSom,
  type FimDoSomDoJogo,
  pedidoDeJogoValido,
  type RespostaSomJogo,
  type RespostaSomSistema,
} from './protocolo-som.js';
import { SomDoJogoLinux } from './som-jogo-linux.js';
import { type ProcessoUtilitario, SomDoJogoWindows } from './som-jogo-windows.js';

export type OpcoesDoSom = {
  /** `dist/main` — de onde vem o `utilitario-win.js`. */
  readonly pastaDoMain: string;
  /** Avisa a página que o som do jogo parou sem ela pedir. */
  readonly avisarEncerrou: (conteudo: WebContents, fim: FimDoSomDoJogo) => void;
  /** O canal IPC em que a porta do PCM chega à página. */
  readonly canalDaPorta: string;
};

export type SomDoApp = {
  capacidades(): Promise<CapacidadesDeSom>;
  listarApps(): Promise<readonly AppComSomIpc[]>;
  iniciarJogo(conteudo: WebContents, payload: unknown): Promise<RespostaSomJogo>;
  iniciarSistema(conteudo: WebContents): Promise<RespostaSomSistema>;
  parar(): Promise<void>;
  limparResiduos(): Promise<void>;
  ativo(): boolean;
};

/** Pids do próprio Tela (janela, GPU, utilitários): o áudio deles não é "o jogo". */
function pidsDoTela(): ReadonlySet<number> {
  return new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
}

function existe(caminho: string): boolean {
  try {
    return statSync(caminho).isFile();
  } catch {
    return false;
  }
}

function iconeEmDataUrl(imagem: NativeImage): string | null {
  return imagem.isEmpty() ? null : `data:image/png;base64,${imagem.toPNG().toString('base64')}`;
}

export function criarSomDoApp(opcoes: OpcoesDoSom): SomDoApp {
  if (process.platform === 'linux') return somLinux(opcoes);
  if (process.platform === 'win32') return somWindows(opcoes);
  const indisponivel = { disponivel: false, motivo: 'Só o jogo ainda não existe nesta plataforma.' } as const;
  return {
    capacidades: () => Promise.resolve({ jogo: indisponivel }),
    listarApps: () => Promise.resolve([]),
    iniciarJogo: () => Promise.resolve({ ok: false, erro: 'INDISPONIVEL' }),
    iniciarSistema: () => Promise.resolve({ ok: false, erro: 'INDISPONIVEL' }),
    parar: () => Promise.resolve(),
    limparResiduos: () => Promise.resolve(),
    ativo: () => false,
  };
}

/* ---------------------------------------------------------------- Linux */

/** Os `pw-loopback` que este app subiu (S-12), em `userData`, só do dono. */
function armazemDoRegistro(): ArmazemDoRegistro {
  const arquivo = join(app.getPath('userData'), 'som-filhos.json');
  return {
    ler: () => {
      try {
        return readFileSync(arquivo, 'utf8');
      } catch {
        return null;
      }
    },
    gravar: (texto) => {
      writeFileSync(arquivo, texto, { encoding: 'utf8', mode: 0o600 });
      chmodSync(arquivo, 0o600);
    },
  };
}

function somLinux(opcoes: OpcoesDoSom): SomDoApp {
  const som = new SomDoJogoLinux(efeitosLinux(pidsDoTela, armazemDoRegistro()));
  let disponibilidade: Promise<{ readonly disponivel: boolean; readonly motivo: string | null }> | null = null;
  return {
    // `--version` de três ferramentas: barato, mas não precisa repetir a cada abertura do seletor.
    capacidades: async () => ({ jogo: await (disponibilidade ??= som.disponibilidade()) }),
    listarApps: async () => (await som.listar())?.map((a) => ({ id: a.id, nome: a.nome, tocando: a.tocando, icone: null })) ?? [],
    async iniciarJogo(conteudo, payload) {
      const id = pedidoDeJogoValido(payload);
      if (id === null) return { ok: false, erro: 'APP_NAO_ENCONTRADO' };
      const r = await som.iniciar(id, {
        encerrou: (fim) => {
          if (!conteudo.isDestroyed()) opcoes.avisarEncerrou(conteudo, fim);
        },
      });
      return r.ok ? { ok: true, app: r.value.app, via: 'entrada', descricao: r.value.descricao } : { ok: false, erro: r.error };
    },
    async iniciarSistema(conteudo) {
      const r = await som.iniciarSistema({
        encerrou: (fim) => {
          if (!conteudo.isDestroyed()) opcoes.avisarEncerrou(conteudo, fim);
        },
      });
      return r.ok ? { ok: true, descricao: r.value.descricao } : { ok: false, erro: r.error };
    },
    parar: () => som.parar(),
    limparResiduos: async () => {
      const n = await som.limparResiduos();
      if (n > 0) console.warn(`[tela] som: ${n} resíduo(s) de uma execução anterior removido(s)`);
    },
    ativo: () => som.fase().fase !== 'ocioso',
  };
}

/* -------------------------------------------------------------- Windows */

function somWindows(opcoes: OpcoesDoSom): SomDoApp {
  const addon = app.isPackaged
    ? resolve(process.resourcesPath, 'native', 'wasapi_loopback.node')
    : resolve(opcoes.pastaDoMain, '../../native/wasapi-loopback/build/Release/wasapi_loopback.node');
  // Empacotado, o utility vai em `resources/som` (ver `electron-builder.yml`): fora do asar.
  const utilitario = app.isPackaged ? resolve(process.resourcesPath, 'som', 'utilitario-win.js') : resolve(opcoes.pastaDoMain, 'som', 'utilitario-win.js');

  const som = new SomDoJogoWindows<MessagePortMain>({
    forkUtilitario(): ProcessoUtilitario {
      const filho = utilityProcess.fork(utilitario, [`--addon=${addon}`], { serviceName: 'Tela som do jogo', stdio: 'inherit' });
      return {
        postMessage: (m, transferir) => filho.postMessage(m, transferir as MessagePortMain[] | undefined),
        aoMensagem: (o) => filho.on('message', o),
        aoSair: (o) => filho.on('exit', (codigo) => o(codigo)),
        kill: () => filho.kill(),
      };
    },
    criarCanal() {
      const { port1, port2 } = new MessageChannelMain();
      return {
        paraUtilitario: port1,
        paraRenderer: port2,
        fechar: () => {
          // `port2` já foi transferida à página quando tudo deu certo; fechar
          // uma porta transferida pode lançar, e não há o que fazer com isso.
          for (const p of [port1, port2]) {
            try {
              p.close();
            } catch {
              // já fechada
            }
          }
        },
      };
    },
    agendar: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    pidsDoTela,
    release,
    addonPresente: () => existe(addon),
  });

  const icones = new Map<string, string | null>();
  const iconeDe = async (caminho: string): Promise<string | null> => {
    if (icones.has(caminho)) return icones.get(caminho) ?? null;
    let url: string | null = null;
    try {
      url = iconeEmDataUrl(await app.getFileIcon(caminho, { size: 'normal' }));
    } catch {
      // Sem ícone o seletor desenha a inicial do nome.
    }
    icones.set(caminho, url);
    return url;
  };

  return {
    capacidades: async () => ({ jogo: await som.disponibilidade() }),
    async listarApps() {
      const apps = await som.listar();
      return Promise.all(apps.map(async (a) => ({ id: a.id, nome: a.nome, tocando: a.tocando, icone: await iconeDe(a.caminho) })));
    },
    async iniciarJogo(conteudo, payload) {
      const id = pedidoDeJogoValido(payload);
      if (id === null) return { ok: false, erro: 'APP_NAO_ENCONTRADO' };
      const r = await som.iniciar(id, {
        encerrou: (fim) => {
          if (!conteudo.isDestroyed()) opcoes.avisarEncerrou(conteudo, fim);
        },
      });
      if (!r.ok) return { ok: false, erro: r.error };
      if (conteudo.isDestroyed()) {
        void som.parar();
        return { ok: false, erro: 'FALHOU' };
      }
      // A porta do PCM vai direto à página; o main não vê os bytes.
      conteudo.postMessage(opcoes.canalDaPorta, { id: r.value.id }, [r.value.porta]);
      return { ok: true, app: r.value.app, via: 'porta', id: r.value.id };
    },
    // No Windows o som do sistema é o `loopback` do Electron, junto da tela.
    iniciarSistema: () => Promise.resolve({ ok: false, erro: 'INDISPONIVEL' }),
    parar: () => som.parar(),
    limparResiduos: () => Promise.resolve(),
    ativo: () => som.idAtivo() !== null,
  };
}
