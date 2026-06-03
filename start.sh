#!/bin/bash

cd "$(dirname "$0")"

echo ""
echo "  🛠️  MacCleaner — 构建 & 启动"
echo "  ─────────────────────────────"

# Check mo
if ! command -v mo &>/dev/null; then
  echo "  ❌ mo 未安装。请先运行: brew install mo"
  exit 1
fi

PORT="${MOLE_TOOL_PORT:-4399}"

# Build
echo "  🔨 编译 Go 后端..."
go build -o mole-tool . 2>&1 || { echo "  ❌ 编译失败"; exit 1; }
echo "  ✅ 编译成功"

# Use nohup to daemonize
pkill -f "mole-tool" 2>/dev/null || true
sleep 1
nohup ./mole-tool &>/tmp/mole-tool.log &
PID=$!

echo "  🚀 启动服务 (PID: $PID)"

sleep 2
if lsof -p "$PID" -i :"$PORT" &>/dev/null 2>&1 || curl -s --noproxy '*' "http://localhost:$PORT/" >/dev/null 2>&1; then
  echo "  ✅ 服务已就绪 → http://localhost:$PORT"
  open "http://localhost:$PORT"
else
  echo "  ⚠️  服务可能未就绪，检查日志: tail -f /tmp/mole-tool.log"
fi
echo ""
echo "  日志: tail -f /tmp/mole-tool.log"
echo "  停止: kill $PID"
echo ""
