import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type DeleteSessionResult =
  | { readonly ok: true; readonly method: "trash" }
  | { readonly ok: false; readonly error: string };

/** Only use recoverable deletion. A trash failure must never trigger permanent deletion. */
export async function deleteSessionFile(pi: ExtensionAPI, path: string): Promise<DeleteSessionResult> {
  try {
    const result = await pi.exec("trash", [path], { timeout: 10_000 });
    if (result.code === 0) return { ok: true, method: "trash" };
    const hint = result.stderr.trim().split(/\r?\n/, 1)[0];
    return { ok: false, error: hint || `trash exited with code ${result.code}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
