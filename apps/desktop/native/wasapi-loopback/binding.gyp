{
  # O addon do "só o jogo" no Windows (D3, docs/desktop/D3-som.md): captura o
  # áudio de UM processo (e dos filhos dele) pela API de process loopback do
  # WASAPI. Só compila no Windows; nas outras plataformas o alvo é vazio, para
  # `node-gyp rebuild` não falhar numa máquina que não precisa dele.
  #
  # Compilar para o Electron (não para o Node do sistema) — o `scripts/
  # build-wasapi.mjs` faz isto com a versão do Electron do package.json:
  #   node-gyp rebuild --target=<versão do Electron> --arch=x64 \
  #     --dist-url=https://electronjs.org/headers
  "targets": [
    {
      "target_name": "wasapi_loopback",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/wasapi_loopback.cc"],
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
          "defines": [
            "NAPI_VERSION=8",
            "NAPI_CPP_EXCEPTIONS",
            "UNICODE",
            "_UNICODE",
            "WIN32_LEAN_AND_MEAN",
            "NOMINMAX"
          ],
          "libraries": ["mmdevapi.lib", "ole32.lib", "avrt.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              # Exceções C++ ligadas (node-addon-api as usa) e C++20, que os
              # cabeçalhos do Node 24 / V8 do Electron 44 exigem.
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++20"]
            }
          }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
