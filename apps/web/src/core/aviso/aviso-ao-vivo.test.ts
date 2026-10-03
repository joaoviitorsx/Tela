import { describe, expect, it } from 'vitest';
import { err, ok } from '../domain/result.js';
import type { MensagemDoWebhook, WebhookDiscord } from '../domain/webhook-discord.js';
import type { ErroDoAviso, PortaDoAvisoDiscord } from '../ports/aviso-discord.js';
import { FakeStorage } from '../testing/fakes.js';
import { AvisoAoVivo, REAPROVEITAR_MS } from './aviso-ao-vivo.js';

const URL_OK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF123_-abcDEF123_-abcDEF123_-xyz';
const LINK = 'https://tela.gg/soumbra';

type Chamada =
  | { readonly tipo: 'publicar'; readonly titulo: string | undefined }
  | { readonly tipo: 'editar'; readonly id: string; readonly titulo: string | undefined; readonly aoSair: boolean };

function montar(opcoes: { falhaPublicar?: ErroDoAviso; falhaEditar?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  let proximo = 1;
  let agora = 1_000_000;
  const porta: PortaDoAvisoDiscord = {
    async publicar(_w: WebhookDiscord, corpo: MensagemDoWebhook) {
      chamadas.push({ tipo: 'publicar', titulo: corpo.embeds[0]?.title });
      if (opcoes.falhaPublicar !== undefined) return err(opcoes.falhaPublicar);
      return ok({ mensagemId: `m${proximo++}` });
    },
    async editar(_w, id, corpo, o) {
      chamadas.push({ tipo: 'editar', id, titulo: corpo.embeds[0]?.title, aoSair: o?.aoSair === true });
      return opcoes.falhaEditar === true ? err('RECUSADO') : ok(undefined);
    },
  };
  const storage = new FakeStorage();
  const aviso = new AvisoAoVivo({ porta, storage, agora: () => agora });
  return { aviso, chamadas, storage, passar: (ms: number) => (agora += ms) };
}

describe('AvisoAoVivo', () => {
  it('sem webhook não avisa nada', async () => {
    const t = montar();
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.chamadas).toEqual([]);
    expect(t.aviso.getEstado()).toEqual({ fase: 'sem-webhook' });
  });

  it('webhook inválido não é salvo', () => {
    const t = montar();
    expect(t.aviso.salvar('https://evil.com/x').ok).toBe(false);
    expect(t.aviso.config()).toBeNull();
  });

  it('entra no ar: posta; sai: edita a MESMA mensagem para encerrada', async () => {
    const t = montar();
    t.aviso.salvar(URL_OK);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.aviso.getEstado()).toEqual({ fase: 'avisado', canal: 'soumbra' });
    t.passar(72 * 60_000);
    await t.aviso.aoSair();
    expect(t.chamadas).toEqual([
      { tipo: 'publicar', titulo: 'soumbra está AO VIVO' },
      { tipo: 'editar', id: 'm1', titulo: 'soumbra · transmissão encerrada', aoSair: true },
    ]);
  });

  it('caiu e voltou logo: reaproveita a mensagem; muito depois: posta outra', async () => {
    const t = montar();
    t.aviso.salvar(URL_OK);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    await t.aviso.aoSair();
    t.passar(2 * 60_000);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.chamadas.at(-1)).toEqual({ tipo: 'editar', id: 'm1', titulo: 'soumbra está AO VIVO', aoSair: false });

    await t.aviso.aoSair();
    t.passar(REAPROVEITAR_MS + 1);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.chamadas.at(-1)).toEqual({ tipo: 'publicar', titulo: 'soumbra está AO VIVO' });
  });

  it('mensagem antiga apagada: a edição falha e posta uma nova', async () => {
    const t = montar();
    t.aviso.salvar(URL_OK);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    await t.aviso.aoSair();
    const falha = montar({ falhaEditar: true });
    falha.storage.rows.clear();
    for (const [k, v] of t.storage.rows) falha.storage.set(k, v);
    await falha.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(falha.chamadas.map((c) => c.tipo)).toEqual(['editar', 'publicar']);
  });

  it('desligado não avisa; AVISAR AGORA avisa a transmissão em curso uma vez', async () => {
    const t = montar();
    t.aviso.salvar(URL_OK);
    t.aviso.ligar(false);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.chamadas).toEqual([]);
    expect(t.aviso.getEstado()).toEqual({ fase: 'desligado' });
    t.aviso.ligar(true);
    await t.aviso.avisarAgora();
    await t.aviso.avisarAgora();
    expect(t.chamadas).toEqual([{ tipo: 'publicar', titulo: 'soumbra está AO VIVO' }]);
  });

  it('o Discord recusou: o estado diz', async () => {
    const t = montar({ falhaPublicar: 'RECUSADO' });
    t.aviso.salvar(URL_OK);
    await t.aviso.aoEntrarNoAr('soumbra', LINK);
    expect(t.aviso.getEstado()).toEqual({ fase: 'falhou', erro: 'RECUSADO' });
  });

  it('testar sem webhook é erro; com webhook, publica a mensagem de teste', async () => {
    const t = montar();
    expect(await t.aviso.testar('https://tela.gg')).toEqual({ ok: false, error: 'SEM_WEBHOOK' });
    t.aviso.salvar(URL_OK);
    expect((await t.aviso.testar('https://tela.gg')).ok).toBe(true);
    expect(t.chamadas).toEqual([{ tipo: 'publicar', titulo: 'Tela conectado a este canal' }]);
  });

  it('remover apaga o webhook guardado', () => {
    const t = montar();
    t.aviso.salvar(URL_OK);
    t.aviso.remover();
    expect(t.aviso.config()).toBeNull();
    expect(t.storage.rows.size).toBe(0);
  });
});
