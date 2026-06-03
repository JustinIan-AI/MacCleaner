#!/bin/bash
# Build MacCleaner.dmg — Tauri-based macOS app bundle
set -e

echo ""
echo "  🏗️  MacCleaner — Build DMG"
echo "  ────────────────────────"
echo ""

cd "$(dirname "$0")"

# 1. Build Go backend
echo "  🔨  Compiling Go backend..."
go build -o mole-tool . 2>&1
echo "  ✅  Go backend compiled"

# 2. Copy sidecar binary for Tauri
cp mole-tool src-tauri/binaries/mole-tool-aarch64-apple-darwin

# 3. Run Tauri build (ignoring the bundle_dmg.sh step which has macOS locale issues)
echo "  🔨  Building Tauri app..."
BUNDLE_DIR="src-tauri/target/release/bundle"
mkdir -p "$BUNDLE_DIR/share/create-dmg"
[ ! -L "$BUNDLE_DIR/share/create-dmg/support" ] && [ -d "/opt/homebrew/share/create-dmg/support" ] && \
  ln -sf /opt/homebrew/share/create-dmg/support "$BUNDLE_DIR/share/create-dmg/support"

# First try full Tauri build
if LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 cargo tauri build 2>/dev/null; then
  echo "  ✅ Tauri build completed"
else
  echo "  ⚠️  Tauri bundler had issues, but binary was compiled"
fi

# 4. Create DMG directly from the .app bundle using hdiutil
APP_PATH="$BUNDLE_DIR/macos/MacCleaner.app"
DMG_OUTPUT="$BUNDLE_DIR/dmg/MacCleaner_1.0.0_aarch64.dmg"

if [ -d "$APP_PATH" ]; then
  echo "  🔨  Creating DMG with hdiutil..."
  rm -f "$DMG_OUTPUT" "$BUNDLE_DIR/dmg"/rw.*.dmg 2>/dev/null
  hdiutil create -srcfolder "$APP_PATH" \
    -volname "MacCleaner" \
    -format UDZO \
    -ov \
    "$DMG_OUTPUT" 2>&1
  echo "  ✅  DMG created"
else
  echo "  ❌  App bundle not found at $APP_PATH"
  exit 1
fi

# 5. Copy final DMG to project root
cp "$DMG_OUTPUT" MacCleaner.dmg
echo ""
echo "  ✅  MacCleaner.dmg ready ($(du -h MacCleaner.dmg | cut -f1))"
echo "  📦  Open MacCleaner.dmg to install"
echo ""
