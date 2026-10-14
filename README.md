[English](README.md) | [简体中文](README.zh-CN.md)

# pi-ui-extension

`pi-ui-extension` is a terminal UI enhancement package for [Pi Coding Agent](https://github.com/earendil-works/pi). It adds a right-side information sidebar, session management, context inspection, tool/MCP usage tracking, and a compact footer without modifying Pi Core.

The package can be installed from npm or Git, and uses GitHub Actions for type checking, automated tests, and npm Trusted Publishing via OIDC.

> [!IMPORTANT]
> `pi-ui-extension` is designed for **Pi fullscreen mode**. Please run Pi in fullscreen mode when using this extension. In non-fullscreen mode, sidebar panels, layout sizing, and related UI behavior may be unavailable or displayed incorrectly.

## Preview

<img width="1377" height="671" alt="pi-ui-extension preview" src="https://github.com/1993yihuan/pi-ui-extension/releases/download/v1.1.6/preview.png" />

## Features

### 1. Right-side Sidebar

The extension mounts a right-side sidebar in Pi's fullscreen TUI. It contains three default panels:

- **SESSIONS**: recent sessions and resource shortcuts.
- **CTX**: model, context window, composition estimates, and runtime performance.
- **TOOL VIEW**: tool transcript display modes and Tool/MCP usage statistics.

The sidebar supports mouse interaction, wheel scrolling, and terminal resize handling. Panels shrink or become scrollable when vertical space is limited.

> The sidebar depends on **Pi fullscreen mode**. Non-fullscreen mode is not a supported display mode for this extension; sidebar panels, layout sizing, and related UI behavior may be unavailable or displayed incorrectly.

### 2. Session management

The `SESSIONS` panel provides quick access to recent sessions:

- Click a session to switch to it.
- Rename a non-current session.
- Delete a non-current session.
- Use `⊗` to move eligible inactive, unpinned sessions to trash, keeping the current, pinned, recently modified, and known active sessions safe.
- Click `SESSIONS ↻` to refresh the session list.
- The number beside a session is its **user question count**, not Pi's total message count. Only top-level `user` messages in that session's JSONL history are counted; assistant replies, tool results, and nested calls are excluded. The format remains `questions · last updated` (for example, `3 · 55m`). A missing/unreadable session shows `?`, not a misleading zero. Counting incrementally reads appended JSONL bytes, buffers incomplete lines, and rebuilds on truncation/replacement.

**Advanced Sessions management (v1.2.0+)**: click `≡` on the Sessions header or run `/sessions-manager`.

- Browse all saved sessions for the current project in **8-item pages**, with previous/next navigation and refresh.
- Search session titles or IDs case-insensitively, and sort by latest update, oldest update, **user question count**, or title. The advanced manager uses the same question count as the sidebar.
- Switch, rename, pin/unpin, or move an individual session to trash. Deletions require confirmation and the active session cannot be deleted.
- Pinned sessions (`★`) appear first, including in the five-session quick sidebar. Pins persist as IDs (no session content) in `pi-ui-extension/session-pins.json` under Pi's agent directory.
- The quick sidebar shows the current-session indicator first, then the pin marker before the title: `○ ★hello` (pinned) or `● ★hello` (active and pinned).
- Each session row has a quick pin button: `☆` means unpinned and `★` means pinned; clicking it toggles pinning without opening the manager. The existing `✎` rename and `×` delete controls are unchanged. On narrow sidebars, the pin action hides to preserve the existing controls.
- The `⊗` bulk cleanup protects the current session, pinned sessions, sessions modified within the past **5 minutes**, and other active sessions advertised by Pi instances running this extension. Active-session records are private metadata stored under `pi-ui-extension/active-sessions/` in Pi's agent directory and are removed on normal shutdown. Before each move to trash, the extension rechecks the current session, pins, active-session records, and file identity/mtime; sessions that changed during confirmation are skipped. **Other Pi instances without this extension cannot be reliably detected**, so avoid bulk cleanup while older Pi processes may still be using historical sessions. Explicit single-session deletion still requires confirmation and does not apply the bulk-cleanup grace period.

To avoid corrupting active agent state, switching, renaming, deleting, and bulk cleanup are only allowed while Pi is idle. The current session cannot be deleted.

### 3. Resource shortcuts

The bottom of the `SESSIONS` panel exposes four resource categories:

- `AGENTS.md`
- `Skills`
- `Extensions`
- `MCP`

These shortcuts let you inspect the resources discovered by the project/Pi environment. The MCP view distinguishes configured and registered servers from confirmed connections.

#### MCP Status Center

Click **MCP** in the sidebar to open a read-only status picker covering global and trusted-project MCP configuration, servers registered by extensions via `pi.registerMcpServer()`, and observations from `pi-mcp-adapter/status/v1`.

- See configuration scope, project overrides, and enabled/disabled state (including native Pi `enabled: false`).
- Connection health is only shown when an adapter explicitly reports it. **Configured, registered, and loaded do not mean connected.**
- Commands, endpoints, headers, tokens, environment values, and raw errors are never displayed.
- Tool usage now attributes native Pi `mcp__server__tool` calls to their MCP server, alongside existing gateway and `mcpScript` counts.

Pi does not currently expose its complete native MCP connection state to ordinary UI extensions. For live connection diagnostics, reconnects, authentication, or configuration changes, use the active `/mcp` manager (built-in or provided by your MCP adapter).

### 4. CTX context inspection

The `CTX` panel shows context and runtime information for the current model request, including:

- Current model name.
- Thinking level.
- Pi context usage / context window.
- Current-question context delta relative to the previous settled state.
- Context composition estimates.
- Image count.
- Turn count and run duration.
- Average TTFT (Time To First Token).
- Average TPS (Tokens Per Second).
- Latest observed TTFT with speed label.
- Cache-related metrics when observable.

Context composition is grouped into:

- `System`
- `Tools`
- `Messages`
- `Tool Results`
- `Summary`
- `Other`

Token counts are local heuristic estimates intended for composition and trend visibility. They are **not** provider-accurate tokenizer results and are not billing-token counts.

For tool definitions, the extension prefers the observable provider-request tool payload when available. Before a provider request exists, it falls back to estimating the schemas of Pi's currently enabled tools.

**TUI performance (v1.2.5+)**: Streaming token estimates are sampled at most once every 150 ms, with the first valid token update shown immediately. Unchanged token counts do not trigger extra CTX redraws. The one-second elapsed-time ticker runs only while an agent run is active and is cleared when the run settles or the panel is disposed.

### 5. Tool View and Thinking display modes

`VIEW` keeps its **single** Normal / Compact / Hidden selector. The selected mode controls both built-in tool transcripts and assistant Thinking display:

| Mode | Tools | Thinking |
| --- | --- | --- |
| **Normal** | Native tool transcript | Full thinking text |
| **Compact** (default) | Condensed tool summary | `Thinking… · ~5s` plus up to 7 recent terminal-wrapped lines while streaming; `Thinking · 5s` after completion when measured |
| **Hidden** | Hide tool transcript | Only `Thinking… · ~5s` / `Thinking · 5s` status and elapsed time when measurable; no Thinking body |

```text
○ Normal      ● Compact      ○ Hidden
```

The selector, `/tool-view normal|compact|hidden|status` command, and existing `tool-view-mode.json` persistence are shared. A mode change refreshes both historical tool transcript rows and Pi's existing Thinking components. There is no separate Thinking selector, command or configuration file.

**Thinking duration:** Compact and Hidden use Pi's actual `thinking_start` and `thinking_end` provider streaming events to measure the **observable Thinking segment wall time**, not the duration of the complete assistant response. A live duration has a `~` prefix and is updated when streaming content arrives. Completed durations remain fixed; if timing events are missing (for example, a restored session), the summary simply shows `Thinking` instead of making up an elapsed time. Hidden never renders Thinking body text, including while streaming. On narrow terminals the time suffix is omitted rather than wrapping the heading. Timings exist only in memory for the active session.

**Compatibility:** Compact and Hidden Thinking summaries are **read-only**: clicking `Thinking · 5s` or the live summary will not replace the label with Pi's native `Thinking...` placeholder or expand its contents. The extension uses a narrowly scoped, version-checked guard on Pi **1.1.0 / 1.2.0** to prevent the native click-to-hide action on its own Compact/Hidden Thinking regions; Normal retains native Thinking mouse behavior. On an unverified Pi implementation, the guard safely falls back to native behavior. Thinking display and durations still use the public `registerMarkdownTransformer()` and `setHiddenThinkingLabel()` APIs. To see the extension's Thinking status in Compact/Hidden, ensure Pi's native `hideThinkingBlock` is `false` (or toggle native Thinking visibility); Pi's native hidden placeholder bypasses Markdown transformation. VIEW mode selection does not change model reasoning or saved session content.

Tool View uses Pi's official `pi.registerToolRenderer()` hook for the built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`) **and the built-in `codemode` tool**. It never replaces tool definitions or execution functions. Other tools retain their own renderers.

**Unified Compact tool styling:** Supported direct tools and Codemode share a one-column, theme-colored `›` chevron before the tool name, consistent title alignment, and success (`✓`), running (`… Running`), and failure (`✗ Failed`) status treatment. Their metadata remains tool-specific; built-in `bash` shows its command under a `bash` heading and output as `12 out`. Codemode displays calls/ok/fail and output metrics; the status is followed by plain spacing, **not** a leading `│`. Vertical `│` separators appear only **between** the calls and output metric groups. Titles and result summaries stay to one terminal line and truncate on narrow viewports. For direct tools, expanding a row shows a matching `⌄` and keeps Pi's **native detail renderer and mouse handling** intact; switching to Normal leaves all native rendering unchanged. Skill-related read outputs, failed-tool native details, and third-party tools continue using their original renderer wherever required for correctness. Codemode deliberately remains metadata-only in Compact, even if the host's expanded state is selected; use Normal for full script and nested-tool details.

**Claude-style hierarchy in Compact:** Each supported tool title is indented by two spaces, and its result is displayed as a more-indented, muted `⎿` branch followed by the unchanged colored execution state. This branch belongs to **that one tool result**, even when there is no output or the call is still running; it does not connect different Thinking blocks or merge consecutive tools. On very narrow terminals, the branch is dropped to leave room for the status and essential metrics. Expanded direct-tool content continues using Pi's native renderer.

**Tighter Compact spacing (Pi 1.1.0 / 1.2.0):** Pi's self-rendered tool component prepends a blank row to each tool, including when another tool follows immediately. For this extension's Compact tool records only, a narrowly scoped, version-checked compatibility adapter removes exactly that native leading blank row and adjusts click coordinates accordingly. This is checked against **both the local SDK and Pi's actual bundled CLI**, which minifies the same mouse-handler implementation differently. It does not change Thinking spacing, tool contents, Normal/Hidden layouts, or third-party tool components. If the expected Pi render structure changes or another extension patches the same component, the adapter leaves the native layout untouched. No cross-message grouping or global transcript reflow is attempted.

For **Codemode** specifically:

- **Normal** retains Pi's native script, nested-call, and output rendering (including its own expand/collapse behavior).
- **Compact** uses a two-line, status-colored summary with concise English labels: a highlighted Codemode title and script line count, followed by grouped execution status, nested-call counts, output size (`57 out`), and duration. A green `✓` replaces redundant `✓ Done`; `! Partial` identifies successful parent calls with failed/cancelled nested steps, while `✗ Failed` remains explicit for a failed parent. While running, elapsed time is estimated from the first observed partial result (prefixed with `~`, updated every second); when complete, the duration reported by Pi replaces the estimate. It omits script source, nested-call arguments, and actual output, even if expanded or failed. On narrow terminals it keeps each part to one row and prioritizes status and failures.
- **Hidden** removes the Codemode transcript row, including expanded and failed results, without stopping execution or removing Tool/MCP usage accounting.

Example Compact output:

```text
Thinking · 0.7s

  ›  codemode  8 code lines
    ⎿  ✓  1 call · 1 ok  │  59 out · 85ms

  ›  bash  git status
    ⎿  ✓  12 out · 45ms
```

Changing the Tool View mode also updates previously rendered tool rows in the current session. Other third-party tools are unaffected.

When one Thinking segment precedes several tool calls, Pi retains its original message order: one Thinking summary followed by a separate two-line summary for **each** Codemode call. The extension does not merge calls, duplicate Thinking, or inject transcript dividers; layout spacing remains owned by Pi.

Compact summaries for built-in tools and Codemode, mode notifications, and the Tool View status are in English. The CTX cache-hit label is `Cache` (not `Catch`).

### 6. Tool / MCP usage statistics

Tool View groups usage by execution source:

- `DIRECT TOOLS`: top-level model-issued tool calls, including the Codemode parent.
- `NESTED TOOLS`: tools invoked by other tools via Pi `executeTool()` (for example, `bash` or `read` inside Codemode).
- `MCP`: calls attributed to each known MCP server, aggregated across execution sources.

The panel displays two aligned summary values: **RUN** (current run) and **TOTAL** (calls in the active session branch). Only Direct and Nested tool calls contribute to the overall summary; MCP is an attribution of those calls, not additional executions.

An edge-to-edge divider joins both panel borders directly beneath the mode selector, with no horizontal padding. Each group header shows its tool/server count on the left without a redundant subtotal. Only individual tool rows show `Run/Total`; Direct and Nested names align at the same left column without prefix icons. Labels are English-only and shorten on narrow terminals. Run counts with activity are highlighted; zero counts are dimmed. Lists stay fully expanded and scroll when necessary.

Example:

```text
○ Normal      ● Compact      ○ Hidden
├─────────────────────────────────────┤
RUN                                 TOTAL
16                                     93
───────────────────────────────────────
DIRECT TOOLS · 1
codemode                            16/32
───────────────────────────────────────
NESTED TOOLS · 7
bash                                 0/30
task_todos                           0/15
read                                  0/8
...
```

A top-level `codemode` invocation is counted once in `DIRECT TOOLS`; each completed tool it invokes is counted in `NESTED TOOLS`. If the same tool name is used directly and within Codemode, it appears in both sections with separate counts. `MCP` is a server attribution of tool activity (not an additional tool invocation), so don't add MCP totals to Direct + Nested totals. The left column is the current run; it resets at the next run, after a session reload, or on a branch switch. The right column is the cumulative total of the active session branch.

Live usage is counted from `tool_execution_end` events and distinguishes nested calls with `parentToolCallId`. On reload or branch changes, the extension restores both top-level tool results and Pi's persisted `nestedCalls.calls`, de-duplicated by tool-call ID. MCP status changes reattribute live calls without doubling historical results. The right-hand number is the current active-branch total; the left-hand number resets for a new run, reload, or branch switch.

For calls made through MCP gateways, `mcpScript`, and similar wrappers, the extension attempts to attribute activity to the actual MCP server instead of counting only the outer wrapper tool.

### 7. Footer

The extension replaces the default footer with a compact view that displays:

- Current working directory.
- Current Git branch, when available.

The path is automatically truncated to fit terminal width.

## Pi Package Catalog

This package is published to npm with the `pi-package` keyword and a Pi manifest, so it can be discovered by the Pi package catalog at `pi.dev/packages`. The package metadata also declares the preview image shown above for catalog/gallery presentation.

## Installation

### Recommended: install from npm

```bash
pi install npm:pi-ui-extension
```

Pi installs the package and writes the declaration to:

```text
~/.pi/agent/settings.json
```

Example configuration:

```json
{
  "packages": [
    "npm:pi-ui-extension"
  ]
}
```

To pin a specific version:

```bash
pi install npm:pi-ui-extension@1.5.0
```

or:

```json
{
  "packages": [
    "npm:pi-ui-extension@1.5.0"
  ]
}
```

Pinned packages do not automatically move to newer versions.

### Install from GitHub

You can also install directly from the Git repository:

```bash
pi install git:github.com/1993yihuan/pi-ui-extension
```

Configuration form:

```json
{
  "packages": [
    "git:github.com/1993yihuan/pi-ui-extension"
  ]
}
```

Pin to a Git tag:

```bash
pi install git:github.com/1993yihuan/pi-ui-extension@v1.5.0
```

### Temporary local-source testing

To try a local checkout without changing `settings.json`, run from the repository root. Disable automatic extension discovery to avoid loading a previously installed copy of `pi-ui-extension` twice:

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
```

### Project-local installation

To enable the package only for the current project:

```bash
pi install --local npm:pi-ui-extension
```

The declaration is written to:

```text
<project>/.pi/settings.json
```

Project-local packages are loaded only after the project is trusted by Pi.

## Update and removal

Update unpinned extensions:

```bash
pi update --extensions
```

List configured packages:

```bash
pi list
```

Remove the npm source:

```bash
pi remove npm:pi-ui-extension
```

If installed from Git, remove the corresponding Git source:

```bash
pi remove git:github.com/1993yihuan/pi-ui-extension
```

## npm or Git?

For normal usage, npm is recommended:

```text
npm:pi-ui-extension
```

It provides clear SemVer versioning, predictable installation, and easy version pinning.

Use Git when you want to follow the latest repository state or test changes that have not yet been published to npm:

```text
git:github.com/1993yihuan/pi-ui-extension
```

For active local development, loading a local checkout is usually faster than committing, pushing, and updating on every change.

## Local development

Clone the repository:

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
```

Install dependencies:

```bash
npm ci
```

Run the full validation suite:

```bash
npm run check
```

Equivalent commands:

```bash
npm run typecheck
npm test
```

The test suite covers Sidebar, CTX, Session management, official Tool View renderers, MCP resources, mouse scrolling, and resize handling.

During development, Pi can load the local source directory directly:

```bash
pi install ./path/to/pi-ui-extension
```

Or load it temporarily for one run:

```bash
pi -e ./path/to/pi-ui-extension
```

## Package structure

```text
pi-ui-extension/
├── extensions/
│   ├── ctx/                 # Context composition, delta, runtime metrics
│   ├── footer/              # Footer
│   ├── mcp/                 # MCP resource / usage integration
│   ├── session/             # Session list and actions
│   ├── sidebar/             # Sidebar layout, scrolling, resize
│   ├── tool-view/           # Tool View modes and usage statistics
│   └── index.ts             # Pi Extension entry point
├── .github/workflows/
│   ├── ci.yml               # Automatic checks on push / PR
│   └── release.yml          # npm publishing + GitHub Release on tags
├── package.json
└── tsconfig.check.json
```

Pi's extension entry point is declared explicitly in `package.json`:

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

Every push to `main` and every pull request checks **Node.js 22.19.0 / 24 × Pi SDK 1.1.0 / 1.2.0** (4 combinations):

```text
npm ci
→ pin the selected Pi SDK family (older SDK leg only)
→ verify installed Pi SDK versions
→ npm run typecheck
→ npm test
→ npm run check:package
```

The npm tarball excludes all `*.test.ts` files; `npm run check:package` verifies that no tests are packed and that every runtime TypeScript source is included. Tests remain in the repository and run during CI.

To publish a release, create a version tag, for example:

```bash
npm version patch
git push
git push --tags
```

A `v*` tag triggers the release workflow:

```text
Checkout
→ validate release tag format and main ancestry
→ Node.js 24
→ npm ci
→ npm run check
→ verify tag == package.json version
→ npm pack --dry-run
→ npm Trusted Publishing (OIDC)
→ npm publish
→ verify npm Registry visibility (up to ~10 minutes of retries)
→ GitHub Release
```

npm publishing uses GitHub Actions OIDC Trusted Publishing, so no long-lived `NPM_TOKEN` is required in the repository.

Because npm can accept a publication before the new version becomes searchable, the release workflow waits up to approximately 10 minutes for registry indexing. If that verification times out, check the package on npm before retrying: a successful publish cannot be repeated for the same version.

## Compatibility and design principles

- Does not modify Pi Core.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are host-provided peer dependencies to avoid duplicate runtime instances.
- Tool View changes only how built-in tool calls are rendered, using Pi's public renderer resolver rather than overriding their implementations.
- Session and resource operations use Pi public APIs wherever possible.
- Context composition is clearly presented as an estimate, not provider-exact token accounting.
- Fullscreen sidebar behavior degrades safely when fullscreen layout is unavailable.

## Requirements

- Pi Coding Agent with the official `registerToolRenderer()` API (CI tests SDK 1.1.0 and 1.2.0; development targets 1.2.0)
- Node.js `>= 22.19.0` (use a Node version supported by your Pi installation)
- CI validates Node.js 22.19.0 and 24 × Pi SDK 1.1.0 and 1.2.0; releases use Node.js 24

## Multiple Pi installations

Pi may be installed through Bun and npm at the same time. The current plugin uses the `pi` executable resolved by your shell, not necessarily the newest global package. Check before troubleshooting version-specific behavior:

```bash
command -v pi
pi --version
bun pm ls -g
npm ls -g @earendil-works/pi-coding-agent --depth=0
pi list
```

If multiple installations are present, standardize on one package manager **after** confirming that other shells and projects do not rely on the older installation. For example, an obsolete npm-global install can be removed with `npm uninstall -g @earendil-works/pi-coding-agent` once no longer needed; this repository never performs global uninstallation automatically. Use `pi -e ./extensions/index.ts` from this repository to test the local changes; an installed npm package stays unchanged until deliberately updated.

Pi 1.2.0 emits `before_agent_start` for both user prompts and idle custom-triggered runs. Tool/MCP exchange counters and CTX deltas therefore reset per **run**, not only per user prompt. Aborted runs are shown separately from actual tool failures. MCP connectivity is only marked connected when explicitly observed by a supported runtime adapter; configuration and extension registration alone are not proof of an active connection. Connection health from a previous session is discarded on reload.

## License

This project is licensed under the [MIT License](LICENSE).
