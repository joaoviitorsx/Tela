/*
 * tela-captura — captura de tela e codificação H.264 na GPU, Linux (D0c).
 *
 * O Chromium no Linux com NVIDIA codifica em software (VA-API da NVIDIA só
 * decodifica) e copiar um quadro 1080p para fora dele custa de 5 a 20 ms. Este
 * processo faz a captura e a codificação inteiras sem passar pelo Chromium:
 *
 *   portal ScreenCast → PipeWire (DMA-BUF) → GL (escala, NV12) → NVENC
 *
 * e entrega H.264 Annex B, um quadro por mensagem, ao "um encode, N envios"
 * (docs/desktop/D0b-um-encode-n-envios.md). Medido no Fedora do dono: ~0,06
 * núcleo em 1080p, contra ~1,2 do OpenH264 (docs/desktop/D0c-nvenc-linux.md).
 *
 * Dois pipelines: CAPTURA (PipeWire, sempre viva) entrega cada quadro à
 * CODIFICAÇÃO (GL + NVENC), que é reciclada para trocar de tamanho. Num
 * pipeline só, reciclar derrubava a captura: o Mutter não voltava a entregar.
 *
 * Processo separado, não addon: se a GPU, o driver ou o GStreamer derrubarem
 * isto, cai sozinho, e o app volta para o codificador do Chromium.
 *
 * PROTOCOLO
 *
 *   stdout: mensagens [u32 LE tamanho][u8 tipo][corpo de tamanho-1 bytes]
 *     tipo 1, quadro: [u8 chave][u16 LE largura][u16 LE altura][u32 LE seq][H.264]
 *     tipo 2, evento: JSON UTF-8 — pronto, stats, erro
 *     tipo 3, captura: sem corpo — um quadro capturado e descartado pela
 *       contrapressão. É o relógio da isca: sem ele, a fila dos senders não
 *       anda, a contrapressão não cede e a transmissão trava num quadro por PLI.
 *
 *   stdin: uma ordem por linha, texto
 *     alvo <largura> <altura> <fps> <bitrate bps>
 *     chave
 *     atraso <quadros>
 *     teto <fps>   teto de fps da CAPTURA, independente do `alvo` (que é o do
 *                  encode): a ociosidade da sessão pede 5 sem espectador. Só
 *                  decide quantos quadros sobem ao NVENC; não recicla o
 *                  pipeline nem gera IDR. 0, ou >= `alvo.fps`, é sem teto.
 *     parar
 *   stdin fechado = o app morreu: encerra.
 *
 * USO
 *   tela-captura [--fonte=portal|mutter:<conector>] [--restaurar=<token>]
 *                [--alvo=<largura>,<altura>,<fps>,<bitrate>]
 *   tela-captura --sondar
 *
 *   `mutter:` usa a API privada do GNOME, sem diálogo: só para teste
 *   automatizado. O produto usa o portal, que pergunta ao usuário o que
 *   compartilhar e devolve um token para não perguntar de novo.
 *
 *   `--sondar` não captura nada e não abre diálogo: confere que os elementos
 *   do GStreamer existem e que o NVENC abre o dispositivo, escreve um evento
 *   `sonda` no mesmo protocolo e sai com 0 (usável) ou 3 (não). O app roda
 *   isto uma vez ao abrir para decidir entre o NVENC e o codificador do
 *   Chromium antes de a pessoa apertar TRANSMITIR.
 */
#include <errno.h>
#include <math.h>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <glib-unix.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>

enum { MSG_QUADRO = 1, MSG_EVENTO = 2, MSG_CAPTURA = 3 };

/* Fila do codificador acima disto: pula quadro de captura (mesma regra do WebCodecs). */
#define ATRASO_TOLERADO 2
/*
 * Buffer de taxa do NVENC, em quadros. Com muitos, o IDR de quem entra incha
 * (o VBV é o teto dele) e o quadro grande atrasa os seguintes; com 1, o IDR
 * sai apertado e perde qualidade. O pacer do WebRTC alisa o resto.
 *
 * 2, e não 4, medido com h264_nvenc a 12 Mbps, 1080p60 (estudo 1-codec, P1;
 * `e2e/bench/estudo-nvenc-ratecontrol.mjs`, grupo vbv): IDR de 68 → 42 KB na
 * mandelbrot e 57 → 39 KB na testsrc2 (-38% e -32%), por -0,005 e -0,002 dB de
 * PSNR-Y. O VBV de 1 quadro dá 27–29 KB de IDR, mas custa -0,07 a -0,12 dB, e
 * um corte de cena em jogo precisa de folga: com 2 o maior quadro P depois do
 * corte ficou em 29 KB, igual ao de 4. Só vale no início e na troca de tamanho
 * (mexer no VBV com o fluxo andando faz o NVENC soltar um IDR; ver `aplicar_vbv`).
 */
#define VBV_EM_QUADROS 2

typedef struct {
  int width, height, fps, bitrate;
} Alvo;

