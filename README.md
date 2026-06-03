# MacCleaner 🧹

A macOS system cleanup tool with a web UI, powered by [mole](https://github.com/farcaller/mole).

## Features

- 🩺 **System Health** — Disk, CPU, memory monitoring
- 🧹 **Deep Clean** — Scan and clean caches, logs, developer files
- 🗑️ **App Uninstall** — Uninstall apps with all leftover data
- 🏗️ **Build Artifacts** — Clean node_modules, target, build dirs
- 📊 **Disk Analysis** — Analyze disk usage and find cleanup opportunities
- ⚙️ **System Optimization** — DNS flush, service restarts
- 🗂️ **Installer Cleanup** — Remove .dmg / .pkg files

## Quick Start

```bash
# Prerequisites
brew install mo

# Build & run
go build -o mole-tool .
./mole-tool
# → http://localhost:4399
```

Or use the start script: `./start.sh`

## Install as Service (LaunchAgent)

```bash
./scripts/install-service.sh
```

## Tech Stack

- **Backend:** Go (net/http, embedded web assets)
- **Frontend:** Vanilla JS, CSS (macOS native style)
- **Engine:** [mole](https://github.com/farcaller/mole) CLI for cleanup operations
