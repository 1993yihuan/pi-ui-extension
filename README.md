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
- Use the `⊗` action to remove all other sessions.
- Click `SESSIONS ↻` to refresh the session list.

To avoid corrupting active agent state, switching, renaming, deleting, and bulk cleanup are only allowed while Pi is idle. The current session cannot be deleted.

### 3. Resource shortcuts

The bottom of the `SESSIONS` panel exposes four resource categories:

- `AGENTS.md`
- `Skills`
- `Extensions`
- `MCP`

These shortcuts let you inspect the resources currently loaded by the project/Pi environment, making it easier to verify which agent instructions, skills, extensions, and MCP servers are actually available.

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

### 5. Tool View modes

`TOOL VIEW` supports three transcript display modes:

- **Normal**: standard tool transcript rendering.
- **Compact**: denser tool output rendering.
- **Hidden**: hide tool transcripts.

Modes can be changed directly with mouse clicks.

When Fabric takes ownership of tool rendering, the panel remains visible for usage statistics but the local mode selector is hidden and replaced with `View controlled by Fabric`. This avoids conflicting display control.

### 6. Tool / MCP usage statistics

Tool View groups usage into:

- `TOOLS`
- `MCP`

Each entry is shown as:

```text
current-question calls / current-session calls
```

Example:

```text
task_todos                         1/5
```

Usage state is rebuilt when the active branch changes, so restored sessions and branch switches do not blindly reuse counts from another branch.

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
pi install npm:pi-ui-extension@1.1.1
```

or:

```json
{
  "packages": [
    "npm:pi-ui-extension@1.1.1"
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
pi install git:github.com/1993yihuan/pi-ui-extension@v1.1.1
```

### Temporary usage

To load the package for a single Pi launch without modifying `settings.json`:

```bash
pi -e npm:pi-ui-extension
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

The test suite covers the main behavior of Sidebar, CTX, Session management, Tool View, MCP resources, Fabric detection, mouse scrolling, and resize handling.

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
│   ├── fabric-detection.ts  # Fabric ownership detection
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

Every push to `main` and every pull request runs:

```text
npm ci
→ npm run typecheck
→ npm test
```

To publish a release, create a version tag, for example:

```bash
npm version patch
git push
git push --tags
```

A `v*` tag triggers the release workflow:

```text
Checkout
→ Node.js 24
→ npm ci
→ npm run check
→ verify tag == package.json version
→ npm pack --dry-run
→ npm Trusted Publishing (OIDC)
→ npm publish
→ GitHub Release
```

npm publishing uses GitHub Actions OIDC Trusted Publishing, so no long-lived `NPM_TOKEN` is required in the repository.

## Compatibility and design principles

- Does not modify Pi Core.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are host-provided peer dependencies to avoid duplicate runtime instances.
- Fabric ownership is detected explicitly to avoid conflicting Tool View controls.
- Session and resource operations use Pi public APIs wherever possible.
- Context composition is clearly presented as an estimate, not provider-exact token accounting.
- Fullscreen sidebar behavior degrades safely when fullscreen layout is unavailable.

## Requirements

- Pi Coding Agent
- Node.js `>= 22.19.0` (use a Node version supported by your Pi installation)
- Development and CI currently use Node.js 24

## License

This project is licensed under the [MIT License](LICENSE).