static GMainLoop *laco;
static GstElement *captura, *codificacao, *codificador, *tamanho, *entra;
static GMutex saida_mutex;
/* Segura a passagem captura → codificação enquanto a codificação recicla. */
static GMutex troca_mutex;
static Alvo alvo = {1920, 1080, 60, 12000000};
static volatile gint atraso = 0;
static volatile gint chave_pendente = 1;
/* Teto de fps da captura (ordem `teto`); 0 = sem teto. Lido na thread do appsink. */
static volatile gint teto_fps = 0;
static volatile gint encerrando = 0;
static guint64 ultimo_pts = GST_CLOCK_TIME_NONE;
static guint32 seq = 0;
static int codigo_de_saida = 0;
static char *token_restaurar = NULL;
static gboolean pronto_enviado = FALSE;

/* Medidas, zeradas a cada `stats`. */
static volatile gint capturados = 0, codificados = 0, descartados = 0;
static GMutex medida_mutex;
static double soma_ms = 0;
static int amostras_ms = 0;
/*
 * Quando cada quadro entrou no NVENC. Sem B-frames a saída tem a ordem da
 * entrada, então é uma fila — o PTS não serve de chave: o encoder o desloca
 * em 1000 h na saída.
 */
static GQueue entradas = G_QUEUE_INIT;

/* ---------------------------------------------------------------- saída */

/*
 * Uma mensagem inteira (cabeçalho, metadados do quadro e H.264) numa syscall
 * só: eram três `write` por quadro. `writev` pode escrever só parte; o laço
 * avança pelos vetores até o fim.
 */
static void escrever_vetores(struct iovec *v, int n) {
  while (n > 0) {
    ssize_t w = writev(STDOUT_FILENO, v, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      /* O app fechou o cano: não há para quem entregar. */
      _exit(0);
    }
    size_t resto = (size_t)w;
    while (n > 0 && resto >= v->iov_len) {
      resto -= v->iov_len;
      v++;
      n--;
    }
    if (n > 0) {
      v->iov_base = (guint8 *)v->iov_base + resto;
      v->iov_len -= resto;
    }
  }
}

static void le32(guint8 *p, guint32 v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
  p[2] = (v >> 16) & 0xff;
  p[3] = (v >> 24) & 0xff;
}

static void enviar(guint8 tipo, const guint8 *cabecalho, size_t ncab, const void *corpo, size_t ncorpo) {
  guint8 h[5];
  le32(h, (guint32)(1 + ncab + ncorpo));
  h[4] = tipo;
  struct iovec v[3] = {
      {.iov_base = h, .iov_len = sizeof h},
      {.iov_base = (void *)cabecalho, .iov_len = ncab},
      {.iov_base = (void *)corpo, .iov_len = ncorpo},
  };
  g_mutex_lock(&saida_mutex);
  escrever_vetores(v, 3);
  g_mutex_unlock(&saida_mutex);
}

static void evento(const char *json) { enviar(MSG_EVENTO, NULL, 0, json, strlen(json)); }

static void erro(const char *codigo, const char *detalhe) {
  g_autofree char *d = g_strescape(detalhe != NULL ? detalhe : "", NULL);
  g_autofree char *j = g_strdup_printf("{\"evento\":\"erro\",\"codigo\":\"%s\",\"detalhe\":\"%s\"}", codigo, d);
  evento(j);
}

/* ----------------------------------------------------------- codificador */

/*
 * O NVENC reparte o bitrate pelo fps CONFIGURADO: cada quadro ganha
 * `bitrate / fps`. A captura de monitor do Mutter entrega ~40 q/s, não 60
 * (limite do compositor, medido no D0c), e o que saía era 2/3 do pedido. A
 * malha de banda via a estimativa colada em `1,5 × enviado` e nunca subia o
 * degrau — a armadilha da ADR 0018. O bitrate pedido é o que deve SAIR por
 * segundo: o fator corrige pelo fps medido. Teto de 2×: tela parada não pode
 * virar quadro gigante quando volta a mexer.
 */
static double fps_medido = 0;
static guint kbps_aplicado = 0;

static gboolean com_teto(void) {
  int teto = g_atomic_int_get(&teto_fps);
  return teto > 0 && teto < alvo.fps;
}

static void aplicar_bitrate(void) {
  /*
   * Com teto de captura o fps que entra no NVENC é o do teto, de propósito, e
   * "corrigir" por ele dobraria o bitrate (5 fps → fator 2). Ninguém assiste
   * nesse estado; e ao tirar o teto `fps_medido` ainda guarda a medida cheia
   * (ver `enviar_stats`), então o bitrate certo volta na hora.
   */
  double fator = fps_medido >= 5 && !com_teto() ? CLAMP((double)alvo.fps / fps_medido, 1.0, 2.0) : 1.0;
  guint kbps = (guint)MAX(300, (int)(alvo.bitrate / 1000 * fator));
  if (kbps == kbps_aplicado) return;
  kbps_aplicado = kbps;
  g_object_set(codificador, "bitrate", kbps, NULL);
}

/*
 * Trocar o `vbv-buffer-size` com o fluxo andando faz o NVENC soltar um IDR
 * (medido; trocar só o `bitrate` não faz). Por isso ele só é definido quando o
 * IDR já vai acontecer: no início e na troca de tamanho.
 */
static void aplicar_vbv(void) {
  guint kbps = (guint)MAX(300, alvo.bitrate / 1000);
  g_object_set(codificador, "vbv-buffer-size", (guint)MAX(kbps / MAX(1, alvo.fps) * VBV_EM_QUADROS, 100), NULL);
}

