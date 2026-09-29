import assert from "node:assert/strict";
import test from "node:test";
import { mcpResourceEntriesFromStatus } from "./resources.ts";

test("builds MCP resource rows from the adapter status snapshot", () => {
  assert.deepEqual(
    mcpResourceEntriesFromStatus({
      version: 1,
      servers: [
        { name: "context7", disabled: false },
        { name: "chrome-devtools", disabled: false },
        { name: "disabled-server", disabled: true },
        { name: "context7", disabled: false },
      ],
    }),
    [
      { name: "context7", description: "MCP server loaded in the current Pi session" },
      { name: "chrome-devtools", description: "MCP server loaded in the current Pi session" },
    ],
  );
});

test("rejects malformed MCP status snapshots", () => {
  assert.deepEqual(mcpResourceEntriesFromStatus(undefined), []);
  assert.deepEqual(mcpResourceEntriesFromStatus({ version: 2, servers: [] }), []);
  assert.deepEqual(mcpResourceEntriesFromStatus({ version: 1, servers: "context7" }), []);
});
