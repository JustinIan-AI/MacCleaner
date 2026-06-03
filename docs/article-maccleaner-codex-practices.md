# 我用 AI 编码助手开发了一款 macOS 清理工具：Codex CLI 最佳实践全记录

> 作者：JustinIan | 公众号：AI Agentic共创

---

## 缘起：一个"洁癖"的自我修养

作为 macOS 用户，你一定有过这样的体验：

- 硬盘空间莫名被"其他"占满
- 卸载应用后残留文件散落各处
- 各种缓存、日志动辄几十 GB
- 想清理却发现系统自带的存储管理远不够用

市面上清理工具不少——CleanMyMac、DaisyDisk、OmniDiskSweeper……但要么收费，要么功能单一，要么不够透明（谁知道自己点下"清理"后到底删了什么？）。

直到我发现了一个叫 [mole](https://github.com/tw93/Mole) 的开源工具——它是用 Go 写的命令行工具，支持应用卸载、磁盘分析、构建产物清理等 9 大功能模块。但问题是：**它是 CLI 工具**，对普通用户不够友好。

于是我想：能不能基于 mole 的能力，快速封装一个 Web 界面，让清理变得可视化、可交互？

我选择了 **Codex CLI**（OpenAI 的 AI 编码助手）来完成这个任务。这篇文章记录了我从零开发 **MacCleaner** 的完整历程，以及从中总结的**用 AI 开发小工具的最佳实践**。

---

## 项目概览

| 项目 | 内容 |
|------|------|
| **工具名称** | MacCleaner |
| **核心能力** | 基于 mole 的 macOS 清理 Web 界面 |
| **技术栈** | Go 后端 + 原生 HTML/JS 前端 + Tauri 桌面打包 |
| **开发工具** | Codex CLI (OpenAI) |
| **代码仓库** | [github.com/JustinIan-AI/MacCleaner](https://github.com/JustinIan-AI/MacCleaner) |
| **开发时长** | 约 3 小时（含问题处理） |

---

## 一、技术选型：为什么这么选？

### 后端：Go —— 轻量且强大

mole 本身就是 Go 写的，所以后端继续用 Go 是自然选择。但更深层的原因是：

- **单二进制分发**：编译后只有一个文件，不需要运行时依赖
- **启动快**：毫秒级启动，作为本地工具体验极佳
- **安装简单**：`go build` 搞定，开发者友好
- **跨平台**：虽然主要目标 macOS，但核心逻辑可复用

### 前端：原生 HTML/CSS/JS —— 够用就好

没有选择 React、Vue 等框架，原因很简单：

- 单页面应用，交互复杂度不高
- 零构建步骤，开发效率最高
- 热更新无需构建，改完刷新就能看到
- 与 Go 的嵌入式 `embed` 结合最自然

关键代码结构：

```
web/
├── index.html    # 主页面 + macOS 原生风格 CSS
└── app.js        # 所有前端逻辑（~600 行）
```

### 打包：Tauri —— 给 Web 套上原生外壳

为了让普通用户也能使用，最终的交付物是一个 `.dmg` 安装包。选择了 **Tauri** 而非 Electron：

- **包体小**：最终 DMG 仅 6.3MB（Electron 通常 100MB+）
- **内存低**：Rust 编写的原生窗口
- **安全**：可以利用 Tauri 的权限模型控制侧车进程

### 风格：macOS 原生设计

前端采用了 macOS 原生风格设计——使用 `-apple-system` 字体、`NSVisualEffectView` 风格的毛玻璃效果、系统原生配色。目标是：**让用户感觉这就是一个 macOS 原生应用**。

---

## 二、开发历程：从原型到交付

### Phase 1：快速原型（30 分钟）

第一步是让 mole 的 CLI 能力通过 HTTP 暴露出来。创建了一个 Go HTTP 服务器，将 mole 的每个功能模块封装为 API 端点：

```
/api/disk/scan       → 磁盘扫描
/api/disk/delete     → 文件删除
/api/uninstall/scan  → 应用扫描
/api/uninstall/run   → 应用卸载
/api/purge/scan      → 构建产物扫描
……
```

前端是纯静态页面，通过 `fetch` 调用这些 API。**30 分钟内就有了可交互的原型。**

### Phase 2：功能完善（1 小时）

- **系统健康页面**：调用系统命令获取 CPU、内存、磁盘信息
- **深度清理**：支持按路径扫描，白名单保护重要文件
- **卸载应用**：扫描已安装应用，展示大小和安装时间
- **操作历史**：记录每次清理操作
- **风险提示**：每个危险操作前展示影响范围和风险等级

### Phase 3：桌面打包（30 分钟）

使用 Tauri 将 Web 应用打包为原生 macOS 应用：

- 创建 Tauri 项目配置
- 将 Go 后端作为 Tauri 侧车（sidecar）进程
- 配置图标、应用名、包标识符
- 生成 `.dmg` 安装包

### Phase 4：隐私清理与发布（30 分钟）

这是最容易被忽视的一步——**检查二进制文件中的隐私信息**。

---

## 三、踩过的坑（含解决方案）

### 🔥 坑 1：Go 二进制泄露绝对路径

```bash
strings mole-tool | grep "/Users/yourname"
# 输出: /Users/freecisco_yan/Documents/.../main.go
```

**问题**：Go 默认将源码路径嵌入二进制，用于错误栈追踪。这意味着你的用户名和项目路径会暴露在二进制文件中。

**解决方案**：
```bash
go build -ldflags="-s -w" -trimpath -o mole-tool .
```
- `-trimpath`：移除 GOPATH 路径前缀
- `-ldflags="-s -w"`：去除调试符号

### 🔥 坑 2：Rust 二进制中的 Cargo 路径

Tauri 的 Rust 二进制中也包含了大量路径信息：

```
/Users/freecisco_yan/.cargo/registry/src/.../tao/src/platform_impl/macos/window.rs
```

这是 Rust 的 `file!()` 宏导致的，所有 Rust 二进制都有此问题。这些路径来自第三方依赖库的源码，**不包含用户数据**，属于可接受范围。但如果你特别在意隐私，可以在 `Cargo.toml` 中添加：

```toml
[profile.release]
panic = "abort"
strip = true
lto = true
opt-level = "s"
```

### 🔥 坑 3：macOS 权限确认弹窗

第一次运行卸载功能时，mole 会弹出 "Terminal wants to control System Events" 的权限确认框。这是 macOS 的安全机制，**不是 bug**。需要在 系统设置 → 隐私与安全性 → 自动化 中授权。

### 🔥 坑 4：前端页面路由问题

开发过程中多次遇到"点击功能模块无法进入功能页"的问题。根因是：

1. 哈希路由的 `hashchange` 事件绑定时机问题
2. 卡片式首页点击后未正确同步导航状态

**解决方案**：使用事件委托 + 统一的路由管理函数。

### 🔥 坑 5：构建产物包含不该有的文件

`.gitignore` 中需要仔细配置。一开始遗漏了 `node_modules/`，差点提交到仓库。最终的 `.gitignore` 配置：

```
# Binary
mole-tool
mole-tool.exe

# DMG package
MacCleaner.dmg

# Tauri build artifacts
src-tauri/target/
src-tauri/binaries/
src-tauri/icons/
src-tauri/gen/
src-tauri/Cargo.lock

# JS
node_modules/
```

---

## 四、用 Codex CLI 开发小工具的最佳实践

经过这次实践，我总结了以下经验：

### 1️⃣ 明确告诉 AI"不要做什么"

AI 编码助手倾向于"做更多"——增加炫酷功能、优化代码结构、添加注释。**你需要明确约束**：

> "不要添加不必要的功能"
> "不要修改无关代码"
> "不要注释代码"

在项目根目录放一个 `AGENTS.md` 文件，可以持续约束 AI 的行为。

### 2️⃣ 分阶段交付，每个阶段可验证

不要一次性让 AI 完成所有功能。分成：

> Phase 1：原型可运行 → 验证核心流程
> Phase 2：功能完善 → 逐个验证
> Phase 3：打包发布 → 完整验证

每个阶段结束后**明确告诉 AI 下一步要做什么**。

### 3️⃣ 使用"专业模式"引导 AI

Codex CLI 支持 `$skill_name` 来激活特定技能：

- `$superpowers:writing-plans`：生成实现计划
- `$huashu-design`：前端页面设计
- `$superpowers:systematic-debugging`：系统性调试

这些技能让 AI 在特定任务上表现更好。

### 4️⃣ 总是检查 AI 产物的隐私安全

AI 生成的代码通常只关注功能正确性，很少考虑隐私。**你必须主动检查**：

- 二进制中是否有绝对路径？
- 配置文件中是否有个人信息？
- 日志中是否记录了敏感信息？

### 5️⃣ 让 AI 做 AI 擅长的事，自己做自己擅长的事

AI 擅长：
- 快速生成模板代码
- 实现明确的功能需求
- 定位和修复错误

人类擅长：
- 架构决策（用 Go 还是 Python？）
- 安全审计（哪些信息不该暴露？）
- 用户体验判断（这个交互是否自然？）

**不要期望 AI 替你思考，而是让 AI 替你执行。**

### 6️⃣ 迭代式开发，而不是一次完成

每个功能点通过"需求 → 实现 → 验证 → 反馈"循环完成。不要试图在一条 prompt 中完成所有功能。

### 7️⃣ 利用子代理（Subagent）并行工作

Codex CLI 支持创建子代理来处理独立任务。例如：

- 一个子代理处理 Go 后端 API
- 另一个子代理处理前端页面

这样可以并行工作，大幅缩短开发时间。

### 8️⃣ 关注二进制大小和构建产物

AI 生成的代码往往不考虑优化。开发完成后，检查：

- 二进制大小（6.3MB vs 可能的 100MB+）
- 是否需要去除调试符号
- 是否有不必要的依赖

### 9️⃣ 建立测试和验证流程

对于清理工具这类有风险的操作，一定要建立验证流程：

- 所有危险操作前置风险提示
- Dry-run 模式预览影响
- 操作可追溯（操作历史）

### 🔟 文档与推广

开发完成不代表结束。写一篇好的 README、录制使用视频、发布到合适的平台，这些和开发同样重要。

---

## 五、最终成果

| 指标 | 数据 |
|------|------|
| 代码行数 | ~1,400 行 |
| 技术栈 | Go + HTML/JS + Tauri |
| DMG 大小 | 6.3 MB |
| 功能模块 | 9 个 |
| 开发时长 | ~3 小时 |
| 发布渠道 | GitHub Releases |

**获取方式**：
- GitHub：[github.com/JustinIan-AI/MacCleaner](https://github.com/JustinIan-AI/MacCleaner)
- 直接下载 DMG：[Release v0.1.0](https://github.com/JustinIan-AI/MacCleaner/releases/tag/release-v0.1.0)

---

## 六、写在最后

用 AI 编码助手开发工具，**最重要的不是让 AI 替你写代码，而是你清楚的知道要做什么、怎么做、以及如何验证 AI 的产出**。

AI 是你的"高级实习生"——执行力强但需要指导。你提供方向和判断，AI 提供速度和执行。

这次 MacCleaner 的开发让我确信：**个人开发者用 AI 辅助，可以在数小时内完成过去需要数天的工具开发**。关键在于知道如何与 AI 协作、如何设置约束、以及如何保证最终产物的质量。

如果你也对用 AI 开发工具有兴趣，欢迎关注我的公众号 **"AI Agentic共创"**，我会持续分享更多实践经验和开源项目。

---

> 扫码关注，获取更多 AI 开发实践

![公众号二维码](laoyan-wechat.png)

---

*本文由 JustinIan 使用 AI 辅助撰写。MacCleaner 基于 [mole](https://github.com/tw93/Mole) 构建，感谢 tw93 的开源贡献。*
