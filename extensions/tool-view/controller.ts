import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  SettingsManager,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { TOOL_VIEW_MODES, isToolViewMode, type ToolViewMode } from "./types.ts";

const DEFAULT_MODE_FILE = resolve(getAgentDir(), "tool-view-mode.json");
const MODE_STATUS_ID = "pi-ui-extension:tool-view";
const MODE_COMMAND = "tool-view";
const MODE_SHORTCUT = "ctrl+shift+o";
const MODE_ORDER = TOOL_VIEW_MODES;

type AnyToolDefinition = ToolDefinition<any, any, any>;
type AnyToolResult = AgentToolResult<any>;
type AnyRenderContext = Parameters<NonNullable<AnyToolDefinition["renderCall"]>>[2];

type RendererState = {
  nativeState?: any;
  nativeCallComponent?: ReturnType<NonNullable<AnyToolDefinition["renderCall"]>>;
  nativeResultComponent?: ReturnType<NonNullable<AnyToolDefinition["renderResult"]>>;
  nativeBox?: Box;
};

interface StoredMode {
  mode: ToolViewMode;
}

interface CompactToolSpec {
  call(args: any): { title: string; detail?: string };
  result(result: AnyToolResult, context: AnyRenderContext): string;
}

function modeLabel(mode: ToolViewMode): string {
  switch (mode) {
    case "normal": return "完整";
    case "compact": return "紧凑";
    case "hidden": return "隐藏";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactText(value: unknown, maxLength = 96): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function textOutput(result: AnyToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function nonEmptyLineCount(text: string): number {
  if (!text.trim()) return 0;
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function itemCount(text: string): number {
  return nonEmptyLineCount(text);
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function diffStats(diff: string | undefined): string {
  if (!diff) return "已应用";
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return `+${additions}/-${removals}`;
}

function isPathInside(filePath: string, root: string): boolean {
  const pathFromRoot = relative(root, filePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function resolveToolPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return resolve(cwd, value);
}

function isLikelySkillPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return (
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.pi/agent/skills/") ||
    normalized.includes("/.pi/skills/")
  );
}

const COMPACT_SPECS: Record<string, CompactToolSpec> = {
  read: {
    call: (args) => ({ title: "read", detail: compactText(args.path) || "…" }),
    result: (result) => {
      const output = textOutput(result);
      const imageCount = result.content.filter((item) => item.type === "image").length;
      if (imageCount > 0 && !output.trim()) return formatCount(imageCount, "image");
      return formatCount(output.split("\n").length, "line");
    },
  },
  bash: {
    call: (args) => ({ title: "$", detail: compactText(args.command) || "…" }),
    result: (result) => {
      const lines = nonEmptyLineCount(textOutput(result));
      return lines > 0 ? `完成 · ${formatCount(lines, "line")}` : "完成";
    },
  },
  edit: {
    call: (args) => ({ title: "edit", detail: compactText(args.path) || "…" }),
    result: (result) => diffStats(result.details?.diff),
  },
  write: {
    call: (args) => {
      const lines = typeof args.content === "string" ? args.content.split("\n").length : 0;
      return {
        title: "write",
        detail: `${compactText(args.path) || "…"}${lines > 0 ? ` · ${formatCount(lines, "line")}` : ""}`,
      };
    },
    result: () => "已写入",
  },
  grep: {
    call: (args) => ({
      title: "grep",
      detail: `${compactText(args.pattern) || "…"} · ${compactText(args.path) || "."}`,
    }),
    result: (result) => formatCount(itemCount(textOutput(result)), "match", "matches"),
  },
  find: {
    call: (args) => ({
      title: "find",
      detail: `${compactText(args.pattern) || "…"} · ${compactText(args.path) || "."}`,
    }),
    result: (result) => formatCount(itemCount(textOutput(result)), "file"),
  },
  ls: {
    call: (args) => ({ title: "ls", detail: compactText(args.path) || "." }),
    result: (result) => formatCount(itemCount(textOutput(result)), "entry", "entries"),
  },
};

export interface ToolViewController {
  getMode(): ToolViewMode;
  setMode(mode: ToolViewMode, ctx: ExtensionContext, notify?: boolean): Promise<void>;
  onModeChange(listener: (mode: ToolViewMode) => void): () => void;
}

export type ToolViewControllerOptions = {
  readonly modeFile?: string;
};

export async function installToolViewController(
  pi: ExtensionAPI,
  options: ToolViewControllerOptions = {},
): Promise<ToolViewController> {
  const modeFile = options.modeFile ?? DEFAULT_MODE_FILE;
  let mode = await loadMode();
  let skillRoots = new Set<string>();
  let activeSessionId: string | undefined;
  let sessionGeneration = 0;
  let modeChangeQueue = Promise.resolve();
  const modeListeners = new Set<(mode: ToolViewMode) => void>();

  async function loadMode(): Promise<ToolViewMode> {
    try {
      const stored = JSON.parse(await readFile(modeFile, "utf8")) as Partial<StoredMode>;
      return typeof stored.mode === "string" && isToolViewMode(stored.mode) ? stored.mode : "compact";
    } catch {
      return "compact";
    }
  }

  async function persistMode(nextMode: ToolViewMode): Promise<void> {
    const tempFile = `${modeFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`; 
    const stored: StoredMode = { mode: nextMode };
    await writeFile(tempFile, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tempFile, modeFile);
  }

  function notifyModeChange(): void {
    for (const listener of modeListeners) listener(mode);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(MODE_STATUS_ID, `工具：${modeLabel(mode)}`);
  }

  function requestTranscriptRerender(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    // Pi has no dedicated transcript-invalidate API. Toggling the public
    // expanded state forces every historical tool row to rebuild, then
    // restores the user's original expansion preference.
    const expanded = ctx.ui.getToolsExpanded();
    ctx.ui.setToolsExpanded(!expanded);
    ctx.ui.setToolsExpanded(expanded);
  }

  function setMode(nextMode: ToolViewMode, ctx: ExtensionContext, notify = true): Promise<void> {
    const generation = sessionGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    modeChangeQueue = modeChangeQueue.then(async () => {
      mode = nextMode;
      let persistError: unknown;
      try {
        await persistMode(mode);
      } catch (error) {
        persistError = error;
      }

      // Event callbacks can receive different context wrapper objects for the
      // same session. Guard by stable session identity plus generation rather
      // than object identity, while still rejecting contexts invalidated by a
      // session replacement or reload during the disk write.
      if (generation !== sessionGeneration || activeSessionId !== sessionId) return;
      if (persistError) {
        ctx.ui.notify(`工具显示模式已切换，但保存失败：${errorMessage(persistError)}`, "warning");
      }
      updateStatus(ctx);
      notifyModeChange();
      requestTranscriptRerender(ctx);
      if (notify) ctx.ui.notify(`工具显示模式：${modeLabel(mode)}（${mode}）`, "info");
    });
    return modeChangeQueue;
  }

  function cycleMode(ctx: ExtensionContext): Promise<void> {
    const index = MODE_ORDER.indexOf(mode);
    return setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]!, ctx);
  }

  function updateSkillRootsFromPromptOptions(skills: Array<{ baseDir?: string; filePath?: string }> | undefined): void {
    const roots = new Set<string>();
    for (const skill of skills ?? []) {
      if (skill.baseDir) roots.add(resolve(skill.baseDir));
      else if (skill.filePath) roots.add(dirname(resolve(skill.filePath)));
    }
    skillRoots = roots;
  }

  function shouldPreserveReadRenderer(args: any, context: AnyRenderContext): boolean {
    const absolutePath = resolveToolPath(context.cwd, args.path);
    if (!absolutePath) return false;
    if (isLikelySkillPath(absolutePath)) return true;
    for (const root of skillRoots) {
      if (isPathInside(absolutePath, root)) return true;
    }
    return false;
  }

  function nativeContext(
    context: AnyRenderContext,
    nativeState: any,
    lastComponent: RendererState["nativeCallComponent"] | RendererState["nativeResultComponent"],
  ): AnyRenderContext {
    return { ...context, state: nativeState, lastComponent };
  }

  function callNativeRenderer(
    definition: AnyToolDefinition,
    args: any,
    theme: Theme,
    context: AnyRenderContext,
  ) {
    const state = context.state as RendererState;
    state.nativeState ??= {};
    try {
      const component = definition.renderCall?.(
        args,
        theme,
        nativeContext(context, state.nativeState, state.nativeCallComponent),
      ) ?? new Container();
      state.nativeCallComponent = component;
      return component;
    } catch {
      state.nativeCallComponent = undefined;
      return new Text(theme.fg("toolTitle", theme.bold(definition.name)), 0, 0);
    }
  }

  function resultNativeRenderer(
    definition: AnyToolDefinition,
    result: AnyToolResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: AnyRenderContext,
  ) {
    const state = context.state as RendererState;
    state.nativeState ??= {};
    try {
      const component = definition.renderResult?.(
        result,
        options,
        theme,
        nativeContext(context, state.nativeState, state.nativeResultComponent),
      ) ?? new Container();
      state.nativeResultComponent = component;
      return component;
    } catch {
      state.nativeResultComponent = undefined;
      const output = textOutput(result);
      return output ? new Text(theme.fg("toolOutput", output), 0, 0) : new Container();
    }
  }

  function compactCall(toolName: string, args: any, theme: Theme) {
    const summary = COMPACT_SPECS[toolName]!.call(args);
    const title = theme.fg("toolTitle", theme.bold(summary.title));
    const detail = summary.detail ? ` ${theme.fg("accent", summary.detail)}` : "";
    return new Text(title + detail, 0, 0);
  }

  function compactResult(
    toolName: string,
    result: AnyToolResult,
    theme: Theme,
    context: AnyRenderContext,
  ) {
    const summary = COMPACT_SPECS[toolName]!.result(result, context);
    return new Text(theme.fg("success", "✓ ") + theme.fg("muted", summary), 0, 0);
  }

  function registerManagedTool(definitionFactory: (cwd: string, projectTrusted: boolean) => AnyToolDefinition): void {
    // Registration and rendering must never opt into project settings.
    const initialDefinition = definitionFactory(process.cwd(), false);
    const definitionsByCwd = new Map<string, AnyToolDefinition>([[process.cwd(), initialDefinition]]);
    const definitionFor = (cwd: string): AnyToolDefinition => {
      const cached = definitionsByCwd.get(cwd);
      if (cached) return cached;
      const created = definitionFactory(cwd, false);
      definitionsByCwd.set(cwd, created);
      return created;
    };

    const toolName = initialDefinition.name;
    pi.registerTool({
      name: initialDefinition.name,
      label: initialDefinition.label,
      description: initialDefinition.description,
      promptSnippet: initialDefinition.promptSnippet,
      promptGuidelines: initialDefinition.promptGuidelines,
      parameters: initialDefinition.parameters,
      constrainedSampling: initialDefinition.constrainedSampling,
      prepareArguments: initialDefinition.prepareArguments,
      executionMode: initialDefinition.executionMode,
      // Use a self-rendered shell so hidden mode can remove the entire row. In
      // normal mode, wrap native renderers to reproduce Pi's default shell.
      renderShell: "self",

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // Resolve current settings and trust on every execution, independently of the render cache.
        return definitionFactory(ctx.cwd, ctx.isProjectTrusted()).execute(toolCallId, params, signal, onUpdate, ctx);
      },

      renderCall(args, theme, context) {
        const nativeDefinition = definitionFor(context.cwd);
        const preserveNative = toolName === "read" && shouldPreserveReadRenderer(args, context);
        const useNative = preserveNative || mode === "normal" || (mode === "compact" && (context.isError || context.expanded || !COMPACT_SPECS[toolName]));
        if (useNative) {
          const component = callNativeRenderer(nativeDefinition, args, theme, context);
          if (nativeDefinition.renderShell === "self") return component;
          const state = context.state as RendererState;
          const box = state.nativeBox ?? new Box(1, 1);
          state.nativeBox = box;
          box.clear();
          box.setBgFn((text) => theme.bg(
            context.isError ? "toolErrorBg" : context.isPartial ? "toolPendingBg" : "toolSuccessBg",
            text,
          ));
          box.addChild(component);
          return box;
        }
        if (mode === "hidden") return new Container();
        return compactCall(toolName, args, theme);
      },

      renderResult(result, options, theme, context) {
        const nativeDefinition = definitionFor(context.cwd);
        const preserveNative = toolName === "read" && shouldPreserveReadRenderer(context.args, context);
        const useNative = preserveNative || mode === "normal" || (mode === "compact" && (context.isError || options.expanded || !COMPACT_SPECS[toolName]));
        if (useNative) {
          const component = resultNativeRenderer(nativeDefinition, result, options, theme, context);
          if (nativeDefinition.renderShell === "self") return component;
          const state = context.state as RendererState;
          // renderCall runs immediately before renderResult and rebuilds this
          // shared box with the native call component.
          state.nativeBox?.addChild(component);
          return new Container();
        }
        if (mode === "hidden") {
          const state = context.state as RendererState;
          // If this row previously used a native streaming renderer (notably
          // bash), let its final render run once so timers/resources settle,
          // then discard the visual component.
          if (!options.isPartial && state.nativeResultComponent) {
            resultNativeRenderer(nativeDefinition, result, options, theme, context);
          }
          return new Container();
        }
        if (options.isPartial) return new Text(theme.fg("warning", "运行中…"), 0, 0);
        const state = context.state as RendererState;
        if (state.nativeResultComponent) {
          resultNativeRenderer(nativeDefinition, result, options, theme, context);
        }
        return compactResult(toolName, result, theme, context);
      },
    });
  }

  registerManagedTool((cwd, projectTrusted) => {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
    return createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() });
  });
  registerManagedTool((cwd, projectTrusted) => {
    const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
    return createBashToolDefinition(cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    });
  });
  registerManagedTool((cwd) => createEditToolDefinition(cwd));
  registerManagedTool((cwd) => createWriteToolDefinition(cwd));
  registerManagedTool((cwd) => createGrepToolDefinition(cwd));
  registerManagedTool((cwd) => createFindToolDefinition(cwd));
  registerManagedTool((cwd) => createLsToolDefinition(cwd));

  pi.registerCommand(MODE_COMMAND, {
    description: "切换工具显示模式：normal、compact、hidden、status",
    getArgumentCompletions: (prefix) => {
      const values = [...MODE_ORDER, "status"];
      const matches = values.filter((value) => value.startsWith(prefix.trim()));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested || requested === "status") {
        if (!requested && ctx.mode === "tui") {
          const choices = MODE_ORDER.map(
            (value) => `${modeLabel(value)}（${value}）${value === mode ? " · 当前" : ""}`,
          );
          const selected = await ctx.ui.select("选择工具显示模式", choices);
          const selectedIndex = selected ? choices.indexOf(selected) : -1;
          if (selectedIndex >= 0) await setMode(MODE_ORDER[selectedIndex]!, ctx);
          return;
        }
        ctx.ui.notify(`当前工具显示模式：${modeLabel(mode)}（${mode}）`, "info");
        return;
      }
      if (!isToolViewMode(requested)) {
        ctx.ui.notify("用法：/tool-view normal|compact|hidden|status", "warning");
        return;
      }
      await setMode(requested, ctx);
    },
  });

  pi.registerShortcut(MODE_SHORTCUT, {
    description: "循环切换工具显示模式",
    handler: cycleMode,
  });

  pi.on("before_agent_start", (event) => {
    updateSkillRootsFromPromptOptions(event.systemPromptOptions.skills);
  });

  pi.on("session_start", (_event, ctx) => {
    sessionGeneration++;
    activeSessionId = ctx.sessionManager.getSessionId();
    updateSkillRootsFromPromptOptions(
      pi.getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => ({ filePath: command.sourceInfo.path })),
    );
    updateStatus(ctx);
    notifyModeChange();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionGeneration++;
    activeSessionId = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(MODE_STATUS_ID, undefined);
  });

  return {
    getMode: () => mode,
    setMode,
    onModeChange(listener) {
      modeListeners.add(listener);
      listener(mode);
      return () => modeListeners.delete(listener);
    },
  };
}
