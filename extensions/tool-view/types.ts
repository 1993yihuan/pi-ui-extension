export const TOOL_VIEW_MODES = ["normal", "compact", "hidden"] as const;
export type ToolViewMode = (typeof TOOL_VIEW_MODES)[number];

export function isToolViewMode(value: unknown): value is ToolViewMode {
  return typeof value === "string" && TOOL_VIEW_MODES.includes(value as ToolViewMode);
}
