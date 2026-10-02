// Addon N-API do "só o jogo" no Windows (D3, docs/desktop/D3-som.md).
//
// Captura o áudio de UM processo (e dos filhos dele) com o WASAPI process
// loopback: ActivateAudioInterfaceAsync com AUDIOCLIENT_ACTIVATION_TYPE_
// PROCESS_LOOPBACK e o pid do jogo. É a única forma de ouvir só o jogo sem
// pegar a call de voz que toca ao lado — o `audio: 'loopback'` do Electron é
// o sistema inteiro. Exige Windows 10 versão 2004 (build 19041) ou mais novo;
// o main confere a versão antes de carregar este módulo.
//
// API para o JavaScript (o utility process, src/main/som/utilitario-win.ts):
//
//   versao(): string
//   listarSessoes(): { pid, nome, caminho, ativa }[]
//       as sessões de áudio da saída padrão, uma por executável, já subidas até
//       o processo-raiz (o Chromium toca por um processo filho; capturar a
//       árvore da raiz pega os dois);
//   capturar(pid, aoBloco(Float32Array), aoFim(motivo)): { parar() }
//       PCM float32 intercalado, 48 kHz, estéreo, blocos de 10 ms (480 quadros
//       = 960 floats). Lança Error('CODIGO: detalhe') se não conseguir ativar.
//
// Decisões que valem a leitura:
//
//  - A captura roda numa thread própria (MTA) e entrega os blocos ao JS por
//    ThreadSafeFunction sem bloquear: se o JS atrasar, o bloco é descartado,
//    nunca a thread de áudio travada.
//  - O process loopback NÃO entrega pacotes quando o processo está em silêncio.
//    O renderer espera um fluxo contínuo (o anel dele reprime o relógio com
//    base nos blocos), então a thread completa os intervalos com silêncio pelo
//    relógio real (steady_clock): o fluxo anda sempre em tempo real.
//  - O formato é pedido (float32 48 kHz estéreo); se o Windows recusar, tenta
//    PCM 16 bit e, por último, o mesmo float com conversão automática. O que
//    sai para o JS é sempre float32.
//  - O fim da captura chega com um motivo: PROCESSO_ENCERROU (o jogo fechou),
//    DISPOSITIVO (trocou o fone / o dispositivo foi invalidado), FALHOU.
//
// Não foi compilado nem executado fora do CI do Windows: quem escreveu não tem
// Windows aqui. O CI compila (node-gyp contra os cabeçalhos do Electron) e o
// aceite é humano — ver "Validação humana" em docs/desktop/D3-som.md.

#include <napi.h>

#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <tlhelp32.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <future>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr uint32_t kTaxa = 48000;
constexpr uint32_t kCanais = 2;
constexpr uint32_t kQuadrosPorBloco = 480;  // 10 ms
constexpr size_t kFloatsPorBloco = static_cast<size_t>(kQuadrosPorBloco) * kCanais;
constexpr DWORD kPrazoDaAtivacaoMs = 5000;
// S-16: a fila para o JS é finita. 64 blocos de 10 ms = 640 ms de áudio; se o
// consumidor (event loop do utility, MessagePort) travar, o que passa disso é
// DESCARTADO (o mais novo) e contado, em vez de crescer ~380 KB/s sem limite.
constexpr size_t kFilaMaxima = 64;
// Depois de uma pausa do relógio (suspensão, thread parada) o silêncio devido
// pode ser de segundos: preenche no máximo 200 ms por volta e re-ancora o resto.
constexpr int kMaxBlocosDeSilencioPorVolta = 20;
// Quanto `Parar()` espera a thread sair antes de soltá-la (detach), para não
// travar o event loop do utility (a ativação pode levar até kPrazoDaAtivacaoMs).
constexpr auto kPrazoDoParar = std::chrono::milliseconds(500);
// Quanto o relógio real pode andar à frente do que já foi emitido antes de a
// thread inserir silêncio: dois blocos. Abaixo disso é jitter do agendador, e
// preencher aí só criaria silêncio que a captura real logo contradiria.
constexpr uint64_t kMargemDoRelogioEmQuadros = 2ull * kQuadrosPorBloco;

