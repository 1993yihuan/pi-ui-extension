const FABRIC_EXEC_TOOL = "fabric_exec";
const PI_CORE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export function isFabricFullCodeMode(activeToolNames: readonly string[]): boolean {
  return activeToolNames.includes(FABRIC_EXEC_TOOL) &&
    !activeToolNames.some((name) => PI_CORE_TOOLS.has(name));
}