static void aplicar_caps_de_tamanho(void) {
  GstCaps *caps = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "NV12", "width", G_TYPE_INT, alvo.width,
                                      "height", G_TYPE_INT, alvo.height, NULL);
  gst_caps_set_features(caps, 0, gst_caps_features_new("memory:GLMemory", NULL));
  g_object_set(tamanho, "caps", caps, NULL);
  gst_caps_unref(caps);
}

/*
 * O GL do GStreamer não renegocia tamanho com o fluxo andando (falha até sem
 * NVENC, medido no D0c). Então a troca de tamanho recicla a CODIFICAÇÃO em
 * READY: ~0,1 s sem quadro, e recomeça num IDR — o mesmo que qualquer encoder
 * faz ao mudar de resolução. A captura não para. Troca de degrau é rara; troca
 * de bitrate não passa aqui.
 */
static void aplicar_tamanho(void) {
  g_mutex_lock(&troca_mutex);
  gst_element_set_state(codificacao, GST_STATE_READY);
  gst_element_get_state(codificacao, NULL, NULL, GST_CLOCK_TIME_NONE);
  aplicar_caps_de_tamanho();
  aplicar_vbv();
  /* O NVENC renasce com a configuração das propriedades: reaplicar o bitrate. */
  kbps_aplicado = 0;
  aplicar_bitrate();
  ultimo_pts = GST_CLOCK_TIME_NONE;
  g_atomic_int_set(&chave_pendente, 1);
  g_mutex_lock(&medida_mutex);
  g_queue_clear_full(&entradas, g_free);
  g_mutex_unlock(&medida_mutex);
  gst_element_set_state(codificacao, GST_STATE_PLAYING);
  g_mutex_unlock(&troca_mutex);
}

static void pedir_chave(void) {
  g_atomic_int_set(&chave_pendente, 1);
  GstPad *pad = gst_element_get_static_pad(codificador, "src");
  gst_pad_send_event(pad, gst_video_event_new_upstream_force_key_unit(GST_CLOCK_TIME_NONE, TRUE, 0));
  gst_object_unref(pad);
}

/* A fonte negociou: tamanho real e se veio por DMA-BUF (GPU) ou memória. */
static void anunciar_fonte(GstCaps *caps) {
  GstStructure *s = gst_caps_get_structure(caps, 0);
  int w = 0, h = 0;
  gst_structure_get_int(s, "width", &w);
  gst_structure_get_int(s, "height", &h);
  GstCapsFeatures *f = gst_caps_get_features(caps, 0);
  gboolean dmabuf = f != NULL && gst_caps_features_contains(f, "memory:DMABuf");
  g_autofree char *tok = token_restaurar != NULL ? g_strdup_printf("\"%s\"", token_restaurar) : g_strdup("null");
  g_autofree char *j = g_strdup_printf(
      "{\"evento\":\"pronto\",\"fonte\":{\"width\":%d,\"height\":%d},\"memoria\":\"%s\",\"restaurar\":%s}", w, h,
      dmabuf ? "dmabuf" : "sistema", tok);
  evento(j);
}

/*
 * Cada quadro do PipeWire: limita o fps, obedece à contrapressão dos senders e
 * passa à codificação. Descartar aqui é o mais barato possível — o quadro nem
 * sobe para a GPU.
 */
static GstFlowReturn ao_capturar(GstAppSink *sink, gpointer _) {
  (void)_;
  GstSample *amostra = gst_app_sink_pull_sample(sink);
  if (amostra == NULL) return GST_FLOW_OK;
  if (!pronto_enviado && gst_sample_get_caps(amostra) != NULL) {
    anunciar_fonte(gst_sample_get_caps(amostra));
    pronto_enviado = TRUE;
  }
  GstClockTime pts = GST_BUFFER_PTS(gst_sample_get_buffer(amostra));
  g_atomic_int_inc(&capturados);
  gboolean chave = g_atomic_int_get(&chave_pendente);
  if (!chave && g_atomic_int_get(&atraso) >= ATRASO_TOLERADO) {
    g_atomic_int_inc(&descartados);
    enviar(MSG_CAPTURA, NULL, 0, NULL, 0);
    gst_sample_unref(amostra);
    return GST_FLOW_OK;
  }
  /*
   * O teto da ociosidade só conta abaixo do fps do encode. E um quadro-chave
   * pedido NÃO espera o período do teto: quem acabou de entrar numa sala
   * ociosa (200 ms a 5 fps) pagaria esse atraso inteiro na imagem de abertura.
   */
  int teto = g_atomic_int_get(&teto_fps);
  gboolean limitado_por_teto = teto > 0 && teto < alvo.fps;
  int fps_limite = limitado_por_teto ? teto : alvo.fps;
  if (GST_CLOCK_TIME_IS_VALID(pts) && GST_CLOCK_TIME_IS_VALID(ultimo_pts) && fps_limite > 0 &&
      !(chave && limitado_por_teto)) {
    /* 0,8 do período: a captura tem jitter, e cortar um quadro legítimo custa mais. */
    GstClockTime periodo = GST_SECOND / (GstClockTime)fps_limite;
    if (pts > ultimo_pts && pts - ultimo_pts < periodo * 8 / 10) {
      /* Descarte pelo teto não é sobrecarga: não entra em `descartados`. */
      if (!limitado_por_teto || pts - ultimo_pts < GST_SECOND / (GstClockTime)alvo.fps * 8 / 10)
        g_atomic_int_inc(&descartados);
      gst_sample_unref(amostra);
      return GST_FLOW_OK;
    }
  }
  ultimo_pts = pts;
  /* Codificação reciclando: o quadro se perde, o próximo já vai. */
  g_mutex_lock(&troca_mutex);
  gst_app_src_push_sample(GST_APP_SRC(entra), amostra);
  g_mutex_unlock(&troca_mutex);
  gst_sample_unref(amostra);
  return GST_FLOW_OK;
}