std::string Hex(HRESULT hr) {
  char buf[16];
  std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

std::string ParaUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

// ------------------------------------------------------------ processos

std::wstring CaminhoDoProcesso(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (h == nullptr) return {};
  std::wstring caminho(1024, L'\0');
  DWORD tam = static_cast<DWORD>(caminho.size());
  const BOOL ok = QueryFullProcessImageNameW(h, 0, caminho.data(), &tam);
  CloseHandle(h);
  if (!ok) return {};
  caminho.resize(tam);
  return caminho;
}

std::wstring NomeDoArquivo(const std::wstring& caminho) {
  const size_t barra = caminho.find_last_of(L"\\/");
  return barra == std::wstring::npos ? caminho : caminho.substr(barra + 1);
}

std::wstring SemExtensao(const std::wstring& nome) {
  const size_t ponto = nome.find_last_of(L'.');
  return ponto == std::wstring::npos || ponto == 0 ? nome : nome.substr(0, ponto);
}

bool IgualSemCaixa(const std::wstring& a, const std::wstring& b) {
  return a.size() == b.size() &&
         CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

struct InfoDeProcesso {
  DWORD pai = 0;
  std::wstring exe;
};

std::unordered_map<DWORD, InfoDeProcesso> TabelaDeProcessos() {
  std::unordered_map<DWORD, InfoDeProcesso> t;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return t;
  PROCESSENTRY32W e{};
  e.dwSize = sizeof(e);
  if (Process32FirstW(snap, &e)) {
    do {
      t[e.th32ProcessID] = InfoDeProcesso{e.th32ParentProcessID, e.szExeFile};
    } while (Process32NextW(snap, &e));
  }
  CloseHandle(snap);
  return t;
}

// Sobe da sessão até o ancestral MAIS ALTO que seja o mesmo executável: um
// Chromium toca por um filho "audio service", e o jogo (a raiz) é quem a
// pessoa reconhece. O process loopback com INCLUDE_TARGET_PROCESS_TREE na raiz
// cobre todos os filhos. Limite de 16 degraus contra ciclos de pid reutilizado.
DWORD RaizDoProcesso(DWORD pid, const std::unordered_map<DWORD, InfoDeProcesso>& tabela) {
  auto it = tabela.find(pid);
  if (it == tabela.end()) return pid;
  DWORD atual = pid;
  for (int i = 0; i < 16; ++i) {
    auto a = tabela.find(atual);
    if (a == tabela.end()) break;
    auto p = tabela.find(a->second.pai);
    if (p == tabela.end() || a->second.pai == atual) break;
    if (!IgualSemCaixa(p->second.exe, a->second.exe)) break;
    atual = a->second.pai;
  }
  return atual;
}

// ----------------------------------------------------- listar as sessões

struct SessaoListada {
  DWORD pid;
  std::string nome;
  std::string caminho;
  bool ativa;
};

// Numa thread à parte: o COM do utility process não é nosso, e uma thread
// descartável com o apartamento certo (MTA) não depende do estado dele.
std::vector<SessaoListada> ListarNaThread(std::string* erro) {
  std::vector<SessaoListada> saida;
  const HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hrCo)) {
    *erro = "FALHOU: CoInitializeEx " + Hex(hrCo);
    return saida;
  }
  {
    ComPtr<IMMDeviceEnumerator> en;
    ComPtr<IMMDevice> dispositivo;
    ComPtr<IAudioSessionManager2> gerente;
    ComPtr<IAudioSessionEnumerator> sessoes;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dispositivo);
    if (SUCCEEDED(hr)) hr = dispositivo->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(gerente.GetAddressOf()));
    if (SUCCEEDED(hr)) hr = gerente->GetSessionEnumerator(&sessoes);
    int total = 0;
    if (SUCCEEDED(hr)) hr = sessoes->GetCount(&total);
    if (FAILED(hr)) {
      *erro = "FALHOU: sessões de áudio " + Hex(hr);
    } else {
      const auto tabela = TabelaDeProcessos();
      std::unordered_map<DWORD, size_t> indice;
      for (int i = 0; i < total; ++i) {
        ComPtr<IAudioSessionControl> c;
        ComPtr<IAudioSessionControl2> c2;
        if (FAILED(sessoes->GetSession(i, &c)) || FAILED(c.As(&c2))) continue;
        if (c2->IsSystemSoundsSession() == S_OK) continue;
        DWORD pid = 0;
        if (FAILED(c2->GetProcessId(&pid)) || pid == 0) continue;
        AudioSessionState estado = AudioSessionStateInactive;
        c->GetState(&estado);
        const DWORD raiz = RaizDoProcesso(pid, tabela);
        const bool ativa = estado == AudioSessionStateActive;
        auto achado = indice.find(raiz);
        if (achado != indice.end()) {
          saida[achado->second].ativa = saida[achado->second].ativa || ativa;
          continue;
        }
        std::wstring caminho = CaminhoDoProcesso(raiz);
        if (caminho.empty()) caminho = CaminhoDoProcesso(pid);
        std::wstring nome = SemExtensao(NomeDoArquivo(caminho));
        if (nome.empty()) {
          auto it = tabela.find(raiz);
          if (it != tabela.end()) nome = SemExtensao(it->second.exe);
        }
        if (nome.empty()) continue;
        indice[raiz] = saida.size();
        saida.push_back(SessaoListada{raiz, ParaUtf8(nome), ParaUtf8(caminho), ativa});
      }
    }
  }
  CoUninitialize();
  return saida;
}

