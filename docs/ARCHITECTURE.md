# Architecture and compatibility notes

[Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Development](DEVELOPMENT.md)

These notes document implementation details and conservative compatibility choices of `pi-ui-extension`. The extension does **not** modify the installed Pi Core files or replace underlying tool execution functions. However, some guarded UI interactions depend on the shape of known Pi host components—not exclusively on public APIs.

## Fullscreen UI and resources

The extension composes three responsive panels in Pi's fullscreen terminal UI:

- **SESSIONS** — quick history, advanced manager, pinning, and resource shortcuts.
- **CTX** — estimates and observable runtime measurements.
- **VIEW** — unified tool/Thinking modes and direct/nested/MCP usage.

The sidebar supports mouse events, wheel scrolling, terminal resizing, and scrollable panels in smaller spaces. Regular TUI is not a supported host layout. Footer rendering reports the working directory and Git branch and clips long paths to fit the terminal.

Resource shortcuts inspect current project/Pi instruction, skill, extension, and MCP resources. They do not attempt to load or connect missing resources.

## Session management and safety

The quick session list favors the current session and pinned sessions; pins persist as IDs in `pi-ui-extension/session-pins.json` under the Pi agent directory. Pins do not save message bodies. The quick sidebar supports `☆`/`★` without opening `/sessions-manager`, with lower-priority buttons hidden when space is limited.

The visible session number counts **top-level user question messages** from a session's JSONL history, not all Pi messages. Assistant messages, tool results and nested operations are not counted. The incremental JSONL reader processes appended bytes, buffers incomplete lines, and rebuilds if the file is truncated or replaced. Missing/unreadable histories display `?`, not a misleading zero.

Advanced management (`/sessions-manager` or `≡`) offers paging (eight records), search, sorting, pinning, renaming, switching and confirmed trash moves. Switching and mutating saved session state requires Pi to be idle.

**Bulk cleanup safeguards:**

1. Never delete the current session or pinned sessions.
2. Exclude sessions whose modification time is within the last **five minutes**.
3. Exclude sessions advertised as active by Pi instances running this extension. These instances keep private activity metadata under `pi-ui-extension/active-sessions/` in Pi's agent directory and clear it on normal shutdown.
4. Immediately before moving each file to trash, recheck current-session identity, pin state, active records, file identity and mtime. Skip sessions changed during confirmation.

A Pi process **not running this extension cannot be reliably detected** by this mechanism. Avoid bulk cleanup when such processes may be using historical sessions. Explicit single-session deletion still requires confirmation and does not use the bulk-cleanup five-minute grace period.

## CTX estimation and refresh

CTX shows the active model and Thinking level, context size and usage, current-run delta, image count, category composition, and speed measurements (run turns/duration, average TTFT/TPS, latest TTFT, cache indicators where observable).

The `System`, `Tools`, `Messages`, `Tool Results`, `Summary`, and `Other` breakdown uses **local heuristic token estimates**. It is for composition and trend analysis, **not provider-exact tokenization or billing**. For tools, prefer the actual observable provider-request tool payload; before a provider request is available, estimate Pi's enabled tool schemas instead.

To reduce redraw work, streaming token estimates are sampled at most once every **150 ms**, while the first valid token update is shown immediately. Unchanged estimates do not trigger redundant CTX redraws. The elapsed-time ticker runs only while an agent run is active and is cleaned up when it settles or the panel is disposed.

Pi 1.2.0 can emit `before_agent_start` for user prompts and idle custom-triggered runs. Therefore, CTX deltas and Tool/MCP **RUN** counters reset for each agent run, not strictly for each user question. A cancelled/aborted run should not be reported as a tool failure.

## Thinking display and measured duration

The VIEW selector (`Normal`, `Compact`, `Hidden`) is shared across tool transcript and assistant Thinking presentation; there is no second Thinking selector or persistence file. The mode is stored in `tool-view-mode.json`, and changing it refreshes previously rendered content in the current session.

- **Normal** keeps native tool transcripts and complete Thinking.
- **Compact** shows terminal-wrapped suffix of the latest **seven** Thinking lines while streaming, then `Thinking · 5s` (for example) when completed. Supported built-in tools use concise summaries.
- **Hidden** suppresses tool transcripts and never renders Thinking body text, including during streaming; it shows only status and measured duration when available.

Timing uses Pi's observable `thinking_start` and `thinking_end` events for the Thinking segment wall clock. It does **not** claim to measure a model's private internal work or its entire response time. Streaming durations have a `~` indicator and update as new content arrives. After completion, measured time stays fixed. Historical sessions or missing events with no trustworthy duration display just `Thinking`—no invented timer. A narrow terminal may omit the time suffix rather than wrap it.