static GstPadProbeReturn na_entrada_do_codificador(GstPad *pad, GstPadProbeInfo *info, gpointer _) {
  (void)pad;
  (void)info;
  g_mutex_lock(&medida_mutex);
  gint64 *t = g_new(gint64, 1);
  *t = g_get_monotonic_time();
  g_queue_push_tail(&entradas, t);
  while (g_queue_get_length(&entradas) > 64) g_free(g_queue_pop_head(&entradas));
  g_mutex_unlock(&medida_mutex);
  return GST_PAD_PROBE_OK;
}

static void medir_saida(void) {
  gint64 agora = g_get_monotonic_time();
  g_mutex_lock(&medida_mutex);
  gint64 *t = g_queue_pop_head(&entradas);
  if (t != NULL) {
    soma_ms += (double)(agora - *t) / 1000.0;
    amostras_ms++;
    g_free(t);
  }
  g_mutex_unlock(&medida_mutex);
}

/* Thread própria: o appsink bloqueia, e quem escreve no cano pode bloquear também. */
static gpointer entregar_quadros(gpointer dados) {
  GstAppSink *sink = dados;
  for (;;) {
    GstSample *amostra = gst_app_sink_pull_sample(sink);
    if (amostra == NULL) {
      /* Parada de verdade, ou só o pipeline reciclando para trocar de tamanho. */
      if (g_atomic_int_get(&encerrando) || gst_app_sink_is_eos(sink)) return NULL;
      g_usleep(2000);
      continue;
    }
    GstBuffer *buf = gst_sample_get_buffer(amostra);
    GstCaps *caps = gst_sample_get_caps(amostra);
    int w = 0, h = 0;
    if (caps != NULL) {
      GstStructure *s = gst_caps_get_structure(caps, 0);
      gst_structure_get_int(s, "width", &w);
      gst_structure_get_int(s, "height", &h);
    }
    gboolean chave = !GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT);
    if (chave) g_atomic_int_set(&chave_pendente, 0);
    medir_saida();
    g_atomic_int_inc(&codificados);
    GstMapInfo m;
    if (gst_buffer_map(buf, &m, GST_MAP_READ)) {
      guint8 cab[9];
      cab[0] = chave ? 1 : 0;
      cab[1] = w & 0xff;
      cab[2] = (w >> 8) & 0xff;
      cab[3] = h & 0xff;
      cab[4] = (h >> 8) & 0xff;
      le32(cab + 5, seq++);
      enviar(MSG_QUADRO, cab, sizeof cab, m.data, m.size);
      gst_buffer_unmap(buf, &m);
    }
    gst_sample_unref(amostra);
  }
}

static int zerar(volatile gint *x) {
  int v;
  do v = g_atomic_int_get(x);
  while (!g_atomic_int_compare_and_exchange(x, v, 0));
  return v;
}

static gboolean enviar_stats(gpointer _) {
  (void)_;
  g_mutex_lock(&medida_mutex);
  char ms[32] = "null";
  if (amostras_ms > 0) g_snprintf(ms, sizeof ms, "%.2f", soma_ms / amostras_ms);
  soma_ms = 0;
  amostras_ms = 0;
  g_mutex_unlock(&medida_mutex);
  int c = zerar(&capturados), q = zerar(&codificados), d = zerar(&descartados);
  /* Quadros que entraram no NVENC no último segundo, suavizado. */
  /* Com teto, `q` é o do teto: não é medida do que a fonte entrega. */
  if (q > 0 && !com_teto()) {
    double antes = fps_medido;
    fps_medido = fps_medido > 0 ? 0.5 * fps_medido + 0.5 * q : q;
    if (antes <= 0 || fabs(fps_medido - antes) / antes > 0.05) aplicar_bitrate();
  }
  g_autofree char *j = g_strdup_printf(
      "{\"evento\":\"stats\",\"capturados\":%d,\"codificados\":%d,\"descartados\":%d,\"msPorQuadro\":%s}", c, q,
      d, ms);
  evento(j);
  return G_SOURCE_CONTINUE;
}

/* ------------------------------------------------------------- ordens */