// ------------------------------------------------------------- ativação

// O ActivateAudioInterfaceAsync chama de volta numa thread do pool: o handler
// precisa ser "agile" (IAgileObject), senão o COM tenta fazer marshalling
// para o apartamento de quem chamou e a ativação falha com E_ILLEGAL_METHOD_CALL.
class Ativacao final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  Ativacao() : evento_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~Ativacao() {
    if (evento_ != nullptr) CloseHandle(evento_);
  }

  STDMETHODIMP QueryInterface(REFIID id, void** out) override {
    if (out == nullptr) return E_POINTER;
    if (id == __uuidof(IUnknown) || id == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (id == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++refs_; }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG n = --refs_;
    if (n == 0) delete this;
    return n;
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrAtivacao = E_FAIL;
    ComPtr<IUnknown> unk;
    const HRESULT h = op->GetActivateResult(&hrAtivacao, unk.GetAddressOf());
    resultado_ = FAILED(h) ? h : hrAtivacao;
    if (SUCCEEDED(resultado_) && unk != nullptr) {
      const HRESULT q = unk.As(&cliente_);
      if (FAILED(q)) resultado_ = q;
    }
    SetEvent(evento_);
    return S_OK;
  }

  bool Esperar(DWORD ms) { return WaitForSingleObject(evento_, ms) == WAIT_OBJECT_0; }
  HRESULT resultado() const { return resultado_; }
  ComPtr<IAudioClient> cliente() const { return cliente_; }

 private:
  std::atomic<ULONG> refs_{1};
  HANDLE evento_;
  HRESULT resultado_ = E_FAIL;
  ComPtr<IAudioClient> cliente_;
};

