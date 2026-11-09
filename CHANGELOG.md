# Changelog

## 1.20.0

- User-visible session, dialog, notification, and MCP status text is chosen from an English/Chinese string table. Chinese is used when `LC_ALL`, then `LC_MESSAGES`, then `LANG` names a `zh` locale; otherwise the interface is English. `PI_UI_LANG` or `PI_UI_LANGUAGE` overrides that choice.
- Resource and MCP status dialogs report a failure with `notify` when the picker or read-only preview rejects, instead of leaving an unhandled rejection.
- The published package includes `README.zh-CN.md`. The preview image URL points at `main` rather than the v1.7.1 release asset.
- Extension startup is split into resource dialogs, the MCP status dialog, and session commands. `extensions/index.ts` wires those pieces together.

## 1.10.10

- Development and CI `undici` override raised from 8.12.3 to 8.12.4.
