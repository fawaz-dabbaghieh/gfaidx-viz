#!/usr/bin/env bash

# BubbleGun2 WASM Build Script
# Requires Emscripten SDK to be installed and activated

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${SCRIPT_DIR}/.build"
OUTPUT_DIR="${PROJECT_ROOT}/js"

echo "=== BubbleGun2 WASM Build Script ==="
echo ""

if [[ ! -f "${SCRIPT_DIR}/bubblegun2/CMakeLists.txt" ]]; then
    echo "ERROR: bubblegun2 was not found at ${SCRIPT_DIR}/bubblegun2" >&2
    echo "Initialize the submodule with: git submodule update --init bubbles_wasm/bubblegun2" >&2
    exit 1
fi

# Auto-detect and source Emscripten if needed
if ! command -v emcc &> /dev/null; then
    echo "Emscripten not in PATH, attempting to activate..."

    EMSDK_PATHS=(
        "$HOME/emsdk/emsdk_env.sh"
        "/opt/emsdk/emsdk_env.sh"
        "/usr/local/emsdk/emsdk_env.sh"
    )

    EMSDK_FOUND=false
    for EMSDK_PATH in "${EMSDK_PATHS[@]}"; do
        if [ -f "$EMSDK_PATH" ]; then
            echo "Found Emscripten at: $EMSDK_PATH"
            source "$EMSDK_PATH"
            EMSDK_FOUND=true
            break
        fi
    done

    if [ "$EMSDK_FOUND" = false ]; then
        echo "ERROR: emcc (Emscripten compiler) not found!"
        echo "Please install and activate Emscripten SDK (see layout_wasm/build.sh)."
        exit 1
    fi
fi

echo "✓ Emscripten found: $(emcc --version | head -n 1)"
echo ""

echo "Configuring BubbleGun2..."
emcmake cmake \
    -S "${SCRIPT_DIR}" \
    -B "${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release

echo "Building BubbleGun2..."
cmake --build "${BUILD_DIR}" --parallel

echo ""
echo "Copying output files to ${OUTPUT_DIR}/..."
mkdir -p "${OUTPUT_DIR}"
cp "${BUILD_DIR}/bubblegun.js" "${OUTPUT_DIR}/"
cp "${BUILD_DIR}/bubblegun.wasm" "${OUTPUT_DIR}/"

echo ""
echo "=== Build Complete! ==="
echo "Output files:"
echo "  - ${OUTPUT_DIR}/bubblegun.js"
echo "  - ${OUTPUT_DIR}/bubblegun.wasm"
echo ""
echo "Total WASM size: $(du -h "${OUTPUT_DIR}/bubblegun.wasm" | cut -f1)"
echo ""