// Uma ativação do IAudioClient preso ao processo `pid` (e à árvore dele).
HRESULT AtivarPorProcesso(DWORD pid, ComPtr<IAudioClient>* cliente) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT pv{};
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  // Ponteiro cru com Release explícito: o Ativacao herda IUnknown por dois
  // caminhos (handler e IAgileObject) e o ComPtr<T> não gosta da ambiguidade.
  Ativacao* handler = new Ativacao();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
  if (SUCCEEDED(hr)) {
    if (!handler->Esperar(kPrazoDaAtivacaoMs)) {
      hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    } else {
      hr = handler->resultado();
      if (SUCCEEDED(hr)) {
        *cliente = handler->cliente();
        if (cliente->Get() == nullptr) hr = E_FAIL;
      }
    }
  }
  // O runtime guarda a sua própria referência enquanto a operação está viva.
  handler->Release();
  return hr;
}

enum class Amostra { Float32, Int16 };

struct Tentativa {
  Amostra tipo;
  DWORD flags;
};

WAVEFORMATEX Formato(Amostra tipo) {
  WAVEFORMATEX f{};
  f.nChannels = kCanais;
  f.nSamplesPerSec = kTaxa;
  f.wFormatTag = tipo == Amostra::Float32 ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
  f.wBitsPerSample = tipo == Amostra::Float32 ? 32 : 16;
  f.nBlockAlign = static_cast<WORD>(f.nChannels * f.wBitsPerSample / 8);
  f.nAvgBytesPerSec = f.nSamplesPerSec * f.nBlockAlign;
  f.cbSize = 0;
  return f;
}

// ----------------------------------------------------------- a captura

class Sessao : public std::enable_shared_from_this<Sessao> {
 public:
  Sessao(DWORD pid, Napi::ThreadSafeFunction blocos, Napi::ThreadSafeFunction fim)
      : pid_(pid), blocos_(std::move(blocos)), fim_(std::move(fim)) {
    parar_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  }
  ~Sessao() {
    // `std::thread` joinable no destrutor é `std::terminate`. Dois caminhos
    // chegam aqui com a thread ainda "dona": a ativação que falhou (ninguém
    // chamou `Parar`) e a thread soltando a última referência de si mesma.
    if (thread_.joinable()) {
      if (std::this_thread::get_id() == thread_.get_id()) {
        thread_.detach();
      } else {
        thread_.join();
      }
    }
    if (parar_ != nullptr) CloseHandle(parar_);
  }

  // Sobe a thread e espera ela dizer se a ativação deu certo. Devolve o erro
  // ("CODIGO: detalhe") ou vazio.
  std::string Iniciar() {
    std::promise<std::string> aberta;
    std::future<std::string> resposta = aberta.get_future();
    auto eu = shared_from_this();
    thread_ = std::thread([eu, p = std::move(aberta)]() mutable { eu->Rodar(std::move(p)); });
    if (resposta.wait_for(std::chrono::milliseconds(kPrazoDaAtivacaoMs + 2000)) != std::future_status::ready) {
      Parar();
      return "FALHOU: a ativação não respondeu";
    }
    std::string erro = resposta.get();
    // Ativação que falhou: a thread já está só limpando. Sai de cena agora.
    if (!erro.empty()) Parar();
    return erro;
  }

  // Pede a parada e espera NO MÁXIMO `kPrazoDoParar`: o `join()` sem prazo
  // bloqueava o event loop do utility por até 3 × 5 s de ativação pendente
  // (S-16). Passado o prazo a thread é solta; ela guarda `shared_from_this`,
  // então a `Sessao` vive até ela terminar e solta os `Release` sozinha.
  void Parar() {
    if (parar_ != nullptr) SetEvent(parar_);
    if (!thread_.joinable() || std::this_thread::get_id() == thread_.get_id()) return;
    if (terminou_.wait_for(kPrazoDoParar) == std::future_status::ready) {
      thread_.join();
    } else {
      thread_.detach();
    }
  }

  // Quantos blocos o descarte da fila cheia já jogou fora (diagnóstico).
  uint64_t Descartados() const { return descartados_.load(); }

