# MacCleaner 🧹

macOS 系统清理工具，基于 [mole](https://github.com/tw93/Mole) 构建的 Web 界面。

## 功能

- 🩺 **系统健康** — 磁盘、CPU、内存监测
- 🧹 **深度清理** — 扫描并清理缓存、日志、开发者文件
- 🗑️ **卸载应用** — 彻底卸载应用及残留数据
- 🏗️ **构建产物** — 清理 node_modules、target、build 等目录
- 📊 **磁盘分析** — 分析磁盘使用，发现可清理空间
- ⚙️ **系统优化** — DNS 刷新、服务重启
- 🗂️ **安装包清理** — 清理 .dmg / .pkg 安装文件

## 快速开始

```bash
# 前提条件
brew install mo

# 编译并运行
go build -o macleaner .
./macleaner
# → http://localhost:4399
```

或使用启动脚本: `./start.sh`

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
