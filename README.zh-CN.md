[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供的全屏终端 UI 扩展。在右侧 Sidebar 中统一管理 Session、查看上下文组成、观察工具 / MCP 调用，并简化工具执行记录。

> **需要 Pi fullscreen 模式。** 如果不是默认全屏，请使用 `pi --tui-mode fullscreen`。普通 TUI 模式不支持本扩展的 Sidebar 布局。

## 界面预览

<img width="1377" height="744" alt="pi-ui-extension 界面预览" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.7.1/preview.png" />

## 快速开始

推荐从 npm 安装：

```bash
pi install npm:pi-ui-extension
```

以 fullscreen 模式启动 Pi，右侧 Sidebar 将自动显示。如需固定版本：

```bash
pi install npm:pi-ui-extension@1.8.2
```

固定版本不会自动升级到后续版本。其他安装方式见[安装与更新](#安装与更新)。

## 功能介绍

右侧 Sidebar 包含三个区域：

| 面板 | 功能 |
| --- | --- |
| **SESSIONS** | 最近会话、置顶、管理与资源快捷入口 |
| **CTX** | 上下文组成、模型信息和运行性能 |
| **VIEW** | Normal / Compact / Hidden 显示模式与 Tool/MCP 调用统计 |

支持鼠标、滚轮、终端缩放，并在终端空间不足时自动调整显示。

**居中弹窗：** Session 管理、批量清理、重命名、资源/MCP 浏览和 Tool View 模式选择现在统一使用主题色居中浮层。可用 ↑/↓ 和 Enter 选择、Esc 取消；资源详情为可滚动的只读预览。**移入回收站默认选中 Cancel**，侧边栏 `×` 和高级管理都会要求明确确认后才执行删除。要求 Pi 1.2.0+，已验证 1.2.0 和 1.3.0。

### Sessions 会话与资源管理

**SESSIONS** 展示当前项目的最近会话，可点击切换、重命名、置顶 / 取消置顶（`☆` / `★`）、删除或刷新（`↻`）。置顶会话优先显示。标题旁的数字是**用户提问次数**，不是 Pi 的消息总数；AI 回复和工具结果不计入。例如 `3 · 55m` 表示三次提问、55 分钟前更新。无法读取的会话显示 `?`。

点击标题上的 `≡` 或运行 `/sessions-manager` 打开**高级会话管理**：

- 搜索标题或 ID，按更新日期、提问次数或标题排序，每页浏览 8 条。
- 切换、重命名、置顶 / 取消置顶，或经确认后将单个 Session 移入回收站。
- 使用 `⊗` 预览并批量清理符合条件的 Session，保护当前、置顶及已知正在被其他 Pi 实例使用的会话。

**删除安全保护：** 当前 Session 不能删除；会话管理操作只能在 Pi 空闲时执行。批量清理时，居中弹窗展示**可删除**和**受保护／不可用**数量，并按当前、置顶、其他 Pi 正在使用、无法读取等原因分类。各项原因的数字在统一列内右对齐，便于阅读。**最近 5 分钟内修改过的历史会话也允许删除**，不再有时间保护期。操作必须明确选择删除（默认 Cancel）。移动到回收站前会重新检查文件身份、修改时间、置顶及活动状态；确认期间发生变化的文件会被跳过。**没有加载本扩展的其他 Pi 进程无法被可靠检测**，如果此类进程可能正在使用历史会话，请勿批量清理。单个会话删除仍需确认。

SESSIONS 底部提供四类资源快捷入口：

- **AGENTS.md**：当前生效的指令资源。
- **Skills**：已发现的 Skills。
- **Extensions**：安装或加载的扩展。
- **MCP**：配置和可观察的运行时状态。

**MCP 状态中心**是只读的：展示全局 / 可信项目配置、扩展注册的服务器，以及支持的适配器明确提供的连接健康信息。**已配置、已注册或已加载，不代表已经连接。** 界面不会展示凭据、环境变量、命令或原始错误。连接诊断、认证和配置修改请使用 Pi 的 `/mcp` 管理器。

### CTX 上下文与性能

**CTX** 面板显示：

- 当前模型、Thinking Level、上下文窗口 / 使用量、本轮上下文增量、图片数量。
- 上下文组成：`System`、`Tools`、`Messages`、`Tool Results`、`Summary`、`Other`。
- 本轮 turn 数 / 用时、平均 TTFT 和 TPS、最近一次 TTFT，以及可观测的缓存指标。

**上下文 Token 组成是本地启发式估算**，不是模型厂商的精确 tokenizer 结果，也不等于计费 token。可观察到真实 provider 工具定义时优先使用；请求尚未发生时则估算当前启用的 Pi 工具 schema。计量和刷新细节见[技术架构](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md)。

### VIEW 工具输出与 Thinking

统一使用一组模式按钮控制工具输出和 Thinking；默认 **Compact**。

| 模式 | Tools | Thinking |
| --- | --- | --- |
| **Normal** | 保留原生工具记录与详情 | 完整 Thinking 正文 |
| **Compact**（默认） | 缩进紧凑摘要 | 流式保留最近 **7 行终端换行文本**；结束后显示 `Thinking · 5s` |
| **Hidden** | 隐藏工具记录 | 只显示状态及测得的耗时，**不显示 Thinking 正文** |

可以点击按钮或输入 `/tool-view normal|compact|hidden|status` 切换。模式自动保存并同步刷新当前会话里已经显示的消息。它**只影响界面呈现**，不会改变模型推理、工具执行、历史 Session 内容或工具调用计数。

Compact 支持内置的 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 和 `codemode`，统一采用 Claude 风格缩进、`›` / `⌄` 箭头以及弱化的 `⎿` 结果分支：

```text
Thinking · 0.7s
  ›  codemode
    ⎿  1 call · 1 ok │ 59 lines · 85ms
  ›  bash  git status
    ⎿  12 lines · 45ms
```

输出行数显示为 `line/lines`，窄终端自动简写为 `out`；耗时及分组符颜色弱化、统计间距收紧。每次调用都独立显示，不合并；成功、运行中、部分失败和失败状态明确区分。**包括 Codemode 在内的受支持工具都可点击 `›` 展开 Pi 原生详情**（脚本、内嵌调用、输出及错误），再点击 `⌄` 收起，恢复 Compact 摘要；Normal 同样可以查看完整详情。第三方工具和特殊原生 Renderer 保留原有行为。

Thinking 耗时表示**可观测的思考阶段耗时**，不是整个回复的耗时。流式时间用 `~` 标记；恢复历史 Session 等无法准确计时时只显示 `Thinking`。已验证 Pi 版本的 Compact / Hidden Thinking 状态行只读，点击不会展开正文。

**注意：** 如需在 Compact / Hidden 显示本扩展的 Thinking 摘要，应确保 Pi 原生 `hideThinkingBlock` 为 `false`（或已通过原生操作开启 Thinking 可见性）；否则原生隐藏占位符会优先生效。

Compact 工具间距优化及 Thinking 点击保护已在 **Pi 1.2.0 和 1.3.0** 验证。部分 UI 行为使用限定范围、带版本检查的宿主兼容适配，并不接管工具执行。不支持的宿主布局会回退到 Pi 原生行为。Normal、Hidden 保持各自布局。实现细节见[技术架构](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md)。

### Tool / MCP 调用统计

VIEW 下方按调用来源统计工具：

| 分类 | 含义 |
| --- | --- |
| **DIRECT TOOLS** | 模型直接调用的工具，包括 Codemode 父调用 |
| **NESTED TOOLS** | 在另一个工具内部执行的调用，如 Codemode 内部的 `bash` |
| **MCP** | 上述调用归属到 MCP Server 的统计，**不是额外执行** |

**RUN** 表示当前 Agent 运行中的调用，**TOTAL** 表示当前会话 active branch 的累计调用。Codemode 父调用在 Direct 中计一次，子调用分别归入 Nested。**MCP 的数量不可与 Direct + Nested 相加**，否则会重复计数。重载会话 / 切换分支时会依据可用记录恢复累计值；列表在窄终端可滚动。

### Footer

精简 Footer 显示当前工作目录及 Git 分支（如存在），长路径会自动截断以适配终端宽度。

## 安装与更新

日常使用推荐 **npm**；希望跟随仓库开发版本或测试未发布代码时使用 Git。

| 操作 | 命令 |
| --- | --- |
| 安装最新 npm 版本 | `pi install npm:pi-ui-extension` |
| 固定 v1.8.2 | `pi install npm:pi-ui-extension@1.8.2` |
| 从 GitHub 安装 | `pi install git:github.com/1993yihuan/pi-ui-extension` |
| 固定 Git tag | `pi install git:github.com/1993yihuan/pi-ui-extension@v1.8.2` |
| 仅当前项目安装 | `pi install --local npm:pi-ui-extension` |
| 更新非固定版本 | `pi update --extensions` |
| 列出已配置扩展 | `pi list` |
| 卸载 npm 扩展 | `pi remove npm:pi-ui-extension` |
| 卸载 Git 扩展 | `pi remove git:github.com/1993yihuan/pi-ui-extension` |

Pi 的全局 Package 声明保存在 `~/.pi/agent/settings.json`。项目级安装写入 `<project>/.pi/settings.json`，且需要信任当前项目。固定版本不会自动切换到后续版本。

需要单次测试本地源码时，在仓库根目录执行（不修改已安装 Package）：

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
```

`--no-extensions` 禁止自动加载已安装的另一份扩展，显式传入的 `-e` 仍正常加载。

## 兼容性与常见问题

- **运行要求：** Pi Coding Agent **>= 1.2.0** 且支持 `registerToolRenderer()`；Node.js **>= 22.19.0**。CI 覆盖 Node 22.19.0/24 × Pi 1.2.0/1.3.0。
- **Sidebar 不显示：** 检查是否使用 fullscreen 模式，以及终端宽度；普通 TUI 不支持右侧 Sidebar。
- **Thinking 摘要不出现：** 检查 Pi 原生 `hideThinkingBlock` 和当前 VIEW 模式。
- **MCP 连接不确定：** 仅在适配器明确报告时确认连接，详细诊断使用 `/mcp`。
- **Pi 版本异常：** 执行 `command -v pi`、`pi --version`、`pi list`。Bun 与 npm 可能同时安装 Pi，实际宿主由 Shell 解析到的可执行文件决定。确认依赖关系前不要随意卸载其他安装。
- **兼容方式：** 不修改 Pi Core 文件和工具执行方法；优先采用公开扩展 API，少数鼠标 / 间距行为采用版本受限的 UI 兼容适配，不支持时回退原生界面。

## 开发与发布

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
npm ci
npm run check
```

- [开发指南](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/DEVELOPMENT.md)：项目结构、测试、CI、OIDC 发布与版本管理。
- [技术架构](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md)：调用统计、Thinking、Session 保护、MCP 状态及 Pi 兼容适配。

本扩展含 `pi-package` 关键字，可被 [Pi Package Catalog](https://pi.dev/packages) 发现；npm 包声明的预览图仍为上图。

## License

本项目采用 [MIT License](LICENSE) 开源协议。