 private:
  void EmitirBloco(const float* dados) {
    auto* v = new std::vector<float>(dados, dados + kFloatsPorBloco);
    const napi_status st = blocos_.NonBlockingCall(v, [](Napi::Env env, Napi::Function cb, std::vector<float>* d) {
      std::unique_ptr<std::vector<float>> dono(d);
      if (env == nullptr || cb == nullptr) return;
      try {
        auto ab = Napi::ArrayBuffer::New(env, d->size() * sizeof(float));
        std::memcpy(ab.Data(), d->data(), d->size() * sizeof(float));
        cb.Call({Napi::Float32Array::New(env, d->size(), ab, 0)});
      } catch (...) {
        // Uma exceção do JS não pode atravessar a fronteira do N-API.
      }
    });
    if (st != napi_ok) {
      // Fila cheia (`napi_queue_full`) ou já fechada: ninguém vai consumir este bloco.
      delete v;
      if (st == napi_queue_full) descartados_.fetch_add(1);
    }
  }

  void EmitirFim(const std::string& motivo) {
    auto* m = new std::string(motivo);
    const napi_status st = fim_.NonBlockingCall(m, [](Napi::Env env, Napi::Function cb, std::string* s) {
      std::unique_ptr<std::string> dono(s);
      if (env == nullptr || cb == nullptr) return;
      try {
        cb.Call({Napi::String::New(env, *s)});
      } catch (...) {
      }
    });
    if (st != napi_ok) delete m;
  }

  // A thread inteira: ativa, captura até parar, e SEMPRE avisa o fim.
  void Rodar(std::promise<std::string> aberta) {
    const HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD tarefa = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &tarefa);

    std::string erro;
    std::string motivo = "FALHOU";
    HANDLE processo = nullptr;
    HANDLE evento = nullptr;
    ComPtr<IAudioClient> cliente;
    ComPtr<IAudioCaptureClient> captura;
    Amostra tipo = Amostra::Float32;
    bool aberta_ok = false;

    if (FAILED(hrCo)) {
      erro = "FALHOU: CoInitializeEx " + Hex(hrCo);
    } else {
      // SYNCHRONIZE basta para esperar o fim do processo. Se o Windows negar
      // (processo protegido), segue sem isto: a captura funciona, só não
      // percebemos sozinhos que o jogo fechou.
      processo = OpenProcess(SYNCHRONIZE, FALSE, pid_);
      if (processo == nullptr && GetLastError() == ERROR_INVALID_PARAMETER) {
        erro = "PROCESSO_INVALIDO: o pid " + std::to_string(pid_) + " não existe";
      } else {
        evento = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        const DWORD base = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_NOPERSIST;
        const Tentativa tentativas[] = {
            {Amostra::Float32, base},
            {Amostra::Int16, base},
            {Amostra::Float32, base | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY},
        };
        HRESULT ultimo = E_FAIL;
        for (const Tentativa& t : tentativas) {
          // O IAudioClient só aceita Initialize uma vez: cada tentativa é uma ativação nova.
          cliente.Reset();
          ultimo = AtivarPorProcesso(pid_, &cliente);
          if (FAILED(ultimo)) break;  // recusar a ativação não melhora trocando o formato
          const WAVEFORMATEX f = Formato(t.tipo);
          // 200000 × 100 ns = 20 ms de buffer, como na amostra da Microsoft.
          ultimo = cliente->Initialize(AUDCLNT_SHAREMODE_SHARED, t.flags, 200000, 0, &f, nullptr);
          if (SUCCEEDED(ultimo)) {
            tipo = t.tipo;
            break;
          }
        }
        if (SUCCEEDED(ultimo)) {
          ultimo = cliente->SetEventHandle(evento);
          if (SUCCEEDED(ultimo)) ultimo = cliente->GetService(IID_PPV_ARGS(&captura));
          if (SUCCEEDED(ultimo)) ultimo = cliente->Start();
        }
        if (FAILED(ultimo)) {
          erro = "ATIVACAO_RECUSADA: " + Hex(ultimo);
        } else {
          aberta_ok = true;
        }
      }
    }

