#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo ""
echo "  🛠️  Mole 助手 — 安装系统服务"
echo "  ─────────────────────────────"

# Check mo
if ! command -v mo &>/dev/null; then
  echo "  ❌ mo 未安装。请先运行: brew install mo"
  exit 1
fi

# Build
echo "  🔨 编译 Go 后端..."
go build -o mole-tool . 2>&1 || { echo "  ❌ 编译失败"; exit 1; }
echo "  ✅ 编译成功"

BIN_DIR="$(pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.mole-tool.plist"
PLIST_LABEL="com.mole-tool"

# Unload existing if any
launchctl unload -w "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BIN_DIR}/mole-tool</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>NO_PROXY</key>
        <string>localhost,127.0.0.1,::1</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${BIN_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mole-tool.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mole-tool.log</string>
</dict>
</plist>
PLIST

echo "  📝 已创建 LaunchAgent: $PLIST_PATH"

launchctl load -w "$PLIST_PATH" 2>&1
echo "  ✅ 服务已注册并启动"

sleep 2
if lsof -ti :4399 &>/dev/null 2>&1; then
  echo "  🚀 服务就绪 → http://localhost:4399"
  open "http://localhost:4399"
else
  echo "  ⏳ 等待服务就绪..."
  sleep 3
  open "http://localhost:4399"
fi

echo ""
echo "  管理命令："
echo "    状态:  launchctl list com.mole-tool"
echo "    停止:  launchctl unload -w $PLIST_PATH"
echo "    启动:  launchctl load -w $PLIST_PATH"
echo "    日志:  tail -f /tmp/mole-tool.log"
echo "    卸载:  launchctl unload -w $PLIST_PATH && rm $PLIST_PATH"
echo ""