Pi's native `hideThinkingBlock=true` short-circuits the extension's Markdown transformation. For Compact/Hidden Thinking summaries to appear, set native visibility to **on** (`hideThinkingBlock=false`, or Pi's corresponding control).

Compact/Hidden Thinking summaries are read-only on verified hosts: a narrow, version-checked click guard prevents the native click-to-hide handler turning the summary into `Thinking...`. Normal keeps native mouse behavior. The transformation and display mechanisms rely on Pi's public `registerMarkdownTransformer()` and `setHiddenThinkingLabel()` APIs, with the limited click compatibility guard described below. Unknown Pi structures fall back to native interaction.

VIEW controls display only: reasoning settings, transcript source content, tool execution and stored session data are not altered.

## Compact tool presentation and guarded spacing

The extension registers custom display renderers through Pi's **public** `registerToolRenderer()` interface for these built-in tools:

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`.

It never replaces tool definitions or execution functions. Special native renderers (including certain Skill-related reads and failed-tool details) and unrelated third-party tools retain their own presentation when needed for correctness.

In Compact, supported tools use a dimmed result branch, consistent indentation and `›`/`⌄` chevrons:

```text
Thinking · 0.7s
  ›  codemode  8 code lines
    ⎿  ✓  1 call · 1 ok  │  59 out · 85ms
  ›  bash  git status
    ⎿  ✓  12 out · 45ms
```

Each tool call remains independent—even when multiple tools follow one Thinking segment. There is no cross-message tree connection, inferred grouping, or inserted group divider. Results distinguish success (`✓`), ongoing activity (`… Running`), failed parent call (`✗ Failed`) and a successful Codemode parent containing failed/cancelled nested calls (`! Partial`). The `│` metric separator only divides meaningful metric groups, never the first status-to-metric transition. Output and duration labels shorten or truncate on narrow terminals; the `⎿` decoration may be omitted first.

Supported built-in tools, **including Codemode**, can be clicked to expand Pi's **native** details without leaving Compact. Collapsed Codemode continues to show just metadata (script line count, nested-call status/count, output size and duration). An expanded Codemode shows the native script, nested tool calls and arguments, output and errors; clicking again restores the two-line Compact summary. The native renderer retains its own expanded state and display logic. Normal still uses Pi's full native rendering; Hidden removes transcript rows without cancelling execution or usage accounting.

**Why a host UI adapter exists:** Pi 1.1.0 and 1.2.0 self-rendered tool components insert a leading blank row before each tool. Public tool renderer APIs cannot control that space. Compact therefore uses a deliberately limited compatibility adapter to remove **exactly one expected blank row** for renderers owned by this extension, and adjusts the mouse y-coordinate so click expansion still targets the right row. It does not change Thinking spacing or third-party, Normal or Hidden layouts.

The adapter:

- Accepts only known Pi 1.1.0/1.2.0 host layouts.
- Validates expected render/mouse method shape before patching; incompatible or previously patched shapes fail closed.
- Accounts for the difference between unbundled SDK (`event.y - 1`) and the official minified Pi CLI (`event.y-1`). The bundled CLI may use a different class instance from the project SDK.
- Marks extension-owned renderers to avoid rewriting every tool, offsets click coordinates, and avoids stacked wrappers across reloads.
- Is covered by real Pi component tests and bundled/unbundled layout checks. Unsupported hosts keep Pi's original spacing.

These adapters operate on host **runtime UI components**, not on Pi Core source files or the underlying tool execution methods. Consequently, claims that *all* rendering customization uses exclusively public APIs would be inaccurate. The design prioritizes bounded, testable adjustments and safe fallback.

## Tool/MCP counting and attribution

VIEW distinguishes actual tool executions from their attribution:

| Category | Counted activity |
| --- | --- |
| **DIRECT TOOLS** | Top-level model-issued tool calls; a Codemode parent is one direct call |
| **NESTED TOOLS** | `executeTool()` calls made by parent tools, including Codemode's nested `bash`/`read` |
| **MCP** | An attribution of known direct/nested calls to a server, **not new executions** |

The panel displays **RUN** (current agent run) and **TOTAL** (active session branch). A tool used both directly and inside a parent appears separately in Direct and Nested. Adding MCP totals to the Direct+Nested grand total would double-count the same executions; don't do it.

During execution, `tool_execution_end` provides observations and `parentToolCallId` identifies nested tool calls. The extension also restores persisted top-level tool results and Pi's `nestedCalls.calls` for the active branch, de-duplicating by call ID. Session/branch changes rebuild totals. MCP server discovery may arrive after calls; re-attribution should not create extra executions or duplicate historical counts. Gateway and `mcpScript` calls are attributed where supported, alongside native Pi `mcp__server__tool` names.

The RUN counter is reset by each new run, session reload or branch switch; TOTAL is cumulative for the active session branch. Names under Direct/Nested align consistently; display metadata and counts shrink with the width of the sidebar.

## MCP state, privacy and limitations

The read-only MCP center combines native/global and trusted-project configuration, project enable/disable overrides (including Pi `enabled: false`), extension registration through `pi.registerMcpServer()`, and observable reports from `pi-mcp-adapter/status/v1`.

**Configuration, registration and loading are not evidence of connectivity.** Report Connected/Connecting/Failed only when an adapter explicitly confirms those states. Pi does not expose complete native MCP connection health to ordinary UI extensions. Use the active `/mcp` manager for live diagnostics, reconnecting, authenticating or changing configuration.

MCP status UI never displays commands, raw endpoint URLs, headers, tokens, environment values, or raw error messages. Cached health from a previous session is discarded on reload rather than shown as current.

## Dependency and release considerations

The Pi coding-agent and TUI packages are peer dependencies to avoid bundling duplicate host instances. The code still protects against the real CLI's separately bundled UI runtime via explicit version/shape checks. CI tests Node 22.19.0/24 × Pi SDK 1.1.0/1.2.0.

Published npm tarballs contain runtime TypeScript sources but not `*.test.ts`. The full test suite and release workflow are described in [Development](DEVELOPMENT.md); there is no need to ship these architecture notes in the npm tarball when the main README links to the GitHub copies.
