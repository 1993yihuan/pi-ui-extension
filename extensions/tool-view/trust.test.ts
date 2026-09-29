import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installToolViewController } from "./controller.ts";

test("managed bash honors trust changes and reloads project shell settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-view-trust-"));
  const tools = new Map<string, any>();
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, on() {} } as any;
  let trusted = false;
  const ctx = {
    cwd: directory,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "trust-test", getSessionFile: () => undefined },
  };
  const run = async () => {
    const result = await tools.get("bash").execute("test", { command: "echo COMMAND_MARKER", timeout: 5 }, undefined, undefined, ctx);
    return result.content.map((item: any) => item.text ?? "").join("\n");
  };
  try {
    await mkdir(join(directory, ".pi"));
    const settings = join(directory, ".pi", "settings.json");
    await writeFile(settings, JSON.stringify({ shellCommandPrefix: "echo PROJECT_PREFIX;" }));
    await installToolViewController(pi, { modeFile: join(directory, "mode.json") });
    assert.doesNotMatch(await run(), /PROJECT_PREFIX/);
    trusted = true;
    assert.match(await run(), /PROJECT_PREFIX/);
    trusted = false;
    assert.doesNotMatch(await run(), /PROJECT_PREFIX/);
    await writeFile(settings, JSON.stringify({ shellPath: join(directory, "missing-shell") }));
    assert.match(await run(), /COMMAND_MARKER/);
    trusted = true;
    await assert.rejects(run());
    await writeFile(settings, JSON.stringify({ shellCommandPrefix: "echo UPDATED_PREFIX;" }));
    assert.match(await run(), /UPDATED_PREFIX/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
