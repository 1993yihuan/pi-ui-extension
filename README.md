# pi-ui-extension

A Pi package that extends the terminal UI with a footer, split-view sidebar, context/activity panels, session controls, resource views, and configurable tool transcript rendering.

## Requirements

- Node.js 24+
- A compatible Pi Coding Agent installation

## Development

Install dependencies:

```bash
npm ci
```

Run the full validation suite:

```bash
npm run check
```

Or run checks separately:

```bash
npm run typecheck
npm test
```

## Package entry

Pi loads the extension from:

```text
./extensions/index.ts
```

The package metadata is declared in `package.json` under the `pi.extensions` field.

## Notes

This repository contains only the extension source and development metadata. Local Pi runtime configuration, credentials, sessions, caches, and browser profiles are intentionally excluded.
