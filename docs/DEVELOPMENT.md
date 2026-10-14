# Development and release guide

[Back to README](../README.md) · [简体中文 README](../README.zh-CN.md) · [Architecture](ARCHITECTURE.md)

This document contains maintainer-level instructions for `pi-ui-extension`. User-facing commands and feature descriptions belong in the main README.

## Prerequisites

- Node.js **>= 22.19.0** and npm.
- Pi Coding Agent with `registerToolRenderer()`. Development uses Pi SDK **1.2.0**, while CI additionally tests **1.1.0**.
- Pi fullscreen mode for the sidebar. The standard shell command may resolve to a Bun-global or npm-global Pi installation.

## Checkout and test

```bash
git clone https://github.com/1993yihuan/pi-ui-extension.git
cd pi-ui-extension
npm ci
npm run check
```

`npm run check` runs type checking, tests, and package validation:

```bash
npm run typecheck
npm test
npm run check:package
```

The package check verifies that published runtime TypeScript files are included, while `*.test.ts` files are excluded from the npm tarball. Preview it with:

```bash
npm pack --dry-run
```

For one-off testing against **local source**, use the entry point from the repository root:

```bash
pi --no-extensions -e builtin:mcp -e ./extensions/index.ts --tui-mode fullscreen
```

`--no-extensions` prevents auto-discovery of a second, previously installed copy; explicitly listed `-e` extensions continue to load. To install a local path persistently instead, use `pi install ./path/to/pi-ui-extension`, noting that this changes Pi package configuration.

## Source layout

```text
pi-ui-extension/
├── extensions/
│   ├── ctx/                 # Context composition, deltas, runtime metrics
│   ├── footer/              # Compact footer
│   ├── mcp/                 # MCP resources, runtime state and attribution
│   ├── session/             # Session browsing, question count and cleanup
│   ├── sidebar/             # Fullscreen panels, scrolling and resize
│   ├── tool-view/           # Normal/Compact/Hidden, Thinking and tool counters
│   └── index.ts             # Pi extension entry point
├── docs/
│   ├── ARCHITECTURE.md
│   └── DEVELOPMENT.md
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── package.json
└── tsconfig.check.json
```

Pi discovers the runtime entry point through the `pi.extensions` manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

The `pi-package` keyword and declared package image make the published package eligible for Pi Package Catalog discovery. The image URL in `package.json` is also used by gallery/catalog consumers; do not change it without an updated visual asset.

## Supported test matrix

The [CI workflow](../.github/workflows/ci.yml) validates all four combinations on pushes to `main` and pull requests:

| Node.js | Pi SDK |
| --- | --- |
| 22.19.0 | 1.1.0 |
| 22.19.0 | 1.2.0 |
| 24 | 1.1.0 |
| 24 | 1.2.0 |

The older Pi SDK leg pins the entire `@earendil-works/pi-*` SDK family to `1.1.0` so transitive semver ranges do not mix incompatible versions. The installed SDK versions are checked before running the complete test suite.

**Do not rely on local SDK-only tests for host UI compatibility.** Global Pi distributions may run a separately bundled class instance with different minified method text. The Compact spacing regression tests cover both the unbundled SDK and bundled CLI; also validate actual `pi -e` behavior when changing guarded host UI interactions. See [Architecture](ARCHITECTURE.md).

## Multiple Pi installations

A shell can resolve a Bun-global Pi instead of an npm-global Pi, even when npm has a newer package. Verify the active binary before diagnosing behavior:

```bash
command -v pi
pi --version
bun pm ls -g
npm ls -g @earendil-works/pi-coding-agent --depth=0
pi list
```

Check which shells and projects rely on each installation before removing an older package. For example, `npm uninstall -g @earendil-works/pi-coding-agent` is only appropriate if that particular global npm install is no longer needed. This repository does not uninstall Pi automatically.

## Release workflow

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) for publishing. It triggers on `v*` tags, validates tag format, and checks that the tagged commit is reachable from `main`.

For a documentation-only correction, use a patch release, e.g. `1.5.1`. Bump the package version, update the lockfile and **version-pinned installation examples in both README languages**, then run validation:

```bash
npm version patch --no-git-tag-version
npm run check
npm pack --dry-run
```

Review the diff, commit only intended files, push to `main`, and wait for all four CI checks. Then create the matching annotated tag at the tested commit and push it:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Substitute the exact version for `X.Y.Z`. Avoid pushing a tag for an untested commit; never force-push release tags. The Release workflow performs:

1. Validate tag, ancestry and npm package version.
2. Install dependencies under Node.js 24 and run `npm run check`.
3. Inspect the package with `npm pack --dry-run`.
4. Publish with **npm Trusted Publishing (OIDC)**, without a long-lived `NPM_TOKEN`.
5. Retry npm Registry visibility for up to approximately **10 minutes**.
6. Create an official GitHub Release once registry verification succeeds.

Before announcing a successful release, independently verify:

```bash
npm view pi-ui-extension@X.Y.Z version --registry=https://registry.npmjs.org --prefer-online
gh release view vX.Y.Z
git rev-parse HEAD
git rev-parse origin/main
git rev-list -n1 vX.Y.Z
```

If registry verification times out, **inspect npm first** before attempting any further publish. npm versions are immutable, and publication may have succeeded even though indexing is delayed. Do not retry `npm publish` for a version that may already exist.

## Documentation conventions

- `README.md` and `README.zh-CN.md` describe the same user-facing features and commands.
- Preserve session deletion warnings, MCP connectivity limits, CTX estimation caveats, and Thinking visibility requirements.
- Internal algorithms, version-specific Pi adapters and diagnostics belong in `ARCHITECTURE.md` rather than duplicated across the user README files.
- Keep both language versions and install pins synchronized for each release.
