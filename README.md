# pi-ui-extension

为 Pi Coding Agent 提供更完整的终端 UI：右侧多面板信息栏、会话管理、上下文占用分析、工具调用统计与工具输出显示模式切换。

这个扩展不会修改 Pi Core，而是通过 Pi 的扩展机制增强全屏终端界面，适合需要长时间使用 Pi、同时关注上下文消耗、会话状态和工具调用情况的用户。

## 功能概览

### 右侧 Sidebar

在 Pi 全屏模式下自动挂载右侧 Sidebar，将常用运行信息集中到一个固定区域，避免频繁切换命令或翻阅上下文。

Sidebar 支持：

- 根据终端宽度自动显示或隐藏。
- 鼠标拖动分隔线调整宽度。
- 内容超过可视区域时独立滚动。
- 面板内部滚动与主对话区滚动相互隔离。

> Sidebar 依赖 Pi fullscreen TUI。非全屏模式下扩展仍可运行，但右侧 Sidebar 不会挂载。

### Sessions 会话面板

`SESSIONS` 面板显示最近的保存会话，并提供常用会话操作：

- 查看最近会话标题、消息数量和更新时间。
- 点击会话切换到其他 session。
- 点击 `✎` 重命名会话。
- 点击 `×` 删除指定的非当前会话。
- 点击标题区域刷新会话列表。
- 点击 `⊗` 清理当前会话之外的其他会话。
- 最多直接展示最近 5 个 session。

面板底部还提供资源入口，可直接查看当前 Pi 环境中已加载的：

- `AGENTS.md`
- Skills
- Extensions
- MCP

### CTX 上下文面板

`CTX` 面板用于观察当前模型上下文的使用情况。

主要信息包括：

- 当前模型与 thinking / reasoning 模式。
- Pi 报告的 context window 使用比例。
- 当前上下文使用进度条。
- 本次提问相对上一轮的上下文增量。
- System / Tools / Messages / Tool Results / Summary / Other 的本地估算占比。
- 当前上下文中的图片数量。
- 当前 turn 数、运行耗时。
- TTFT（Time To First Token）。
- TPS（Tokens Per Second）相关运行指标。

上下文分类数值属于本地启发式估算，并非模型服务端 tokenizer 的精确计费结果。它的用途是帮助快速判断“上下文主要消耗在哪里”，而不是替代 provider 的正式 usage 数据。

更详细的估算逻辑见：

```text
extensions/ctx/README.md
```

### Tool View 工具统计

`TOOL VIEW` 面板按当前问题和当前 session 统计工具调用情况。

可以观察：

- 普通 Tools 的调用次数。
- MCP server / MCP tool 的调用情况。
- 当前问题中的调用进度。
- 当前 session 累积调用数量。
- Fabric 接管工具时的状态提示。

同名 Tool 与 MCP server 会分别统计，避免混在一起。

### 工具输出显示模式

扩展提供三种工具调用展示模式：

- `normal`：完整显示，尽量保持 Pi 默认工具渲染效果。
- `compact`：紧凑显示，只保留最有用的信息，默认模式。
- `hidden`：隐藏工具调用与结果的 UI 行。

可以直接使用命令切换：

```text
/tool-view normal
/tool-view compact
/tool-view hidden
/tool-view status
```

也可以直接点击 `TOOL VIEW` 面板顶部的模式选项切换。

模式会持久化到 Pi agent 目录，下次启动继续生效。

`compact` 模式会针对常见工具进行专门压缩，例如：

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

错误结果、展开状态或未适配的工具仍会回退到原生展示，避免关键信息丢失。

### Footer

扩展接管并增强底部 footer，使常用运行状态在主界面底部持续可见，同时与 Sidebar 的状态展示保持一致。

## 安装

要求：

- Node.js 24+
- Pi Coding Agent

推荐直接通过 npm 安装：

```bash
pi install npm:pi-ui-extension
```

Pi 会自动安装 package，并将它加入对应的 `settings.json`。

也可以直接从 GitHub 安装：

```bash
pi install git:github.com/1993yihuan/pi-ui-extension
```

或者：