static void ordem(const char *linha) {
  Alvo a;
  int n;
  if (sscanf(linha, "alvo %d %d %d %d", &a.width, &a.height, &a.fps, &a.bitrate) == 4) {
    if (a.width < 2 || a.height < 2 || a.fps < 1 || a.bitrate < 1) return;
    a.width &= ~1;
    a.height &= ~1;
    gboolean mudou_tamanho = a.width != alvo.width || a.height != alvo.height;
    gboolean mudou_bitrate = a.bitrate != alvo.bitrate || a.fps != alvo.fps;
    alvo = a;
    /* Tamanho novo renegocia o NVENC, que recomeça num IDR. Bitrate não. */
    if (mudou_bitrate) aplicar_bitrate();
    if (mudou_tamanho) aplicar_tamanho();
  } else if (strcmp(linha, "chave") == 0) {
    pedir_chave();
  } else if (sscanf(linha, "atraso %d", &n) == 1) {
    g_atomic_int_set(&atraso, n);
  } else if (sscanf(linha, "teto %d", &n) == 1) {
    if (n < 0 || n > 240) return;
    gboolean tinha = com_teto();
    g_atomic_int_set(&teto_fps, n);
    /* Entrou ou saiu do teto: o bitrate se reajusta (só `bitrate`, sem IDR). */
    if (tinha != com_teto()) aplicar_bitrate();
  } else if (strcmp(linha, "parar") == 0) {
    g_main_loop_quit(laco);
  }
}

static gboolean ler_ordens(GIOChannel *canal, GIOCondition cond, gpointer _) {
  if (cond & (G_IO_HUP | G_IO_ERR)) {
    g_main_loop_quit(laco);
    return G_SOURCE_REMOVE;
  }
  g_autofree char *linha = NULL;
  gsize fim = 0;
  GIOStatus st = g_io_channel_read_line(canal, &linha, NULL, &fim, NULL);
  if (st == G_IO_STATUS_EOF || st == G_IO_STATUS_ERROR) {
    g_main_loop_quit(laco);
    return G_SOURCE_REMOVE;
  }
  if (linha != NULL) {
    linha[fim] = '\0';
    ordem(linha);
  }
  return G_SOURCE_CONTINUE;
}

static gboolean no_barramento(GstBus *bus, GstMessage *msg, gpointer _) {
  (void)bus;
  if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
    g_autoptr(GError) e = NULL;
    g_autofree char *dbg = NULL;
    gst_message_parse_error(msg, &e, &dbg);
    erro("PIPELINE", e != NULL ? e->message : "?");
    codigo_de_saida = 2;
    g_main_loop_quit(laco);
  } else if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_EOS) {
    /* A fonte acabou: a janela fechou ou o usuário parou pelo sistema. */
    erro("FONTE_ENCERRADA", "");
    codigo_de_saida = 4;
    g_main_loop_quit(laco);
  }
  return G_SOURCE_CONTINUE;
}

static gboolean ao_sinal(gpointer _) {
  g_main_loop_quit(laco);
  return G_SOURCE_REMOVE;
}

/* --------------------------------------------------------- fontes: D-Bus */

typedef struct {
  GMainLoop *laco;
  guint32 codigo;
  GVariant *resultados;
  gboolean chegou;
} Resposta;

static void ao_responder(GDBusConnection *c, const char *s, const char *p, const char *i, const char *n, GVariant *params,
                         gpointer dados) {
  (void)c, (void)s, (void)p, (void)i, (void)n;
  Resposta *r = dados;
  g_variant_get(params, "(u@a{sv})", &r->codigo, &r->resultados);
  r->chegou = TRUE;
  g_main_loop_quit(r->laco);
}

static char *caminho_do_pedido(GDBusConnection *bus, const char *token) {
  g_autofree char *remetente = g_strdup(g_dbus_connection_get_unique_name(bus) + 1);
  for (char *p = remetente; *p; p++)
    if (*p == '.') *p = '_';
  return g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", remetente, token);
}

/*
 * Chamada do portal no padrão Request: o resultado chega depois, num sinal
 * `Response` num caminho que dá para prever. A assinatura vem ANTES da
 * chamada, senão uma resposta rápida se perde.
 */
static gboolean portal(GDBusConnection *bus, const char *metodo, GVariant *params, const char *token, Resposta *r,
                       GError **e) {
  g_autofree char *caminho = caminho_do_pedido(bus, token);
  r->laco = g_main_loop_new(NULL, FALSE);
  r->chegou = FALSE;
  guint sub = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.portal.Desktop",
                                                 "org.freedesktop.portal.Request", "Response", caminho, NULL,
                                                 G_DBUS_SIGNAL_FLAGS_NONE, ao_responder, r, NULL);
  g_autoptr(GVariant) v =
      g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                                  "org.freedesktop.portal.ScreenCast", metodo, params, NULL, G_DBUS_CALL_FLAGS_NONE,
                                  -1, NULL, e);
  if (v != NULL) g_main_loop_run(r->laco);
  g_dbus_connection_signal_unsubscribe(bus, sub);
  g_main_loop_unref(r->laco);
  return v != NULL && r->chegou;
}

static guint32 propriedade_u(GDBusConnection *bus, const char *nome, guint32 padrao) {
  g_autoptr(GVariant) v = g_dbus_connection_call_sync(
      bus, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.DBus.Properties",
      "Get", g_variant_new("(ss)", "org.freedesktop.portal.ScreenCast", nome), G_VARIANT_TYPE("(v)"),
      G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL);
  if (v == NULL) return padrao;
  g_autoptr(GVariant) dentro = NULL;
  g_variant_get(v, "(v)", &dentro);
  return g_variant_is_of_type(dentro, G_VARIANT_TYPE_UINT32) ? g_variant_get_uint32(dentro) : padrao;
}

