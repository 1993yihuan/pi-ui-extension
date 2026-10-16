[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

A fullscreen terminal UI extension for [Pi Coding Agent](https://github.com/earendil-works/pi). Manage sessions, inspect context usage, view Tool/MCP activity, and keep tool transcripts readable—all from one sidebar.

> **Requires Pi fullscreen mode.** Use `pi --tui-mode fullscreen` if fullscreen is not already your default. The sidebar is not supported in regular TUI mode.

## Preview

<img width="1377" height="744" alt="pi-ui-extension preview" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.7.1/preview.png" />

## Quick start

Install from npm (recommended):

```bash
pi install npm:pi-ui-extension
```

Start Pi in fullscreen mode. The right sidebar appears automatically. To install a specific release instead:

```bash
pi install npm:pi-ui-extension@1.8.3
```

Pinned packages do not automatically move to newer versions. See [Installation and updates](#installation-and-updates) for Git, local and removal options.

## Features

The sidebar consists of three panels:

| Panel | Purpose |
| --- | --- |
| **SESSIONS** | Recent sessions, pinning, management, and resource shortcuts |
| **CTX** | Context composition, model information, and performance |
| **VIEW** | Normal / Compact / Hidden transcript modes and Tool/MCP statistics |

Panels support mouse interaction, scrolling, terminal resizing, and smaller terminal windows.

**Centered dialogs:** Session management, bulk cleanup, renaming, resource/MCP browsing, and the Tool View picker now use consistent theme-aware, centered overlays. Select with ↑/↓ and Enter, cancel with Esc; resource details are read-only and scrollable. **Trash confirmation starts at Cancel**; the sidebar `×` and advanced manager both require explicit confirmation before moving a session to trash. Pi 1.2.0+ is required; 1.2.0 and 1.3.0 are tested.

### Sessions and resource shortcuts

The **SESSIONS** panel lists recent project sessions. Click a session to switch, or use its actions to rename, pin/unpin (`☆` / `★`), delete, and refresh (`↻`). Pinned sessions appear first. The number beside each title represents **user questions**, not Pi's total message count; assistant/tool messages are excluded. For example, `3 · 55m` means three questions and an update 55 minutes ago. Unreadable sessions display `?`.

Open **Advanced Sessions** with `≡` or `/sessions-manager` to:

- Search titles/IDs, sort by last updated, question count, or title, and browse all sessions in pages of eight.
- Switch, rename, pin/unpin, or move an individual session to trash (confirmation required).
- Preview and bulk-clean eligible sessions with `⊗`, protecting the current session, pinned sessions, and sessions known to be active in another Pi instance.

**Deletion safeguards:** The current session cannot be deleted; session changes require Pi to be idle. The centered bulk-cleanup preview displays **Eligible** and **Protected / unavailable** totals with reasons (current, pinned, active in another Pi, unreadable/non-file). Reason counts are aligned in a shared right-aligned column for readability. **Recently modified historical sessions are eligible**—there is no five-minute grace period. Cleanup always requires explicit confirmation (Cancel is selected by default). Before each trash move, the extension rechecks file identity, modification time, pins and activity; any session changed during confirmation is skipped. **Pi instances without this extension cannot be detected reliably**; avoid bulk cleanup if another such Pi process may be using saved sessions. Individual deletion also requires confirmation.

The bottom of SESSIONS provides these resource shortcuts:

- **AGENTS.md** — active instruction resources.
- **Skills** — discovered agent skills.
- **Extensions** — installed or loaded extensions.
- **MCP** — configuration and observable runtime status.

The **MCP Status Center** is read-only. It shows global/trusted-project configurations, extension-registered servers, and health when explicitly reported by a supported adapter. **Configured, registered, or loaded does not mean connected.** Credentials, environment values, commands, and raw errors are not exposed. Use Pi's `/mcp` manager for connection diagnostics, authentication, and changes; the status center cannot perform these operations.

### CTX: context and performance

The **CTX** panel shows:

- Current model, Thinking level, context window/usage, current-run context delta, and image count.
- Context composition: `System`, `Tools`, `Messages`, `Tool Results`, `Summary`, and `Other`.
- Run turns/time, average TTFT and TPS, the latest TTFT, and available cache metrics.

**Token composition is a local heuristic estimate**, not exact provider tokenization or billing usage. The extension uses observable provider tool definitions when available; before a provider request, it estimates enabled Pi tool schemas. See [Architecture](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md) for measurement and refresh details.

### VIEW: tool transcripts and Thinking

One selector controls both tool output and Thinking; the default is **Compact**.

| Mode | Tools | Thinking |
| --- | --- | --- |
| **Normal** | Native tool transcript, including details | Full Thinking text |
| **Compact** (default) | Compact, indented summaries | Latest **7 terminal-wrapped lines** while streaming; `Thinking · 5s` when complete |
| **Hidden** | Tool transcripts hidden | Status and measured time only, **no Thinking body** |

Switch with the sidebar buttons or `/tool-view normal|compact|hidden|status`. The selection is persisted and refreshes existing transcript rows in the current session. It **only changes presentation**—not model reasoning, tool execution, saved session data, or usage counting.

In Compact, supported built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and `codemode`) use Claude-style indentation, `›`/`⌄` chevrons, and a muted `⎿` result branch:

```text
Thinking · 0.7s
  ›  codemode
    ⎿  1 call · 1 ok │ 59 lines · 85ms
  ›  bash  git status
    ⎿  12 lines · 45ms
```

Output counts use `line/lines` (falling back to `out` on narrow terminals); the duration and metric separator are less prominent and spacing is tighter. Each tool call has its own summary; calls are never merged. Success, running, partial failure, and failure remain distinct. **Click any supported tool's `›` chevron, including Codemode, to expand Pi's native details** (script, nested calls, output, or errors); click `⌄` to collapse back to the Compact summary. Normal also supports native details. Third-party tools and special native renderers are left intact.

Thinking duration measures the **observable Thinking phase**, not the whole response. Live time is prefixed by `~`; if reliable timing is unavailable (e.g. after restoring a session), only `Thinking` is shown. Compact/Hidden Thinking labels are read-only on verified Pi versions; clicking them does not expand private text.

**Important:** Set Pi's native `hideThinkingBlock` to `false` (or enable native Thinking visibility) for the extension's Compact/Hidden Thinking summary to appear. Pi's native hidden placeholder takes precedence otherwise.

Compact's tighter tool spacing and click protection have been verified for **Pi 1.2.0 and 1.3.0**. They use narrowly scoped, version-checked compatibility adapters for host UI components, rather than changing tool execution. Unsupported host layouts fall back to Pi's native behavior. Normal and Hidden retain their own layouts. Implementation details are in [Architecture](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md).

### Tool / MCP usage statistics

Below VIEW, tools are grouped by execution source:

| Group | Meaning |
| --- | --- |
| **DIRECT TOOLS** | Top-level model-issued tools, including a Codemode parent call |
| **NESTED TOOLS** | Calls made inside another tool, such as `bash` executed by Codemode |
| **MCP** | Server attribution across those tool calls—not extra executions |

**RUN** is activity in the current agent run; **TOTAL** accumulates activity in the active session branch. A Codemode parent is counted once in Direct, with its child calls separately in Nested. **Do not add MCP totals to Direct + Nested**, as that double-counts attributed calls. Counters are reconstructed on session/branch changes where data is available. The list remains scrollable on narrow terminals.

### Footer

A compact footer displays the current working directory and Git branch (when available), truncating long paths to fit the terminal.

## Installation and updates

For day-to-day usage, prefer **npm**. Git is available for unreleased repository changes or when you want to track a branch directly.

| Action | Command |
| --- | --- |
| Install latest npm release | `pi install npm:pi-ui-extension` |
| Pin v1.8.3 | `pi install npm:pi-ui-extension@1.8.3` |
| Install from GitHub | `pi install git:github.com/1993yihuan/pi-ui-extension` |
| Pin a Git tag | `pi install git:github.com/1993yihuan/pi-ui-extension@v1.8.3` |
| Install only for the current project | `pi install --local npm:pi-ui-extension` |
| Update unpinned packages | `pi update --extensions` |
| List installed packages | `pi list` |
| Remove npm package | `pi remove npm:pi-ui-extension` |
| Remove Git package | `pi remove git:github.com/1993yihuan/pi-ui-extension` |

Pi stores global package declarations in `~/.pi/agent/settings.json`. Project-local installation writes `<project>/.pi/settings.json` and requires Pi to trust the project. Pinning a version stops automatic movement to newer releases.

For one-off local source testing, from the repository root (without changing installed package declarations):

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
```

`--no-extensions` prevents loading the installed copy a second time; the explicit `-e` entries remain active.

## Compatibility and troubleshooting

- **Requirements:** Pi Coding Agent **>= 1.2.0** with `registerToolRenderer()`; Node.js **>= 22.19.0**. CI tests Node 22.19.0/24 with Pi 1.2.0/1.3.0.
- **No sidebar:** Confirm fullscreen mode and terminal width; regular TUI is not supported for the sidebar.
- **Missing Thinking summary:** Check Pi's native `hideThinkingBlock` flag and the selected VIEW mode.
- **Uncertain MCP connection:** Only adapter-reported connections are confirmed; use `/mcp` for diagnostics.
- **Unexpected Pi version:** Run `command -v pi`, `pi --version`, and `pi list`. Bun and npm global installations may coexist; the executable selected by your shell determines the active host. Do not remove other installations without checking dependencies.
- **Compatibility approach:** No Pi Core files or tool execution methods are rewritten. Public extension APIs are preferred; version-checked host UI guards are used for specific mouse/spacing behavior and fail back to native presentation if unsupported.

## Development and release

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
npm ci
npm run check
```

- [Development guide](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/DEVELOPMENT.md) — project layout, testing, CI, OIDC publishing, and release procedure.
- [Architecture notes](https://github.com/1993yihuan/pi-ui-extension/blob/main/docs/ARCHITECTURE.md) — stats, Thinking, session protection, MCP state, and Pi compatibility details.

This package is published with the `pi-package` keyword for discovery in the [Pi Package Catalog](https://pi.dev/packages). The npm package declares the preview image above for gallery use.

## License

[MIT](LICENSE).
