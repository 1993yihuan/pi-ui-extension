# Changelog

## 1.20.5

- The CTX panel reuses the host's context-usage scan until the branch leaf or the context-window model changes, instead of rescanning a full session projection on every rendered frame. An in-place message change, a model change, a branch switch and compaction still force a fresh scan.
- CTX reuses the active-branch message estimate across `turn_end` and the `agent_settled` that follows it. The system prompt, the active tool definitions, the provider tool and image measurement, the run delta and the settled baseline are still recomputed or updated on every refresh.

## 1.20.3

- Keep cached session summaries isolated to the current project when reads fail in a shared session directory. Preserve the current project's last good summary until the file is readable again.
- Complete Chinese CTX status, composition, image, and performance labels. Preserve English text, technical abbreviations, and narrow-terminal layouts.

## 1.20.2

- Align the Chinese protection reason counts in the full cleanup confirmation layout by terminal display width, so a CJK label no longer pushes the count column out of line.

## 1.20.1

- Keep every session cleanup protection count visible in Chinese when the confirmation dialog uses its narrow layout.

## 1.20.0

- User-visible session, dialog, notification, and MCP status text is chosen from an English/Chinese string table. Chinese is used when `LC_ALL`, then `LC_MESSAGES`, then `LANG` names a `zh` locale; otherwise the interface is English. `PI_UI_LANG` or `PI_UI_LANGUAGE` overrides that choice.
- Resource and MCP status dialogs report a failure with `notify` when the picker or read-only preview rejects, instead of leaving an unhandled rejection.
- The published package includes `README.zh-CN.md`. The preview image remains the existing v1.7.1 release asset until a current screenshot is added.
- Extension startup is split into resource dialogs, the MCP status dialog, and session commands. `extensions/index.ts` wires those pieces together.

## 1.10.10

- Development and CI `undici` override raised from 8.12.3 to 8.12.4.
