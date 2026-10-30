import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DeleteSessionResult =
  | { readonly ok: true; readonly method: "trash" | "recycle" }
  | { readonly ok: false; readonly error: string };

/**
 * PowerShell one-liner: the only recoverable delete Windows ships.
 * The path is embedded as a single-quoted literal, so apostrophes are doubled.
 */
function recycleScript(path: string): string {
  return `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/).filter((entry) => entry.trim().length > 0);
  return line.length > 0 ? line[0]! : "";
}

async function trashCommand(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const result = await pi.exec("trash", [path], { timeout: 10_000 });
    if (result.code === 0) return { ok: true, method: "trash" };
    return { ok: false, error: firstLine(result.stderr) || `trash exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function windowsRecycleBin(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const result = await pi.exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", recycleScript(path)],
      { timeout: 20_000 },
    );
    if (result.code === 0) return { ok: true, method: "recycle" };
    return { ok: false, error: firstLine(result.stderr) || `powershell exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Only use recoverable deletion. A trash failure must never trigger permanent deletion.
 * Windows has no `trash` CLI, so fall back to the Recycle Bin there.
 */
export async function deleteSessionFile(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  const trash = await trashCommand(pi, path);
  if (trash.ok) return trash;
  if (process.platform !== "win32") return trash;
  const recycled = await windowsRecycleBin(pi, path);
  return recycled.ok ? recycled : { ok: false, error: `trash: ${trash.error}; recycle bin: ${recycled.error}` };
}