    aberta.set_value(erro);

    if (aberta_ok) {
      motivo = Capturar(cliente, captura, tipo, evento, processo);
      cliente->Stop();
    }

    captura.Reset();
    cliente.Reset();
    if (evento != nullptr) CloseHandle(evento);
    if (processo != nullptr) CloseHandle(processo);
    if (mmcss != nullptr) AvRevertMmThreadCharacteristics(mmcss);
    if (SUCCEEDED(hrCo)) CoUninitialize();

    // Só avisa o fim de uma captura que chegou a existir; quem pediu para
    // parar não precisa ser avisado do que ele mesmo fez (o JS ignora `parar`).
    if (aberta_ok && motivo != "PARADO") EmitirFim(motivo);
    blocos_.Release();
    fim_.Release();
    // Por último: depois disto `Parar()` pode dar `join()` sem esperar.
    terminou_p_.set_value();
  }

  // O laço: acorda a cada pacote ou a cada 10 ms, esvazia o que chegou e
  // completa com silêncio o que o relógio real diz que já devia ter saído.
  std::string Capturar(const ComPtr<IAudioClient>& cliente, const ComPtr<IAudioCaptureClient>& captura, Amostra tipo, HANDLE evento, HANDLE processo) {
    (void)cliente;
    HANDLE esperar[3] = {parar_, evento, processo};
    const DWORD n = processo != nullptr ? 3 : 2;

    std::vector<float> acumulado;
    acumulado.reserve(kFloatsPorBloco * 4);
    uint64_t quadros_total = 0;  // reais + silêncio, emitidos ou pendentes
    const auto inicio = std::chrono::steady_clock::now();

    auto despachar = [&]() {
      while (acumulado.size() >= kFloatsPorBloco) {
        EmitirBloco(acumulado.data());
        acumulado.erase(acumulado.begin(), acumulado.begin() + static_cast<std::ptrdiff_t>(kFloatsPorBloco));
      }
    };

    while (true) {
      const DWORD w = WaitForMultipleObjects(n, esperar, FALSE, 10);
      if (w == WAIT_OBJECT_0) return "PARADO";
      if (n == 3 && w == WAIT_OBJECT_0 + 2) return "PROCESSO_ENCERROU";
      if (w == WAIT_FAILED) return "FALHOU";

      UINT32 pacote = 0;
      HRESULT hr = captura->GetNextPacketSize(&pacote);
      while (SUCCEEDED(hr) && pacote > 0) {
        BYTE* dados = nullptr;
        UINT32 quadros = 0;
        DWORD flags = 0;
        hr = captura->GetBuffer(&dados, &quadros, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;
        const size_t antes = acumulado.size();
        acumulado.resize(antes + static_cast<size_t>(quadros) * kCanais, 0.0f);
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && dados != nullptr) {
          float* destino = acumulado.data() + antes;
          const size_t total = static_cast<size_t>(quadros) * kCanais;
          if (tipo == Amostra::Float32) {
            std::memcpy(destino, dados, total * sizeof(float));
          } else {
            const int16_t* origem = reinterpret_cast<const int16_t*>(dados);
            for (size_t i = 0; i < total; ++i) destino[i] = static_cast<float>(origem[i]) / 32768.0f;
          }
        }
        quadros_total += quadros;
        captura->ReleaseBuffer(quadros);
        hr = captura->GetNextPacketSize(&pacote);
      }
      if (hr == AUDCLNT_E_DEVICE_INVALIDATED) return "DISPOSITIVO";
      if (FAILED(hr)) return "FALHOU";

      // O relógio real manda no fluxo: o que falta vira silêncio.
      const auto decorrido = std::chrono::steady_clock::now() - inicio;
      const uint64_t devido = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(decorrido).count()) * kTaxa / 1000000ull;
      int silencio = 0;
      while (quadros_total + kQuadrosPorBloco + kMargemDoRelogioEmQuadros <= devido) {
        if (silencio == kMaxBlocosDeSilencioPorVolta) {
          // Pausa longa do relógio: o resto do atraso não é recuperável (já
          // passou), e emitir tudo de uma vez inundaria a fila. Re-ancora.
          quadros_total = devido;
          break;
        }
        acumulado.resize(acumulado.size() + kFloatsPorBloco, 0.0f);
        quadros_total += kQuadrosPorBloco;
        ++silencio;
      }
      despachar();
    }
  }

  const DWORD pid_;
  HANDLE parar_ = nullptr;
  std::thread thread_;
  Napi::ThreadSafeFunction blocos_;
  Napi::ThreadSafeFunction fim_;
  std::atomic<uint64_t> descartados_{0};
  // Sinalizada pelo fim de `Rodar`; `terminou_` é o lado de quem espera.
  std::promise<void> terminou_p_;
  std::shared_future<void> terminou_ = terminou_p_.get_future().share();
};

