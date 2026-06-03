# MacCleaner 🧹

macOS 系统清理工具，基于 [mole](https://github.com/tw93/Mole) 构建的 Web 界面，降低使用门槛，轻松清理你的 Mac 笔记本。

## 功能

- 🩺 **系统健康** — 磁盘、CPU、内存监测
- 🧹 **深度清理** — 扫描并清理缓存、日志、开发者文件
- 🗑️ **卸载应用** — 彻底卸载应用及残留数据
- 🏗️ **构建产物** — 清理 node_modules、target、build 等目录
- 📊 **磁盘分析** — 分析磁盘使用，发现可清理空间
- ⚙️ **系统优化** — DNS 刷新、服务重启
- 🗂️ **安装包清理** — 清理 .dmg / .pkg 安装文件

> **⚠️ 风险提示**：所有清理操作均基于 mole 引擎，缓存清理后会自动重建，应用卸载后不可恢复。操作前请确认所选项目。

## ❗ 常见问题

### macOS 提示"安装包已损坏"或"无法验证开发者"

如果 macOS 提示 MacCleaner 已损坏或无法验证开发者，请在终端执行以下命令后重新打开：

```bash
sudo xattr -rd com.apple.quarantine /Applications/MacCleaner.app
```

## 快速开始

```bash
# 前提条件（工具会自动检测并安装）
brew install mole

# 编译并运行
go build -o maccleaner .
./maccleaner
# → http://localhost:4399
```

> **注意**：MacCleaner 启动时会自动检测 `mo` 命令是否可用，如果未安装则会自动执行 `brew install mole` 安装，请耐心等待安装完成。

## 安装为系统服务 (LaunchAgent)

```bash
./scripts/install-service.sh
```

## 作者

**JustinIan**

公众号: **AI Agentic共创**

![公众号二维码](docs/laoyan-wechat.png)

## 技术栈

- **后端:** Go (net/http, 嵌入式 Web 资源)
- **前端:** 原生 JavaScript + CSS (macOS 原生风格)
- **清理引擎:** [mole](https://github.com/tw93/Mole)
