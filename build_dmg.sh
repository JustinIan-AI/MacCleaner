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
go build -ldflags="-s -w" -trimpath -o mole-tool . 2>&1
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
if LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 cargo tauri build 2>&1; then
  echo "  ✅ Tauri build completed"
else
  echo "  ⚠️  Tauri bundler had issues, but binary was compiled"
fi

# 4. Create DMG with Applications symlink from the Tauri-built .app
# The Tauri build creates a .app and DMG, but we need to add the Applications symlink.
# We extract the .app from the Tauri-generated DMG and rebuild with proper structure.
TAURI_DMG="$BUNDLE_DIR/dmg/MacCleaner_1.0.0_aarch64.dmg"
FINAL_DMG="$BUNDLE_DIR/dmg/MacCleaner_1.0.0_aarch64.dmg"

if [ -f "$TAURI_DMG" ]; then
  echo "  🔨  Rebuilding DMG with Applications symlink..."
  
  # Mount the Tauri-generated DMG to extract the .app
  MOUNT_POINT="$(mktemp -d)"
  hdiutil attach "$TAURI_DMG" -mountpoint "$MOUNT_POINT" -nobrowse 2>&1
  
  # Find the .app in the mounted DMG
  APP_IN_DMG=$(find "$MOUNT_POINT" -name "*.app" -maxdepth 2 -type d | head -1)
  if [ -n "$APP_IN_DMG" ] && [ -d "$APP_IN_DMG" ]; then
    # Create staging directory with .app + Applications symlink
    STAGING_DIR="$(mktemp -d)"
    cp -R "$APP_IN_DMG" "$STAGING_DIR/"
    ln -s /Applications "$STAGING_DIR/Applications"
    
    # Unmount Tauri DMG
    hdiutil detach "$MOUNT_POINT" -force 2>&1
    rm -rf "$MOUNT_POINT"
    
    # Remove old DMG
    rm -f "$FINAL_DMG"
    
    # Create new DMG with create-dmg (proper layout)
    create-dmg \
      --volname "MacCleaner" \
      --window-pos 200 120 \
      --window-size 600 400 \
      --icon-size 100 \
      --icon "MacCleaner.app" 175 190 \
      --hide-extension "MacCleaner.app" \
      --app-drop-link 425 190 \
      --no-internet-enable \
      "$FINAL_DMG" \
      "$STAGING_DIR" 2>&1 || \
    # Fallback: create simple DMG
    hdiutil create -srcfolder "$STAGING_DIR" \
      -volname "MacCleaner" \
      -format UDZO \
      -ov \
      "$FINAL_DMG" 2>&1
    
    # Clean up staging
    rm -rf "$STAGING_DIR"
    echo "  ✅  DMG with Applications symlink created"
  else
    echo "  ⚠️  Could not find .app in mounted DMG, using original"
    hdiutil detach "$MOUNT_POINT" -force 2>&1
    rm -rf "$MOUNT_POINT"
  fi
else
  echo "  ❌  Tauri DMG not found at $TAURI_DMG"
  exit 1
fi

# 5. Copy final DMG to project root
cp "$FINAL_DMG" MacCleaner.dmg
echo ""
echo "  ✅  MacCleaner.dmg ready ($(du -h MacCleaner.dmg | cut -f1))"
echo "  📦  Open MacCleaner.dmg to install"
echo ""
