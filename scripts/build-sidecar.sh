#!/usr/bin/env bash
# Build Go sidecar for current platform
# Usage: bash scripts/build-sidecar.sh [--release]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../sidecar"
BIN_DIR="$SIDECAR_DIR/bin"

mkdir -p "$BIN_DIR"

OUTPUT_NAME="starhub-sidecar"
TARGET_OS="${GOOS:-}"
if [[ -z "$TARGET_OS" ]]; then
    case "$OSTYPE" in
        msys*|cygwin*|win32*) TARGET_OS="windows" ;;
        darwin*) TARGET_OS="darwin" ;;
        *) TARGET_OS="linux" ;;
    esac
fi
if [[ "$TARGET_OS" == "windows" ]]; then
    OUTPUT_NAME="${OUTPUT_NAME}.exe"
fi

OUTPUT_PATH="$BIN_DIR/$OUTPUT_NAME"
TARGET_ARCH="${GOARCH:-$(uname -m)}"
case "$TARGET_ARCH" in
    x86_64) TARGET_ARCH="amd64" ;;
    aarch64) TARGET_ARCH="arm64" ;;
esac
if [ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]; then
    TARGET_TRIPLE="$TAURI_ENV_TARGET_TRIPLE"
else
    case "$TARGET_OS/$TARGET_ARCH" in
        windows/amd64) TARGET_TRIPLE="x86_64-pc-windows-msvc" ;;
        windows/arm64) TARGET_TRIPLE="aarch64-pc-windows-msvc" ;;
        darwin/amd64) TARGET_TRIPLE="x86_64-apple-darwin" ;;
        darwin/arm64) TARGET_TRIPLE="aarch64-apple-darwin" ;;
        linux/amd64) TARGET_TRIPLE="x86_64-unknown-linux-gnu" ;;
        linux/arm64) TARGET_TRIPLE="aarch64-unknown-linux-gnu" ;;
        *) echo "Unsupported Sidecar target: $TARGET_OS/$TARGET_ARCH" >&2; exit 1 ;;
    esac
fi

LDFLAGS="-s -w"
if [[ "${1:-}" == "--release" && "$TARGET_OS" == "windows" ]]; then
    LDFLAGS="$LDFLAGS -H windowsgui"
fi

echo "Building sidecar..."
echo "  Source: $SIDECAR_DIR"
echo "  Output: $OUTPUT_PATH"

cd "$SIDECAR_DIR"
CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o "$OUTPUT_PATH" .
echo "Sidecar built successfully: $OUTPUT_PATH"
EXTENSION=""
if [[ "$TARGET_OS" == "windows" ]]; then EXTENSION=".exe"; fi
BUNDLED_PATH="$BIN_DIR/starhub-sidecar-$TARGET_TRIPLE$EXTENSION"
cp "$OUTPUT_PATH" "$BUNDLED_PATH"
echo "  Target-tagged sidecar: $BUNDLED_PATH"
