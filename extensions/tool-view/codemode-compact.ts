import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type MetricColor = "text" | "success" | "error" | "warning" | "muted";
type Metric = {
  label: string;
  color: MetricColor;
  group: "calls" | "output";
  /** Lower priority number survives narrower terminals first. */
  priority: number;
};

const CALL_SEPARATOR = "  │  ";
const METRIC_SEPARATOR = " · ";

/** One terminal row regardless of viewport width; no wrapping or padding. */
function singleLine(line: string): Component {
  return {
    render(width: number): string[] {
      return width > 0 ? [truncateToWidth(line, width, "…")] : [];
    },
    invalidate() {},
  };
}

function formatDuration(durationMs: unknown): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function countContent(result: AgentToolResult<any>): { lines: number; images: number } {
  let lines = 0;
  let images = 0;
  for (const block of result.content) {
    if (block.type === "image") images++;
    else if (block.type === "text" &&
      !/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/.test(block.text)) {
      lines += block.text.split("\n").filter((line) => line.trim().length > 0).length;
    }
  }
  return { lines, images };
}

function codeLineCount(args: unknown): string {
  const code = args !== null && typeof args === "object" && "code" in args
    ? (args as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return "代码行数未知";
  return `${code ? code.split("\n").length : 0} 行代码`;
}

export function renderCodemodeCompactCall(args: unknown, theme: Theme): Component {
  const label = theme.fg("accent", "▸ ") +
    theme.fg("toolTitle", theme.bold("codemode")) +
    theme.fg("dim", `  ${codeLineCount(args)}`);
  return singleLine(label);
}

function formatSummary(
  theme: Theme,
  state: string,
  stateColor: "success" | "error" | "warning",
  metrics: readonly Metric[],
  width: number,
): string {
  const heading = theme.fg(stateColor, state);
  if (width <= visibleWidth(heading)) return truncateToWidth(heading, width, "…");

  // Work out which complete metrics can be shown, then restore display order.
  // Never show half a metric or let Text wrap the row across multiple lines.
  const selected = new Set<Metric>();
  const ranked = metrics.slice().sort((a, b) => a.priority - b.priority);
  const compose = (): string => {
    let row = heading;
    let lastGroup: Metric["group"] | undefined;
    for (const metric of metrics) {
      if (!selected.has(metric)) continue;
      const separator = lastGroup && lastGroup === metric.group ? METRIC_SEPARATOR : CALL_SEPARATOR;
      row += theme.fg("dim", separator) + theme.fg(metric.color, metric.label);
      lastGroup = metric.group;
    }
    return row;
  };
  for (const metric of ranked) {
    selected.add(metric);
    if (visibleWidth(compose()) > width) selected.delete(metric);
  }
  return compose();
}

export function renderCodemodeCompactResult(
  result: AgentToolResult<any>,
  theme: Theme,
  context: RenderContext,
  options: ToolRenderResultOptions,
): Component {
  const status = options.isPartial ? "… 运行中" : context.isError ? "✗ 失败" : "✓ 已完成";
  const stateColor = options.isPartial ? "warning" : context.isError ? "error" : "success";
  const rawCalls: unknown = result.details?.calls;
  const calls: readonly unknown[] = Array.isArray(rawCalls) ? rawCalls : [];
  const statuses = { ok: 0, error: 0, cancelled: 0, running: 0 };
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const state: unknown = (call as { status?: unknown }).status;
    if (state === "ok" || state === "error" || state === "cancelled" || state === "running") {
      statuses[state]++;
    }
  }
  const metrics: Metric[] = [];
  if (calls.length > 0) metrics.push({ label: `${calls.length} 次调用`, color: "text", group: "calls", priority: 1 });
  if (statuses.ok) metrics.push({ label: `${statuses.ok} 成功`, color: "success", group: "calls", priority: 5 });
  if (statuses.error) metrics.push({ label: `${statuses.error} 失败`, color: "error", group: "calls", priority: 2 });
  if (statuses.cancelled) metrics.push({ label: `${statuses.cancelled} 取消`, color: "muted", group: "calls", priority: 3 });
  if (statuses.running) metrics.push({ label: `${statuses.running} 进行中`, color: "warning", group: "calls", priority: 3 });
  if (!options.isPartial) {
    const { lines, images } = countContent(result);
    if (lines) metrics.push({ label: `${lines} 行输出`, color: "muted", group: "output", priority: 6 });
    if (images) metrics.push({ label: `${images} 张图片`, color: "muted", group: "output", priority: 7 });
  }
  const duration = formatDuration(context.durationMs);
  if (duration) metrics.push({ label: duration, color: "muted", group: "output", priority: 4 });

  // All necessary data is captured by the component, with only width varying on render.
  return {
    render(width: number): string[] {
      return width > 0 ? [formatSummary(theme, status, stateColor, metrics, width)] : [];
    },
    invalidate() {},
  };
}
