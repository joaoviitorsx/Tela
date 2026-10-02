#!/bin/sh
# Compila o tela-captura. Precisa dos cabeçalhos do GStreamer e do GLib:
#   Fedora: dnf install gcc gstreamer1-devel gstreamer1-plugins-base-devel glib2-devel
#   Debian/Ubuntu: apt install gcc libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libglib2.0-dev
# Em tempo de execução: gstreamer1-plugins-bad (nvcodec), pipewire-gstreamer e
# os plugins GL do plugins-base — o app checa e cai no codificador do Chromium.
set -eu
cd "$(dirname "$0")"
mkdir -p build
PKGS="${PKGS_EXTRA:-}gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gio-2.0 gio-unix-2.0"
# Hardening (S-19): canário de pilha, _FORTIFY_SOURCE, PIE e RELRO total. O
# -O2 abaixo é o que liga o _FORTIFY_SOURCE de verdade; sem ele o glibc o ignora.
# `-U` antes de `-D`: algumas distros já definem o macro em outro nível.
# shellcheck disable=SC2046
${CC:-cc} -O2 -Wall -Wextra -Wno-unused-parameter -Wformat -Wformat-security -std=gnu11 \
  -fstack-protector-strong -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now \
  -o build/tela-captura tela-captura.c -lm $(pkg-config ${PKG_CONFIG_FLAGS:-} --cflags --libs $PKGS)
echo "build/tela-captura"
