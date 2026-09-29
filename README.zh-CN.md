[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

`pi-ui-extension` 是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的终端 UI 增强包，在不修改 Pi Core 的前提下，为全屏 TUI 增加右侧信息栏、会话管理、上下文观察、工具调用统计以及更紧凑的 Footer。

当前包同时支持通过 npm 或 Git 安装，并使用 GitHub Actions 完成类型检查、自动化测试和 npm Trusted Publishing（OIDC）发布。

> [!IMPORTANT]
> `pi-ui-extension` **需要在 Pi 的 fullscreen 模式下使用**。请在 fullscreen 模式下运行 Pi；非 fullscreen 模式不属于本扩展的支持范围，Sidebar、面板尺寸计算及相关布局可能无法正常显示。

## 界面预览

<img width="1377" height="671" alt="pi-ui-extension 界面预览" src="https://github.com/user-attachments/assets/ddea5dc9-8796-433a-abfc-c7ea2adec089" />

## 功能概览

### 1. 右侧 Sidebar

扩展会在 Pi 的全屏 TUI 中挂载右侧 Sidebar。默认包含三个区域：

- **SESSIONS**：最近会话与资源入口。
- **CTX**：当前模型、上下文窗口、组成估算以及运行性能。
- **TOOL VIEW**：工具输出显示模式与 Tool / MCP 调用统计。

Sidebar 支持鼠标交互、滚轮滚动和终端尺寸变化。终端高度不足时，各区域会根据可用空间自动收缩或出现滚动区域。

> 右侧 Sidebar 依赖 **Pi fullscreen 模式**。非 fullscreen 模式不属于本扩展的支持范围，Sidebar、面板尺寸计算及相关布局可能无法正常显示。

### 2. Sessions 会话管理

`SESSIONS` 面板提供最近会话的快速管理：

- 点击会话切换到对应 Session。
- 重命名非当前 Session。
- 删除非当前 Session。
- 使用右上角 `⊗` 清理除当前 Session 外的其他会话。
- 点击 `SESSIONS ↻` 刷新会话列表。

为避免正在执行中的 Agent 状态被破坏，会话切换、重命名、删除和批量清理只会在 Pi 空闲时执行；当前正在使用的 Session 不允许删除。

### 3. 资源快速查看

`SESSIONS` 面板底部提供四类资源入口：

- `AGENTS.md`
- `Skills`
- `Extensions`
- `MCP`

点击后可以直接查看当前项目 / 当前 Pi 环境中已加载的相关资源，便于快速确认 Agent 当前实际使用了哪些上下文、Skill、Extension 和 MCP Server。

### 4. CTX 上下文观察

`CTX` 面板用于观察当前模型请求相关的上下文状态，主要包括：

- 当前模型名称。
- Thinking Level。
- Pi 当前 context usage / context window。
- 当前提问相对上一轮 settled 状态的上下文增量。
- Context composition 分类估算。
- 图片数量。
- 当前 Run 的 turn 数量与耗时。
- 平均 TTFT（Time To First Token）。
- 平均 TPS（Tokens Per Second）。
- 最近一次 TTFT 及速度标签。
- 可观测时显示缓存命中相关数据。

Composition 会将当前可观测上下文拆分为：

- `System`
- `Tools`
- `Messages`
- `Tool Results`
- `Summary`
- `Other`

其中 token 数量是本地启发式估算，主要用于观察组成比例和变化趋势，并不是模型厂商的精确 tokenizer 结果，也不等同于计费 token。

工具定义会优先基于 provider request 中实际可观测到的 tool payload 统计；在请求尚未发生时，则回退到 Pi 当前启用工具的 schema 估算。

### 5. Tool View 模式切换

`TOOL VIEW` 支持三种工具输出显示模式：

- **Normal**：正常显示工具 transcript。
- **Compact**：使用更紧凑的工具输出展示。
- **Hidden**：隐藏工具 transcript。

可以直接使用鼠标点击模式进行切换。

当 Fabric 接管工具展示行为时，扩展会保留 Tool View 面板和调用统计，但不再显示本地模式选择器，并提示 `View controlled by Fabric`，避免与 Fabric 的展示逻辑互相抢占。

### 6. Tool / MCP 调用统计

Tool View 会将调用拆成两类展示：

- `TOOLS`
- `MCP`

每一项使用：

```text
当前提问调用数 / 当前 Session 累计调用数
```

例如：

```text
task_todos                         1/5
```

统计会跟随当前 active branch 重建，切换分支或恢复 Session 时不会简单沿用旧分支的累计结果。

对于通过 MCP gateway、`mcpScript` 等路径发起的调用，扩展会尽量归属到实际 MCP Server，而不是只统计为一个模糊的外层工具调用。

### 7. Footer

扩展替换默认 Footer，保持界面简洁，显示：

- 当前工作目录。
- 当前 Git branch（存在 Git 仓库时）。

路径会自动压缩到终端宽度以内。

## Pi Package Catalog

本包发布到 npm 时包含 `pi-package` keyword 和 Pi manifest，因此具备被 `pi.dev/packages` 的 Pi Package Catalog 发现和索引的条件。包元数据同时声明了上方的预览图，用于 Catalog / Gallery 展示。

## 安装

### 推荐：从 npm 安装

```bash
pi install npm:pi-ui-extension
```

Pi 会安装 package，并将声明写入个人配置：

```text
~/.pi/agent/settings.json
```

对应配置类似：

```json
{
  "packages": [
    "npm:pi-ui-extension"
  ]
}
```

如果希望固定版本：

```bash
pi install npm:pi-ui-extension@1.1.1
```

或者：

```json
{
  "packages": [
    "npm:pi-ui-extension@1.1.1"
  ]
}
```

固定版本属于 pinned package，不会自动移动到后续版本。

### 从 GitHub 安装

也可以直接使用 Git 仓库：

```bash
pi install git:github.com/1993yihuan/pi-ui-extension
```

配置形式：

```json
{
  "packages": [
    "git:github.com/1993yihuan/pi-ui-extension"
  ]
}
```

固定到 Git tag：

```bash
pi install git:github.com/1993yihuan/pi-ui-extension@v1.1.1
```

### 临时试用

如果只想在一次 Pi 启动中测试，不修改 `settings.json`：

```bash
pi -e npm:pi-ui-extension
```

### 项目级安装

需要只对当前项目生效时：

```bash
pi install --local npm:pi-ui-extension
```

声明会写入：

```text
<project>/.pi/settings.json
```

项目级 Package 只有在项目被 Pi 信任后才会加载。

## 更新与卸载

更新未固定版本的扩展：

```bash
pi update --extensions
```

查看当前配置的 Package：

```bash
pi list
```

卸载 npm 版本：

```bash
pi remove npm:pi-ui-extension
```

如果安装的是 Git 源，则使用对应 Git source 删除：

```bash
pi remove git:github.com/1993yihuan/pi-ui-extension
```

## npm 与 Git 应该选哪个？

日常使用推荐 npm：

```text
npm:pi-ui-extension
```

优点是版本语义清晰、安装速度稳定，并且可以直接固定 SemVer 版本。

如果希望始终跟随仓库最新代码，或者需要测试尚未发布到 npm 的提交，可以使用：

```text
git:github.com/1993yihuan/pi-ui-extension
```

本地开发阶段则推荐直接加载本地源码目录，避免每次调试都必须 commit / push / update。

## 本地开发

克隆仓库：

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
```

安装开发依赖：

```bash
npm ci
```

完整检查：

```bash
npm run check
```

等价于：

```bash
npm run typecheck
npm test
```

当前自动化测试覆盖 Sidebar、CTX、Session、Tool View、MCP resource、Fabric detection、鼠标滚轮 / resize 等主要行为。

开发时可以直接让 Pi 加载本地目录：

```bash
pi install ./path/to/pi-ui-extension
```

或者在一次启动中临时加载：

```bash
pi -e ./path/to/pi-ui-extension
```

## Package 结构

```text
pi-ui-extension/
├── extensions/
│   ├── ctx/                 # 上下文组成、增量与运行性能
│   ├── footer/              # Footer
│   ├── mcp/                 # MCP resource / usage 集成
│   ├── session/             # Session 列表与操作
│   ├── sidebar/             # Sidebar 布局、滚动和 resize
│   ├── tool-view/           # Tool View 模式与调用统计
│   ├── fabric-detection.ts  # Fabric 工具接管检测
│   └── index.ts             # Pi Extension 入口
├── .github/workflows/
│   ├── ci.yml               # push / PR 自动检查
│   └── release.yml          # tag 自动发布 npm + GitHub Release
├── package.json
└── tsconfig.check.json
```

Pi 的扩展入口在 `package.json` 中显式声明：

```json
{
  "pi": {
    "extensions": [
      "./extensions/index.ts"
    ]
  }
}
```

## CI / Release

提交到 `main` 或创建 PR 时，GitHub Actions 会自动执行：

```text
npm ci
→ npm run typecheck
→ npm test
```

发布版本时使用 Git tag，例如：

```bash
npm version patch
git push
git push --tags
```

`v*` tag 会触发 Release workflow：

```text
Checkout
→ Node.js 24
→ npm ci
→ npm run check
→ 校验 tag 与 package.json version
→ npm pack --dry-run
→ npm Trusted Publishing (OIDC)
→ npm publish
→ GitHub Release
```

npm 发布使用 GitHub Actions OIDC Trusted Publishing，不需要在 GitHub Repository 中保存长期 `NPM_TOKEN`。

## 兼容性与设计原则

- 不修改 Pi Core。
- Pi host 提供的 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 使用 `peerDependencies`，避免产生重复运行时实例。
- 对 Fabric 做显式检测，避免 Tool View 模式控制发生冲突。
- Session 与资源操作尽量通过 Pi 已公开 API 完成。
- Context composition 明确标记为估算值，不冒充 provider 精确 token 统计。
- fullscreen Sidebar 不可用时安全降级，不影响 Pi 主流程。

## Requirements

- Pi Coding Agent
- Node.js `>= 22.19.0`（建议使用当前 Pi 支持的 Node 版本）
- 开发与 CI 当前使用 Node.js 24

## License

本项目采用 [MIT License](LICENSE) 开源许可证。