/* Portal ScreenCast: o sistema pergunta ao usuário o que compartilhar. */
static gboolean pelo_portal(int *fd, guint32 *no) {
  g_autoptr(GError) e = NULL;
  /* Sem unref: a sessão do portal morre com a conexão, e a captura junto. */
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &e);
  if (bus == NULL) {
    erro("PORTAL", e->message);
    return FALSE;
  }
  Resposta r;
  GVariantBuilder o;

  g_variant_builder_init(&o, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string("tela1"));
  g_variant_builder_add(&o, "{sv}", "session_handle_token", g_variant_new_string("telasessao"));
  if (!portal(bus, "CreateSession", g_variant_new("(a{sv})", &o), "tela1", &r, &e) || r.codigo != 0) {
    erro("PORTAL", e != NULL ? e->message : "CreateSession recusado");
    return FALSE;
  }
  const char *s = NULL;
  g_variant_lookup(r.resultados, "session_handle", "&s", &s);
  g_autofree char *sessao = g_strdup(s);
  g_variant_unref(r.resultados);

  /* Cursor no próprio vídeo quando o compositor sabe; senão, nenhum. */
  guint32 cursores = propriedade_u(bus, "AvailableCursorModes", 1);
  g_variant_builder_init(&o, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string("tela2"));
  g_variant_builder_add(&o, "{sv}", "types", g_variant_new_uint32(1 | 2)); /* monitor | janela */
  g_variant_builder_add(&o, "{sv}", "multiple", g_variant_new_boolean(FALSE));
  g_variant_builder_add(&o, "{sv}", "cursor_mode", g_variant_new_uint32((cursores & 2) ? 2 : 1));
  /* Lembrar a escolha até o usuário revogar: a próxima transmissão não pergunta. */
  if (propriedade_u(bus, "version", 1) >= 4) {
    g_variant_builder_add(&o, "{sv}", "persist_mode", g_variant_new_uint32(2));
    if (token_restaurar != NULL)
      g_variant_builder_add(&o, "{sv}", "restore_token", g_variant_new_string(token_restaurar));
  }
  if (!portal(bus, "SelectSources", g_variant_new("(oa{sv})", sessao, &o), "tela2", &r, &e) || r.codigo != 0) {
    erro("PORTAL", e != NULL ? e->message : "SelectSources recusado");
    return FALSE;
  }
  g_variant_unref(r.resultados);

  g_variant_builder_init(&o, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string("tela3"));
  if (!portal(bus, "Start", g_variant_new("(osa{sv})", sessao, "", &o), "tela3", &r, &e)) {
    erro("PORTAL", e != NULL ? e->message : "Start falhou");
    return FALSE;
  }
  if (r.codigo == 1) {
    /* Escolha da pessoa, não falha (R4 do lado de lá: DENIED ≠ FAILED). */
    erro("CANCELADO", "");
    codigo_de_saida = 5;
    return FALSE;
  }
  if (r.codigo != 0) {
    erro("PORTAL", "Start recusado");
    return FALSE;
  }
  g_autoptr(GVariant) fluxos = g_variant_lookup_value(r.resultados, "streams", G_VARIANT_TYPE("a(ua{sv})"));
  const char *tok = NULL;
  if (g_variant_lookup(r.resultados, "restore_token", "&s", &tok)) {
    g_free(token_restaurar);
    token_restaurar = g_strdup(tok);
  }
  if (fluxos == NULL || g_variant_n_children(fluxos) == 0) {
    g_variant_unref(r.resultados);
    erro("PORTAL", "nenhum fluxo");
    return FALSE;
  }
  g_variant_get_child(fluxos, 0, "(u@a{sv})", no, NULL);
  g_variant_unref(r.resultados);

  g_autoptr(GUnixFDList) fds = NULL;
  g_variant_builder_init(&o, G_VARIANT_TYPE_VARDICT);
  g_autoptr(GVariant) v = g_dbus_connection_call_with_unix_fd_list_sync(
      bus, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.ScreenCast",
      "OpenPipeWireRemote", g_variant_new("(oa{sv})", sessao, &o), G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, -1,
      NULL, &fds, NULL, &e);
  if (v == NULL) {
    erro("PORTAL", e->message);
    return FALSE;
  }
  gint32 indice;
  g_variant_get(v, "(h)", &indice);
  *fd = g_unix_fd_list_get(fds, indice, &e);
  return *fd >= 0;
}

static void no_fluxo_mutter(GDBusConnection *c, const char *s, const char *p, const char *i, const char *n,
                            GVariant *params, gpointer dados) {
  (void)c, (void)s, (void)p, (void)i, (void)n;
  Resposta *r = dados;
  g_variant_get(params, "(u)", &r->codigo);
  r->chegou = TRUE;
  g_main_loop_quit(r->laco);
}

