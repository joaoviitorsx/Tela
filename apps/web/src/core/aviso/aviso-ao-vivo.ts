import { Emitter } from '../emitter.js';
import { type Result, err, ok } from '../domain/result.js';
import {
  type WebhookDiscord,
  lerWebhook,
  mensagemAoVivo,
  mensagemDeTeste,
  mensagemEncerrada,
} from '../domain/webhook-discord.js';
import type { ErroDoAviso, PortaDoAvisoDiscord } from '../ports/aviso-discord.js';
import type { Storage } from '../ports/storage.js';

/**
 * O aviso automático no Discord: "fulano está AO VIVO" num canal do servidor
 * quando a transmissão sobe, e a MESMA mensagem editada para "encerrada"
 * quando ela acaba — o canal não fica com um AO VIVO velho.
 *
 * Caiu e voltou em menos de `REAPROVEITAR_MS`: a mensagem antiga volta a
 * dizer AO VIVO em vez de nascer outra. Uma queda de Wi-Fi não vira três
 * avisos seguidos.
 *
 * Sem React, sem `fetch`: quem fala com o Discord é a porta.
 */
export const CONFIG_KEY = 'tela.discord.aviso';
export const ULTIMO_KEY = 'tela.discord.ultimo';
export const REAPROVEITAR_MS = 10 * 60_000;

export type ConfigDoAviso = { readonly webhook: WebhookDiscord; readonly ativo: boolean };

export type EstadoDoAviso =
  | { readonly fase: 'sem-webhook' }
  | { readonly fase: 'desligado' }
  | { readonly fase: 'pronto' }
  | { readonly fase: 'enviando' }
  | { readonly fase: 'avisado'; readonly canal: string }
  | { readonly fase: 'falhou'; readonly erro: ErroDoAviso };

type Ultimo = { readonly canal: string; readonly webhookId: string; readonly mensagemId: string; readonly encerradoEm: number };
type NoAr = { readonly canal: string; readonly link: string; readonly inicio: number; mensagemId: string | null };

export type DepsDoAviso = {
  readonly porta: PortaDoAvisoDiscord;
  readonly storage: Storage;
  readonly agora: () => number;
};

function lerJson(storage: Storage, chave: string): unknown {
  try {
    return JSON.parse(storage.get(chave) ?? 'null');
  } catch {
    return null;
  }
}

export class AvisoAoVivo {
  private readonly emitter = new Emitter<{ estado: EstadoDoAviso }>();
  private noAr: NoAr | null = null;
  private estado: EstadoDoAviso;
  /** Pedidos ao Discord em voo — quem vai fechar o app espera por eles (`aguardar`). */
  private readonly emVoo = new Set<Promise<unknown>>();

  constructor(private readonly deps: DepsDoAviso) {
    this.estado = this.estadoEmRepouso();
  }

  getEstado(): EstadoDoAviso {
    return this.estado;
  }

  subscribe(ouvinte: () => void): () => void {
    return this.emitter.on('estado', ouvinte);
  }

  config(): ConfigDoAviso | null {
    const bruto = lerJson(this.deps.storage, CONFIG_KEY);
    if (typeof bruto !== 'object' || bruto === null) return null;
    const { id, token, ativo } = bruto as Record<string, unknown>;
    if (typeof id !== 'string' || typeof token !== 'string') return null;
    const w = lerWebhook(`https://discord.com/api/webhooks/${id}/${token}`);
    return w.ok ? { webhook: w.value, ativo: ativo !== false } : null;
  }

  /** Guarda o webhook colado e liga o aviso. */
  salvar(url: string): Result<void, 'WEBHOOK_INVALIDO'> {
    const w = lerWebhook(url);
    if (!w.ok) return w;
    this.gravar({ webhook: w.value, ativo: true });
    return ok(undefined);
  }

  ligar(ativo: boolean): void {
    const c = this.config();
    if (c !== null) this.gravar({ ...c, ativo });
  }

  remover(): void {
    // Mensagem no ar: vira "encerrada" ANTES de o webhook sumir — depois não há como editá-la.
    const c = this.config();
    const noAr = this.noAr;
    if (c !== null && noAr?.mensagemId != null) {
      void this.encerrarMensagem(c, noAr, noAr.mensagemId, { aoSair: false }, false);
      noAr.mensagemId = null;
    }
    this.deps.storage.remove(CONFIG_KEY);
    this.deps.storage.remove(ULTIMO_KEY);
    this.mudar(this.estadoEmRepouso());
  }

  /** Uma mensagem de teste: prova que o webhook funciona antes de precisar dele. */
  async testar(origem: string): Promise<Result<void, ErroDoAviso | 'SEM_WEBHOOK'>> {
    const c = this.config();
    if (c === null) return err('SEM_WEBHOOK');
    const r = await this.deps.porta.publicar(c.webhook, mensagemDeTeste(origem));
    return r.ok ? ok(undefined) : r;
  }

  /** A transmissão subiu. Avisa se o aviso estiver ligado. */
  async aoEntrarNoAr(canal: string, link: string): Promise<void> {
    if (this.noAr?.canal === canal) return;
    this.noAr = { canal, link, inicio: this.deps.agora(), mensagemId: null };
    const c = this.config();
    if (c === null || !c.ativo) return;
    await this.avisar(c);
  }

  /** "AVISAR AGORA": para quem configurou com a transmissão já no ar. */
  async avisarAgora(): Promise<void> {
    const c = this.config();
    if (c === null || this.noAr === null || this.noAr.mensagemId !== null) return;
    await this.avisar(c);
  }

