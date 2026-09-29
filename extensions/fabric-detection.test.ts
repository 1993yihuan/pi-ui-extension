import assert from "node:assert/strict";
import test from "node:test";
import { isFabricFullCodeMode } from "./fabric-detection.ts";

test("detects Fabric full code mode from the active tool set", () => {
  assert.equal(isFabricFullCodeMode(["fabric_exec", "ask_user_question"]), true);
});

test("does not treat Fabric orchestration-only mode as full code mode", () => {
  assert.equal(isFabricFullCodeMode(["fabric_exec", "read", "bash"]), false);
});

test("does not treat native Pi tools as Fabric full code mode", () => {
  assert.equal(isFabricFullCodeMode(["read", "bash", "edit"]), false);
});