/* API privada do Mutter: sem diálogo, só para teste automatizado. */
static gboolean pelo_mutter(const char *conector, guint32 *no) {
  g_autoptr(GError) e = NULL;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &e); /* vive com a sessão */
  if (bus == NULL) {
    erro("MUTTER", e->message);
    return FALSE;
  }
  g_autoptr(GVariant) vs = g_dbus_connection_call_sync(
      bus, "org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast", "org.gnome.Mutter.ScreenCast",
      "CreateSession", g_variant_new_parsed("(@a{sv} {},)"), G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL,
      &e);
  if (vs == NULL) {
    erro("MUTTER", e->message);
    return FALSE;
  }
  const char *sessao;
  g_variant_get(vs, "(&o)", &sessao);
  GVariantBuilder o;
  g_variant_builder_init(&o, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&o, "{sv}", "cursor-mode", g_variant_new_uint32(1));
  g_autoptr(GVariant) vf = g_dbus_connection_call_sync(
      bus, "org.gnome.Mutter.ScreenCast", sessao, "org.gnome.Mutter.ScreenCast.Session", "RecordMonitor",
      g_variant_new("(sa{sv})", conector, &o), G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL, &e);
  if (vf == NULL) {
    erro("MUTTER", e->message);
    return FALSE;
  }
  const char *fluxo;
  g_variant_get(vf, "(&o)", &fluxo);
  Resposta r = {.laco = g_main_loop_new(NULL, FALSE)};
  guint sub = g_dbus_connection_signal_subscribe(bus, NULL, "org.gnome.Mutter.ScreenCast.Stream",
                                                 "PipeWireStreamAdded", fluxo, NULL, G_DBUS_SIGNAL_FLAGS_NONE,
                                                 no_fluxo_mutter, &r, NULL);
  g_autoptr(GVariant) vi =
      g_dbus_connection_call_sync(bus, "org.gnome.Mutter.ScreenCast", sessao, "org.gnome.Mutter.ScreenCast.Session",
                                  "Start", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, -1, NULL, &e);
  if (vi != NULL) g_main_loop_run(r.laco);
  g_dbus_connection_signal_unsubscribe(bus, sub);
  g_main_loop_unref(r.laco);
  if (!r.chegou) {
    erro("MUTTER", e != NULL ? e->message : "sem fluxo");
    return FALSE;
  }
  *no = r.codigo;
  return TRUE;
}

/* ---------------------------------------------------------------- main */