// ------------------------------------------------------------ exportado

Napi::Value Versao(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "1.0.0");
}

Napi::Value ListarSessoes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string erro;
  std::vector<SessaoListada> lista;
  std::thread t([&]() { lista = ListarNaThread(&erro); });
  t.join();
  if (!erro.empty()) {
    Napi::Error::New(env, erro).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array arr = Napi::Array::New(env, lista.size());
  for (size_t i = 0; i < lista.size(); ++i) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("pid", Napi::Number::New(env, static_cast<double>(lista[i].pid)));
    o.Set("nome", Napi::String::New(env, lista[i].nome));
    o.Set("caminho", Napi::String::New(env, lista[i].caminho));
    o.Set("ativa", Napi::Boolean::New(env, lista[i].ativa));
    arr.Set(static_cast<uint32_t>(i), o);
  }
  return arr;
}

Napi::Value Capturar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsFunction() || !info[2].IsFunction()) {
    Napi::TypeError::New(env, "FALHOU: capturar(pid, aoBloco, aoFim)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double pidNum = info[0].As<Napi::Number>().DoubleValue();
  if (!(pidNum > 4 && pidNum <= 4294967295.0) || pidNum != static_cast<double>(static_cast<DWORD>(pidNum))) {
    Napi::Error::New(env, "PROCESSO_INVALIDO: pid fora da faixa").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const DWORD pid = static_cast<DWORD>(pidNum);

  // Fila FINITA de blocos (S-16): cheia, `NonBlockingCall` devolve
  // `napi_queue_full` e o bloco é descartado e contado. A de fim fica sem teto:
  // leva uma mensagem só, e perdê-la deixaria o app achando que ainda captura.
  auto blocos = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "tela-wasapi-blocos", kFilaMaxima, 1);
  auto fim = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "tela-wasapi-fim", 0, 1);
  auto sessao = std::make_shared<Sessao>(pid, blocos, fim);

  const std::string erro = sessao->Iniciar();
  if (!erro.empty()) {
    Napi::Error::New(env, erro).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object handle = Napi::Object::New(env);
  handle.Set("descartados", Napi::Function::New(env, [sessao](const Napi::CallbackInfo& i) -> Napi::Value {
    return Napi::Number::New(i.Env(), static_cast<double>(sessao->Descartados()));
  }));
  handle.Set("parar", Napi::Function::New(env, [sessao](const Napi::CallbackInfo& i) -> Napi::Value {
    sessao->Parar();
    return i.Env().Undefined();
  }));
  return handle;
}

Napi::Object Iniciar(Napi::Env env, Napi::Object exports) {
  exports.Set("versao", Napi::Function::New(env, Versao));
  exports.Set("listarSessoes", Napi::Function::New(env, ListarSessoes));
  exports.Set("capturar", Napi::Function::New(env, Capturar));
  return exports;
}

}  // namespace

NODE_API_MODULE(wasapi_loopback, Iniciar)
