[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

`pi-ui-extension` 是一个面向 [Pi Coding Agent](https://github.com/earendil-works/pi) 的终端 UI 增强包，在不修改 Pi Core 的前提下，为全屏 TUI 增加右侧信息栏、会话管理、上下文观察、工具调用统计以及更紧凑的 Footer。

当前包同时支持通过 npm 或 Git 安装，并使用 GitHub Actions 完成类型检查、自动化测试和 npm Trusted Publishing（OIDC）发布。

> [!IMPORTANT]
> `pi-ui-extension` **需要在 Pi 的 fullscreen 模式下使用**。请在 fullscreen 模式下运行 Pi；非 fullscreen 模式不属于本扩展的支持范围，Sidebar、面板尺寸计算及相关布局可能无法正常显示。

## 界面预览

<img width="1377" height="671" alt="pi-ui-extension 界面预览" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.1.6/preview.png" />

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
- 使用右上角 `⊗` 批量清理符合条件的非活动、未置顶会话（保护当前、置顶、近期修改和已登记的活动 Session）。
- 点击 `SESSIONS ↻` 刷新会话列表。
- 每条会话旁的数字表示**用户提问次数**，不再表示 Pi 的消息总数。只统计会话 JSONL 历史中顶层 `user` 消息，不计入 AI 回复、工具结果或嵌套调用。显示格式仍为 `提问次数 · 最近更新`（例如 `3 · 55m`）；文件不存在或无法读取时显示 `?`，避免误报为 0。采用 JSONL 字节增量读取、未完成行缓存；文件截断、替换时重新统计。

**Sessions 高级管理（v1.2.0 起）**：点击标题右侧的 `≡`，或输入 `/sessions-manager` 打开完整会话管理器。

- 全量浏览当前项目的历史 Session，**每页 8 条**，可向前 / 向后翻页和手动刷新。
- 按会话标题或 Session ID 搜索（不区分大小写），支持最近更新、最早更新、**用户提问次数**和标题排序；高级管理器与右侧列表使用相同的提问计数。
- 单独查看会话操作：切换、重命名、置顶 / 取消置顶、移到回收站。删除前有确认，当前 Session 不允许删除。
- 置顶会话始终优先排序，并使用 `★` 标记，优先显示在 Sidebar 的最近 5 条会话中。
- Sidebar 的左侧标记顺序为先显示会话状态，再在标题前显示置顶星标：`○ ★hello` 表示已置顶，`● ★hello` 表示当前且已置顶。
- Sidebar 每条会话右侧新增快捷置顶按钮：`☆` 表示未置顶，`★` 表示已置顶，点击立即切换；与 `✎` 重命名、`×` 删除互不影响。Sidebar 较窄时优先保留原有操作按钮。
- 置顶 ID 持久保存在 Pi 的 agent 目录下 `pi-ui-extension/session-pins.json`，不保存会话内容。
- 使用 `⊗` 批量清理时，保护**当前会话、置顶会话、最近 5 分钟修改过的会话**以及运行本扩展的其他 Pi 实例登记为活动的会话。活动登记保存在 Pi agent 目录下的 `pi-ui-extension/active-sessions/`，只含私有元数据，正常退出时自动移除。确认清理后，每条会话在进入回收站之前还会重新检查置顶、活动状态及文件身份 / 修改时间；确认期间有变化的会话自动跳过。**未安装本扩展的旧 Pi 实例无法可靠识别**，如果它们可能仍在使用历史会话，应避免批量清理。显式删除单条会话仍需确认，但不受批量清理的 5 分钟保护期约束。

为避免正在执行中的 Agent 状态被破坏，会话切换、重命名、删除和批量清理只会在 Pi 空闲时执行；当前正在使用的 Session 不允许删除。

### 3. 资源快速查看

`SESSIONS` 面板底部提供四类资源入口：

- `AGENTS.md`
- `Skills`
- `Extensions`
- `MCP`

点击后可以查看当前项目 / Pi 环境发现的相关资源。其中 MCP 状态中心会区分“已配置 / 已注册”和“已确认连接”，避免把配置存在误认为连接成功。

#### MCP 状态中心

点击 Sidebar 中的 **MCP** 按钮可打开只读状态中心，查看全局和可信项目配置的 MCP Server、扩展通过 `pi.registerMcpServer()` 注册的服务器，以及 `pi-mcp-adapter/status/v1` 提供的运行时观察结果。

- 显示服务器来源、启用/禁用状态与配置覆盖情况；项目级 `enabled: false` 会正确覆盖全局配置。
- 仅当 Adapter 明确报告连接状态时显示 Connected、Connecting、Failed 等状态；**已配置、已注册或已加载不代表已连接**。
- 不展示命令、URL、环境变量、请求头、Token 或原始错误内容。
- 工具调用统计支持 Pi 原生 `mcp__server__tool` 格式，继续兼容既有 MCP Gateway / `mcpScript` 统计。

Pi 目前没有向普通 UI 扩展公开完整的原生 MCP 实时连接状态。查看连接错误、重新连接、登录或启停服务器，请使用当前生效的 `/mcp` 管理界面（Pi 内置或由第三方 MCP Adapter 提供）；本状态中心不执行连接或配置修改。

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

**TUI 性能优化（v1.2.5 起）**：流式 Token 估算最多每 150ms 采样一次，首次有效输出立即展示，Token 数量未变化时不会因此重复刷新 CTX。每秒运行时长刷新仅在 Agent 运行期间启用，任务完成或面板销毁后自动停止，避免空闲时持续重绘。

### 5. Tool View 与 Thinking 显示模式

`VIEW` 保留原来的**单行** Normal / Compact / Hidden 按钮，统一控制工具输出与 Thinking 正文：

| 模式 | Tools | Thinking |
| --- | --- | --- |
| **Normal** | 保留原生完整工具输出 | 完整显示 Thinking |
| **Compact**（默认） | 紧凑工具摘要 | 流式显示 `Thinking… · ~5s` 与最近 7 行（按终端实际换行计算），结束后在有计时数据时显示 `Thinking · 5s` |
| **Hidden** | 隐藏工具 transcript | 仅显示 `Thinking… · ~5s` / `Thinking · 5s` 状态和可测量的耗时，不显示思考正文 |

```text
○ Normal      ● Compact      ○ Hidden
```

直接点击按钮，或使用原有的 `/tool-view normal|compact|hidden|status` 命令切换。继续复用原来的 `tool-view-mode.json` 持久化配置，切换时同步刷新历史工具记录和 Thinking 消息。不新增 Thinking 独立按钮、命令或配置文件。

**Thinking 耗时：** Compact 和 Hidden 均使用 Pi 模型流提供的 `thinking_start` / `thinking_end` 事件测量**可观察到的 Thinking 阶段实际耗时**，不会把整个模型响应时间误算为思考时间。流式显示 `Thinking…` 和 `~` 估计标记，在收到新内容时更新；完成后显示 `Thinking · 5s` 一类的固定时长。Hidden 在流式及完成后都不展示思考正文。历史会话恢复、事件缺失等无法准确测量时仅显示 `Thinking`，不猜测时间。窄屏不足以容纳时间时仅保留状态。计时记录仅保存在当前会话内存，不写入 Session。

**兼容说明：** Compact 和 Hidden 的 Thinking 摘要是**只读状态行**。点击 `Thinking · 5s` 或流式状态，不会触发 Pi 原生点击隐藏，不会跳变成 `Thinking...`，也不提供点击展开详情。针对已验证的 Pi **1.1.0 / 1.2.0**，插件只对自身 Compact/Hidden Thinking 的鼠标区域增加有限的点击保护，Normal 仍保留 Pi 原生鼠标行为；未验证版本或内部结构变化时安全回退原生行为。Thinking 展示和计时仍使用官方 `registerMarkdownTransformer()` 和 `setHiddenThinkingLabel()` API；Compact/Hidden 下应确保 Pi 原生 `hideThinkingBlock` 为 `false`（或通过原生快捷键切换为可见），否则原生 `Thinking...` 会先于摘要转换显示。VIEW 模式不影响推理过程和原始 Session。

Tool View 使用 Pi 官方的 `pi.registerToolRenderer()` 接口管理内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls`）**以及内置 `codemode` 工具**的展示，不再重注册工具定义或接管工具执行逻辑。其他 Tool 保留其自身的渲染方式。

**Compact 工具样式统一：** 支持的直调内置工具与 Codemode 使用统一的单列主题色 Chevron 箭头 `›`、固定标题对齐、成功 `✓`、运行中 `… Running` 和失败 `✗ Failed` 状态；各工具仍保留适合自身的统计字段。例如 `bash` 的标题为 `bash`，输出统计为 `12 out`。Codemode 展示子调用及成功/失败/输出统计，状态后不再出现多余的首根竖线；`│` **只用于分隔调用统计与输出统计**。标题和摘要在窄终端保持单行并按宽度截断。直调工具展开时使用 `⌄`，同时保留 Pi **原生详情渲染器及鼠标交互**；Normal 完全保留原生样式。Skill 相关的 read、失败工具的原生详情，以及第三方工具在必要时继续使用原生渲染，以保证兼容。Codemode 在 Compact 中即使宿主设置为展开状态也只展示安全的元数据摘要；需要完整脚本与子调用详情请切换 Normal。

对于 **Codemode**：

- **Normal**：保留 Pi 原生的脚本、子工具调用、输出详情，以及原生展开 / 收起行为。
- **Compact**：采用带有状态颜色、简短英文文案的双行摘要。第一行突出 Codemode 和代码行数；第二行将状态、子调用统计、输出规模（如 `57 out`）与耗时分组展示。成功时绿色 `✓` 代替重复的 `✓ Done`；父调用成功但子调用有失败或取消时显示 `! Partial`；父调用失败时显示 `✗ Failed`。运行期间从首次可观察到的部分结果开始估算耗时，以 `~` 标记并每秒刷新；结束后采用 Pi 上报的准确耗时。即使展开或执行失败，也不会展示完整代码、子调用参数或真实输出；终端宽度不足时优先保留状态、失败信息和调用次数。
- **Hidden**：隐藏 Codemode 工具记录（包括展开和失败结果），但不影响实际执行或 Tool / MCP 调用统计。

Compact 效果示例：

```text
›  codemode  8 code lines
✓  1 call · 1 ok  │  59 out · 85ms

›  bash  git status
✓  12 out · 45ms
```

切换 Tool View 模式也会更新当前会话中已经展示的历史工具记录；其他第三方工具保持原有渲染方式。

同一段 Thinking 后连续发生多个工具调用时，保留 Pi 原有执行顺序：一条 Thinking 摘要后依次显示**每次**独立的 Codemode 双行记录。扩展不合并工具调用、不重复插入 Thinking，也不额外添加分割线；组件间距仍由 Pi 原生布局控制。

内置工具与 Codemode 的 Compact 摘要、模式通知和 Tool View 状态统一使用英文；CTX 缓存命中率标签由 `Catch` 更正为 `Cache`。

### 6. Tool / MCP 调用统计

Tool View 根据调用来源拆分展示：

- `DIRECT TOOLS`：模型直接发起的顶层工具调用，包括 Codemode 父调用。
- `NESTED TOOLS`：工具内部通过 Pi `executeTool()` 执行的调用，例如 Codemode 内部的 `bash`、`read`。
- `MCP`：归属到 MCP Server 的调用，合并不同调用来源。

面板顶部使用 **RUN**（本轮调用）和 **TOTAL**（当前 Session 的 active branch 累计调用）两个对齐指标。整体汇总只统计 Direct 与 Nested，MCP 是既有调用的归属信息，不额外累计。

模式切换栏下方的分隔线直接连接面板左右边框，不保留水平内边距。分组标题左侧保留工具或服务器种数，右侧不重复展示小计；仅明细行保留 `Run/Total`。Direct 和 Nested 工具名称均不显示前缀图标或箭头，左侧统一对齐。UI 文案为简短英文，窄终端自动缩写。本轮调用为正数时高亮，为零时弱化；**不做默认折叠**，内容过多时保持原来的滚动方式。

示例：

```text
○ Normal      ● Compact      ○ Hidden
├─────────────────────────────────────┤
RUN                                 TOTAL
0                                      93
───────────────────────────────────────
DIRECT TOOLS · 1
codemode                             0/32
───────────────────────────────────────
NESTED TOOLS · 7
bash                                 0/30
task_todos                           0/15
read                                  0/8
...
```

`codemode` 的父调用只在 `DIRECT TOOLS` 中计一次；Codemode 内部实际执行完成的工具分别计入 `NESTED TOOLS`。同名工具如果既有直接调用又有内嵌调用，会出现在不同分组并分别计数。`MCP` 表示对 MCP Server 的调用归属，不是额外的工具执行，因此**不能与 Direct / Nested 数量相加**。左侧表示当前运行次数，在新一轮运行、会话重载或分支切换后重置；右侧表示当前 active branch 的整个会话累计次数。

实时计数来自 `tool_execution_end` 事件，并根据 `parentToolCallId` 区分内嵌调用；重载或切换分支时，同时恢复顶层工具结果和 Pi 持久化的 `nestedCalls.calls`，通过 tool-call ID 去重。MCP 状态变化重新归属调用，但不会重复累计历史结果。右边是当前 active branch 累计数，左边会在新运行、重载或切换分支时重置。

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
pi install npm:pi-ui-extension@1.3.1
```

或者：

```json
{
  "packages": [
    "npm:pi-ui-extension@1.3.1"
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
pi install git:github.com/1993yihuan/pi-ui-extension@v1.3.1
```

### 临时加载本地源码

如果只想在一次 Pi 启动中测试本地源码，不修改 `settings.json`，请在仓库根目录运行。禁用自动扩展发现可以避免与已经安装的 `pi-ui-extension` 重复加载：

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
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

当前自动化测试覆盖 Sidebar、CTX、Session、官方 Tool Renderer、MCP resource、鼠标滚轮 / resize 等主要行为。

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

提交到 `main` 或创建 PR 时，GitHub Actions 会验证 **Node.js 22.19.0 / 24 × Pi SDK 1.1.0 / 1.2.0** 的四种组合：

```text
npm ci
→ 固定目标 Pi SDK 家族版本（仅旧版组合）
→ 验证实际安装的 Pi SDK 版本
→ npm run typecheck
→ npm test
→ npm run check:package
```

npm 发布包排除所有 `*.test.ts` 文件；`npm run check:package` 会核验发布清单中没有测试文件，且包含全部运行时 TypeScript 源码。测试文件仍保留在 Git 仓库中，并在 CI 中正常执行。

发布版本时使用 Git tag，例如：

```bash
npm version patch
git push
git push --tags
```

`v*` tag 会触发 Release workflow：

```text
Checkout
→ 校验版本标签格式、确认提交位于 main 历史
→ Node.js 24
→ npm ci
→ npm run check
→ 校验 tag 与 package.json version
→ npm pack --dry-run
→ npm Trusted Publishing (OIDC)
→ npm publish
→ 重试检查 npm Registry 已可查询新版本（最多约 10 分钟）
→ GitHub Release
```

npm 发布使用 GitHub Actions OIDC Trusted Publishing，不需要在 GitHub Repository 中保存长期 `NPM_TOKEN`。

npm 可能先接受发布请求，再经过一段时间才能查询到新版本。Release 工作流会等待最多约 10 分钟让 Registry 完成索引。如果检查超时，请先核对 npm 上的实际版本再决定如何处理，避免对已发布的同一个版本重复执行 `npm publish`。

## 兼容性与设计原则

- 不修改 Pi Core。
- Pi host 提供的 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 使用 `peerDependencies`，避免产生重复运行时实例。
- Tool View 只通过 Pi 官方 Renderer Resolver 控制内置工具的显示，不覆写工具定义或执行逻辑。
- Session 与资源操作尽量通过 Pi 已公开 API 完成。
- Context composition 明确标记为估算值，不冒充 provider 精确 token 统计。
- fullscreen Sidebar 不可用时安全降级，不影响 Pi 主流程。

## Requirements

- 支持官方 `registerToolRenderer()` API 的 Pi Coding Agent（CI 覆盖 SDK 1.1.0 与 1.2.0；开发环境使用 1.2.0）
- Node.js `>= 22.19.0`（建议使用当前 Pi 支持的 Node 版本）
- CI 覆盖 Node.js 22.19.0、24 × Pi SDK 1.1.0、1.2.0；发布工作流使用 Node.js 24

## 多套 Pi 安装的检查与兼容说明

同一台机器可能通过 Bun、npm 分别安装 Pi。插件运行时实际使用哪个版本，取决于 Shell 对 `pi` 命令的解析结果，而不一定是全局安装列表中的最新版本。可通过以下命令检查：

```bash
command -v pi
pi --version
bun pm ls -g
npm ls -g @earendil-works/pi-coding-agent --depth=0
pi list
```

如果存在多套安装，建议先确定其他终端或项目不再依赖旧版本，再统一安装来源。比如旧版 npm 全局 Pi 确认不再使用后，才执行 `npm uninstall -g @earendil-works/pi-coding-agent`；本插件不会自动卸载全局包。在仓库内运行 `pi -e ./extensions/index.ts` 可验证本地改动，已安装的 npm 插件不会因此自动升级。

Pi 1.2.0 的 `before_agent_start` 同时覆盖用户输入与扩展发起的 custom 运行，因此 Tool/MCP 本次统计和 CTX 增量均按**每次运行**重置，而不只按用户提问重置。取消运行与工具失败分开显示。MCP 只有在运行时适配器明确上报已连接时才显示 Connected，配置和扩展注册不代表连接健康；会话重载时丢弃上个会话的连接状态。

## License

本项目采用 [MIT License](LICENSE) 开源许可证。
