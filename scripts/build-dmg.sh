#!/bin/bash
# Build MacCleaner DMG using Tauri
set -e

cd "$(dirname "$0")/.."

echo "  🏗️  Building MacCleaner.dmg..."
echo ""

# 1. Build Go backend
echo "  🔨  Building Go backend..."
go build -o mole-tool . 2>&1
echo "  ✅  Go backend built"

# 2. Copy sidecar binary
cp mole-tool src-tauri/binaries/mole-tool-aarch64-apple-darwin

# 3. Ensure create-dmg support files are available
BUNDLE_DIR="src-tauri/target/release/bundle"
mkdir -p "$BUNDLE_DIR/share/create-dmg"
if [ ! -L "$BUNDLE_DIR/share/create-dmg/support" ]; then
  if [ -d "/opt/homebrew/share/create-dmg/support" ]; then
    ln -sf /opt/homebrew/share/create-dmg/support "$BUNDLE_DIR/share/create-dmg/support"
  fi
fi

# 4. Build Tauri app (with locale fix for perl)
echo "  🔨  Building Tauri app..."
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 cargo tauri build 2>&1

# 5. If Tauri build fails at DMG stage, run bundle_dmg.sh manually
DMG_FILE="$BUNDLE_DIR/dmg/MacCleaner_1.0.0_aarch64.dmg"
if [ ! -f "$DMG_FILE" ]; then
  echo "  ⚠️  Tauri DMG build failed, running bundle_dmg.sh manually..."
  LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 "$BUNDLE_DIR/dmg/bundle_dmg.sh" \
    "$DMG_FILE" \
    "$BUNDLE_DIR/macos/MacCleaner.app"
fi

# 6. Copy DMG to project root
cp "$DMG_FILE" MacCleaner.dmg
echo ""
echo "  ✅  MacCleaner.dmg built successfully"
ls -lh MacCleaner.dmg
