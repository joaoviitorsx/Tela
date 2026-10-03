import { useCallback, useEffect, useRef, useState } from 'react';
import { ConteudoDiscord, type PropsDoAvisoAutomatico } from '../components/ConteudoDiscord.js';
import { Dialogo } from '../components/Dialogo.js';
import { avisoNoDiscord } from '../container.js';
import type { EstadoDoAviso } from '../core/aviso/aviso-ao-vivo.js';
import { webhookMascarado } from '../core/domain/webhook-discord.js';
import { useEstadoDoAviso } from '../react/use-aviso-no-discord.js';
import { useCopia } from '../react/use-copia.js';
import { useDialogo } from '../react/use-dialogo.js';

type Props = {
  readonly aberto: boolean;
  readonly aoFechar: () => void;
  readonly urlInstalar: string;
  readonly canal: string;
  /** O link público do canal: a origem dele é a do avatar e do teste (no app, `app://` não serve ao Discord). */
  readonly link: string;
};

const STATUS: Record<EstadoDoAviso['fase'], PropsDoAvisoAutomatico['status']> = {
  'sem-webhook': null,
  desligado: { texto: 'Desligado: ninguém é avisado quando você entra no ar.', tom: 'neutro' },
  pronto: { texto: 'Ligado: quando você entrar no ar, o aviso sai sozinho.', tom: 'neutro' },
  enviando: { texto: 'Avisando no canal…', tom: 'neutro' },
  avisado: { texto: 'Avisado no canal. A mensagem vira "encerrada" quando você sair.', tom: 'ok' },
  falhou: null,
};

function statusDe(estado: EstadoDoAviso): PropsDoAvisoAutomatico['status'] {
  if (estado.fase !== 'falhou') return STATUS[estado.fase];
  return estado.erro === 'RECUSADO'
    ? { texto: '! O Discord recusou o webhook. Ele foi apagado? Remova e cole outro.', tom: 'erro' }
    : { texto: '! Não deu para avisar agora (rede ou Discord). Tente AVISAR AGORA.', tom: 'erro' };
}

/** "TELA NO DISCORD": instalar o app, o `/tela` com o nome pronto e o aviso automático. */
export function ModalDiscord({ aberto, aoFechar, urlInstalar, canal, link }: Props) {
  const dialogo = useDialogo(aberto, aoFechar);
  const copia = useCopia(1_500);
  const estado = useEstadoDoAviso(avisoNoDiscord);
  const config = aberto ? avisoNoDiscord.config() : null;

  const [entrada, setEntrada] = useState('');
  const [erroEntrada, setErroEntrada] = useState(false);
  const [testando, setTestando] = useState(false);
  const [teste, setTeste] = useState<PropsDoAvisoAutomatico['status']>(null);
  const relogio = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (relogio.current !== null) window.clearTimeout(relogio.current);
    },
    [],
  );

  const mostrarTeste = useCallback((s: PropsDoAvisoAutomatico['status']) => {
    setTeste(s);
    if (relogio.current !== null) window.clearTimeout(relogio.current);
    relogio.current = window.setTimeout(() => setTeste(null), 6_000);
  }, []);

  const aviso: PropsDoAvisoAutomatico = {
    salvo: config === null ? null : webhookMascarado(config.webhook),
    ativo: config?.ativo ?? false,
    status: teste ?? statusDe(estado),
    entrada,
    aoMudar: (v) => {
      setEntrada(v);
      setErroEntrada(false);
    },
    erroEntrada,
    aoSalvar: () => {
      const r = avisoNoDiscord.salvar(entrada);
      if (!r.ok) {
        setErroEntrada(true);
        return;
      }
      setEntrada('');
    },
    aoTestar: () => {
      setTestando(true);
      void avisoNoDiscord.testar(new URL(link).origin).then((r) => {
        setTestando(false);
        mostrarTeste(
          r.ok
            ? { texto: 'Mensagem de teste enviada. Confira o canal.', tom: 'ok' }
            : r.error === 'RECUSADO'
              ? { texto: '! O Discord recusou o webhook. Ele foi apagado?', tom: 'erro' }
              : { texto: '! Não deu para falar com o Discord agora.', tom: 'erro' },
        );
      });
    },
    testando,
    aoLigar: (ativo) => avisoNoDiscord.ligar(ativo),
    aoRemover: () => avisoNoDiscord.remover(),
    aoAvisarAgora:
      config?.ativo === true && (estado.fase === 'pronto' || estado.fase === 'falhou')
        ? () => void avisoNoDiscord.avisarAgora()
        : null,
  };

  return (
    <Dialogo titulo="TELA NO DISCORD" dialogRef={dialogo.ref} aoClicar={dialogo.aoClicar} aoFechar={aoFechar} estreito>
      <ConteudoDiscord
        urlInstalar={urlInstalar}
        canal={canal}
        copiado={copia.copiado}
        aoCopiar={() => copia.copiar(canal)}
        aviso={aviso}
      />
    </Dialogo>
  );
}