int main(int argc, char **argv) {
  const char *fonte = "portal";
  gboolean sondar = FALSE;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--sondar") == 0)
      sondar = TRUE;
    else if (g_str_has_prefix(argv[i], "--fonte="))
      fonte = argv[i] + 8;
    else if (g_str_has_prefix(argv[i], "--restaurar="))
      token_restaurar = g_strdup(argv[i] + 12);
    else if (g_str_has_prefix(argv[i], "--alvo="))
      sscanf(argv[i] + 7, "%d,%d,%d,%d", &alvo.width, &alvo.height, &alvo.fps, &alvo.bitrate);
  }
  alvo.width &= ~1;
  alvo.height &= ~1;
  gst_init(&argc, &argv);
  laco = g_main_loop_new(NULL, FALSE);

  const char *faltando = NULL;
  const char *precisa[] = {"pipewiresrc", "glupload", "glcolorconvert", "glcolorscale", "nvh264enc", "appsink"};
  for (size_t i = 0; i < G_N_ELEMENTS(precisa); i++) {
    g_autoptr(GstElementFactory) f = gst_element_factory_find(precisa[i]);
    if (f == NULL) {
      faltando = precisa[i];
      break;
    }
  }
  if (faltando != NULL) {
    /* O app lê isto e fica no codificador do Chromium. */
    erro(g_str_equal(faltando, "nvh264enc") ? "SEM_NVENC" : "SEM_COMPONENTE", faltando);
    return 3;
  }

  if (sondar) {
    /*
     * A fábrica existir só diz que o plugin carregou. É NULL→READY que abre a
     * sessão de codificação no driver (CUDA + NvEncOpenEncodeSessionEx): sem
     * GPU NVIDIA utilizável, sem driver que bata com a libnvidia-encode, ou com
     * as sessões do NVENC esgotadas, é aqui que falha — e é isto que o app
     * precisa saber antes de prometer o caminho nativo.
     */
    GstElement *enc = gst_element_factory_make("nvh264enc", NULL);
    if (enc == NULL) {
      erro("SEM_NVENC", "nvh264enc não instancia");
      return 3;
    }
    gboolean abre = gst_element_set_state(enc, GST_STATE_READY) != GST_STATE_CHANGE_FAILURE;
    gst_element_set_state(enc, GST_STATE_NULL);
    gst_object_unref(enc);
    if (!abre) {
      erro("SEM_NVENC", "nvh264enc não abre o dispositivo");
      return 3;
    }
    g_autofree char *versao = gst_version_string();
    g_autofree char *j = g_strdup_printf("{\"evento\":\"sonda\",\"nvenc\":true,\"gstreamer\":\"%s\"}", versao);
    evento(j);
    return 0;
  }

  int fd = -1;
  guint32 no = 0;
  gboolean ok = g_str_has_prefix(fonte, "mutter:") ? pelo_mutter(fonte + 7, &no) : pelo_portal(&fd, &no);
  if (!ok) return codigo_de_saida != 0 ? codigo_de_saida : 2;

  /*
   * H.264 Constrained Baseline, sem B-frames, GOP infinito: o mesmo que o
   * espectador já negocia no WebRTC, e IDR só quando alguém pede. A escala
   * vem ANTES da conversão: o `glcolorscale` só trabalha em RGBA.
   */
  g_autoptr(GError) e = NULL;
  codificacao = gst_parse_launch(
      "appsrc name=entra is-live=true format=time do-timestamp=true max-buffers=1 leaky-type=downstream"
      " ! glupload name=subir ! glcolorscale ! glcolorconvert"
      " ! capsfilter name=tamanho"
      " ! nvh264enc name=codificador preset=p4 tune=ultra-low-latency rc-mode=cbr gop-size=-1 bframes=0"
      "   zerolatency=true repeat-sequence-header=true spatial-aq=true"
      " ! video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au"
      " ! appsink name=saida sync=false max-buffers=4 drop=false",
      &e);
  if (codificacao == NULL) {
    erro("PIPELINE", e->message);
    return 2;
  }
  codificador = gst_bin_get_by_name(GST_BIN(codificacao), "codificador");
  tamanho = gst_bin_get_by_name(GST_BIN(codificacao), "tamanho");
  entra = gst_bin_get_by_name(GST_BIN(codificacao), "entra");
  aplicar_caps_de_tamanho();
  aplicar_bitrate();
  aplicar_vbv();
  GstPad *enc_pad = gst_element_get_static_pad(codificador, "sink");
  gst_pad_add_probe(enc_pad, GST_PAD_PROBE_TYPE_BUFFER, na_entrada_do_codificador, NULL, NULL);

  /*
   * A captura aceita o que o `glupload` aceita — inclusive DMA-BUF com os
   * modificadores da GPU, que ele só conhece com o contexto GL de pé (PAUSED).
   * Assim o PipeWire negocia DMA-BUF e a imagem não passa pela CPU; o `pronto`
   * diz qual veio.
   */
  gst_element_set_state(codificacao, GST_STATE_PAUSED);
  gst_element_get_state(codificacao, NULL, NULL, GST_CLOCK_TIME_NONE);
  GstElement *subir = gst_bin_get_by_name(GST_BIN(codificacao), "subir");
  GstPad *subir_pad = gst_element_get_static_pad(subir, "sink");
  GstCaps *aceitas = gst_pad_query_caps(subir_pad, NULL);
  gst_object_unref(subir_pad);
  gst_object_unref(subir);

  g_autofree char *fdtxt = fd >= 0 ? g_strdup_printf("fd=%d", fd) : g_strdup("");
  g_autofree char *desc = g_strdup_printf(
      "pipewiresrc name=fonte %s path=%u always-copy=false do-timestamp=true"
      " ! appsink name=capturado sync=false max-buffers=1 drop=true",
      fdtxt, no);
  captura = gst_parse_launch(desc, &e);
  if (captura == NULL) {
    erro("PIPELINE", e->message);
    return 2;
  }
  GstElement *capturado = gst_bin_get_by_name(GST_BIN(captura), "capturado");
  gst_app_sink_set_caps(GST_APP_SINK(capturado), aceitas);
  gst_caps_unref(aceitas);
  GstAppSinkCallbacks cb = {.new_sample = ao_capturar};
  gst_app_sink_set_callbacks(GST_APP_SINK(capturado), &cb, NULL, NULL);

  GstBus *bus_cod = gst_element_get_bus(codificacao);
  gst_bus_add_watch(bus_cod, no_barramento, NULL);
  GstBus *bus_cap = gst_element_get_bus(captura);
  gst_bus_add_watch(bus_cap, no_barramento, NULL);
  GIOChannel *entrada = g_io_channel_unix_new(STDIN_FILENO);
  g_io_add_watch(entrada, G_IO_IN | G_IO_HUP | G_IO_ERR, ler_ordens, NULL);
  g_unix_signal_add(SIGTERM, ao_sinal, NULL);
  g_unix_signal_add(SIGINT, ao_sinal, NULL);
  g_timeout_add_seconds(1, enviar_stats, NULL);

  GstElement *saida = gst_bin_get_by_name(GST_BIN(codificacao), "saida");
  GThread *entrega = g_thread_new("entrega", entregar_quadros, saida);
  gst_element_set_state(codificacao, GST_STATE_PLAYING);
  gst_element_set_state(captura, GST_STATE_PLAYING);
  g_main_loop_run(laco);

  g_atomic_int_set(&encerrando, 1);
  gst_element_set_state(captura, GST_STATE_NULL);
  gst_element_set_state(codificacao, GST_STATE_NULL);
  g_thread_join(entrega);
  gst_object_unref(saida);
  gst_object_unref(enc_pad);
  gst_object_unref(capturado);
  gst_object_unref(bus_cod);
  gst_object_unref(bus_cap);
  gst_object_unref(entra);
  gst_object_unref(tamanho);
  gst_object_unref(codificador);
  gst_object_unref(captura);
  gst_object_unref(codificacao);
  if (fd >= 0) close(fd);
  return codigo_de_saida;
}