```bash
pi install https://github.com/1993yihuan/pi-ui-extension
```

### 手工配置 settings.json

用户级配置通常位于：

```text
~/.pi/agent/settings.json
```

使用 npm 包：

```json
{
  "packages": [
    "npm:pi-ui-extension"
  ]
}
```

使用 GitHub：

```json
{
  "packages": [
    "git:github.com/1993yihuan/pi-ui-extension"
  ]
}
```

如果已有其他 packages，只需要把 `pi-ui-extension` 追加到现有数组，不要覆盖原有配置。

## 更新

如果通过 npm 或 Git source 安装，可以使用 Pi 的 package 更新机制：

```bash
pi update --extensions
```

如果需要固定某个 Git tag，也可以在 Git source 上指定 ref；固定版本适合生产环境，但不会自动跟随最新提交。

## 本地开发

建议不要直接在 Pi 的 package 安装目录中长期开发，而是 clone 到正常工作目录：

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
npm ci
```

执行完整检查：

```bash
npm run check
```

等价于：

```bash
npm run typecheck
npm test
```

当前测试覆盖 Session、Sidebar、CTX、Tool View、MCP 统计、资源面板、滚动/鼠标行为以及 Fabric 兼容逻辑。

### 本地联调

开发阶段可以让 Pi 直接加载本地目录：

```bash
pi install ./path/to/pi-ui-extension
```

或在项目级 `.pi/settings.json` / 用户级 `~/.pi/agent/settings.json` 中配置本地路径。

这样修改源码后无需先发布 npm 或 push GitHub，更适合快速调试。

## 项目结构

```text
pi-ui-extension/
├── extensions/
│   ├── index.ts            # 扩展入口与生命周期协调
│   ├── ctx/                # Context usage / activity / TTFT / TPS
│   ├── footer/             # Footer 增强
│   ├── mcp/                # MCP 状态与资源集成
│   ├── session/            # Session 列表与操作
│   ├── sidebar/            # Sidebar 布局、滚动与 resize
│   └── tool-view/          # Tool 展示模式与调用统计
├── .github/workflows/
│   ├── ci.yml              # push / PR 自动检查
│   └── release.yml         # tag 自动发布 npm 与 GitHub Release
├── package.json
└── tsconfig.check.json
```

Pi 从下面的入口加载扩展：

```text
./extensions/index.ts
```

对应声明位于 `package.json`：

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

仓库包含两条 GitHub Actions 流水线。

### CI

对 `main` 的 push 和 Pull Request 自动执行：

```text
npm ci
npm run check
```

用于验证：

- TypeScript 类型检查
- 自动化测试
- 干净环境下依赖是否完整

### Release

推送 `v*` tag 后自动执行：

```text
npm ci
npm run check
版本号与 Git tag 一致性检查
npm pack --dry-run
npm publish
GitHub Release
```

npm 发布使用 GitHub Actions OIDC / npm Trusted Publishing，不依赖长期保存的 `NPM_TOKEN`，并生成 npm provenance。

常规 patch 发版示例：

```bash
npm version patch
git push
git push --tags
```

例如：

```text
1.1.1 -> 1.1.2 -> v1.1.2
```

推送 tag 后，Release workflow 会自动完成 npm 发布和 GitHub Release 创建。

## npm

安装：

```bash
npm install pi-ui-extension
```

Pi 用户更推荐直接使用：

```bash
pi install npm:pi-ui-extension
```

## GitHub

Repository:

```text
https://github.com/1993yihuan/pi-ui-extension
```

Issues:

```text
https://github.com/1993yihuan/pi-ui-extension/issues
```

## 注意事项

- CTX 中的分类 token 数值是本地估算，不等同于 provider 计费 token。
- Sidebar 仅在 Pi fullscreen TUI 下挂载。
- Tool View 的 `hidden` 模式只影响工具 UI 展示，不会阻止工具实际执行。
- 扩展会遵循 Pi 的项目 trust 和 shell settings，不会绕过项目安全设置。
- 本仓库不会包含本机 `~/.pi` 中的认证信息、sessions、浏览器 profile 或其他运行时私有数据。