  /** A transmissão acabou (ou a página está fechando): a mensagem vira "encerrada". */
  async aoSair(): Promise<void> {
    const noAr = this.noAr;
    this.noAr = null;
    const c = this.config();
    if (noAr === null || noAr.mensagemId === null || c === null) {
      this.mudar(this.estadoEmRepouso());
      return;
    }
    this.mudar(this.estadoEmRepouso());
    await this.encerrarMensagem(c, noAr, noAr.mensagemId, { aoSair: true });
  }

  /**
   * Espera os pedidos ao Discord em voo, no máximo `ms`. Quem fecha o app
   * chama antes de sair: sem isso a edição "encerrada" morria com o processo.
   */
  async aguardar(ms: number): Promise<void> {
    let relogio: ReturnType<typeof setTimeout> | undefined;
    let estourou = false;
    const prazo = new Promise<void>((r) => {
      relogio = setTimeout(() => {
        estourou = true;
        r();
      }, ms);
    });
    // Em laço: um pedido pode nascer de outro (o publicar que resolve depois
    // do fim dispara a edição "encerrada") — espera até esvaziar ou o prazo.
    while (this.emVoo.size > 0 && !estourou) {
      await Promise.race([Promise.allSettled([...this.emVoo]), prazo]);
    }
    if (relogio !== undefined) clearTimeout(relogio);
  }

  /** "Encerrada": edita a mensagem e a guarda para reaproveitar se voltar logo. */
  private encerrarMensagem(
    c: ConfigDoAviso,
    noAr: NoAr,
    mensagemId: string,
    o: { readonly aoSair: boolean },
    guardar = true,
  ): Promise<unknown> {
    const agora = this.deps.agora();
    if (guardar) {
      const ultimo: Ultimo = { canal: noAr.canal, webhookId: c.webhook.id, mensagemId, encerradoEm: agora };
      this.deps.storage.set(ULTIMO_KEY, JSON.stringify(ultimo));
    }
    return this.rastrear(
      this.deps.porta.editar(c.webhook, mensagemId, mensagemEncerrada(noAr.canal, noAr.link, agora - noAr.inicio), o),
    );
  }

  private rastrear<T>(p: Promise<T>): Promise<T> {
    this.emVoo.add(p);
    void p.finally(() => this.emVoo.delete(p));
    return p;
  }

  private async avisar(c: ConfigDoAviso): Promise<void> {
    const noAr = this.noAr;
    if (noAr === null) return;
    this.mudar({ fase: 'enviando' });
    const corpo = mensagemAoVivo(noAr.canal, noAr.link);

    const ultimo = this.ultimo();
    if (
      ultimo !== null &&
      ultimo.canal === noAr.canal &&
      ultimo.webhookId === c.webhook.id &&
      this.deps.agora() - ultimo.encerradoEm < REAPROVEITAR_MS
    ) {
      const editado = await this.rastrear(this.deps.porta.editar(c.webhook, ultimo.mensagemId, corpo));
      if (editado.ok) {
        this.confirmar(c, noAr, ultimo.mensagemId);
        return;
      }
      // Acabou, ou o webhook foi removido, enquanto tentava reaproveitar: não há o que anunciar.
      if (this.noAr !== noAr || this.config()?.webhook.id !== c.webhook.id) return;
    }

    const r = await this.rastrear(this.deps.porta.publicar(c.webhook, corpo));
    if (r.ok) this.confirmar(c, noAr, r.value.mensagemId);
    // Acabou enquanto o Discord respondia: a falha não é mais notícia.
    else if (this.noAr === noAr) this.mudar({ fase: 'falhou', erro: r.error });
  }

  private confirmar(c: ConfigDoAviso, noAr: NoAr, mensagemId: string): void {
    /*
      A transmissão acabou enquanto o Discord respondia: a mensagem acabou de
      nascer dizendo AO VIVO e ninguém mais vai editá-la. Encerra já.
    */
    /*
      O mesmo vale para REMOVER durante o envio: sem o webhook guardado,
      ninguém editaria a mensagem depois. Encerra com o webhook com que ela
      nasceu (o `c` capturado, ainda válido no Discord).
    */
    const removido = this.config()?.webhook.id !== c.webhook.id;
    if (this.noAr !== noAr || removido) {
      // Removido: encerra sem guardar nada para reaproveitar — "remover" apaga tudo.
      void this.encerrarMensagem(c, noAr, mensagemId, { aoSair: true }, !removido);
      if (this.noAr === noAr) this.mudar(this.estadoEmRepouso());
      return;
    }
    noAr.mensagemId = mensagemId;
    this.deps.storage.remove(ULTIMO_KEY);
    this.mudar({ fase: 'avisado', canal: noAr.canal });
  }

  private ultimo(): Ultimo | null {
    const bruto = lerJson(this.deps.storage, ULTIMO_KEY);
    if (typeof bruto !== 'object' || bruto === null) return null;
    const u = bruto as Record<string, unknown>;
    return typeof u['canal'] === 'string' &&
      typeof u['webhookId'] === 'string' &&
      typeof u['mensagemId'] === 'string' &&
      typeof u['encerradoEm'] === 'number'
      ? (u as Ultimo)
      : null;
  }

  private gravar(c: ConfigDoAviso): void {
    this.deps.storage.set(CONFIG_KEY, JSON.stringify({ id: c.webhook.id, token: c.webhook.token, ativo: c.ativo }));
    this.mudar(this.estadoEmRepouso());
  }

  private estadoEmRepouso(): EstadoDoAviso {
    const c = this.config();
    if (c === null) return { fase: 'sem-webhook' };
    if (!c.ativo) return { fase: 'desligado' };
    if (this.noAr?.mensagemId != null) return { fase: 'avisado', canal: this.noAr.canal };
    return { fase: 'pronto' };
  }

  private mudar(estado: EstadoDoAviso): void {
    this.estado = estado;
    this.emitter.emit('estado', estado);
  }
}
