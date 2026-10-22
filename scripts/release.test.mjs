import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXPECTED_CHECKS } from "./ci.mjs";
import {
  assertPublishedArtifact, compareVersions, ensureGithubRelease, matrixPassed,
  npmRegistryRecord, poll, publishArtifact, readArtifact, requestJson, stableVersion, verifyArtifact, waitForCI,
} from "./release.mjs";

const sha = "a".repeat(40);
const metadata = { name: "pi-ui-extension", tag: "v1.8.4", version: "1.8.4", sha, integrity: "sha512-test" };
const published = () => ({ name: metadata.name, version: metadata.version, gitHead: sha, dist: { integrity: metadata.integrity } });
const jobs = () => EXPECTED_CHECKS.map(name => ({ name, status: "completed", conclusion: "success" }));
const run = overrides => ({ id: 10, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", ...overrides });
function clock(timeoutMs = 100) {
  let time = 0;
  return { timeoutMs, intervalMs: 10, now: () => time, delay: async ms => { time += ms; }, log: () => {} };
}

test("release tags accept only stable canonical versions and compare numerically", () => {
  assert.equal(stableVersion("v1.8.4"), "1.8.4");
  for (const tag of [undefined, "1.8.4", "v01.8.4", "v1.8.4-rc.1", "v1.8.4+build", "v1.8.4/path"]) assert.throws(() => stableVersion(tag));
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.8.4", "1.8.4"), 0);
  assert.equal(compareVersions("1.8.4", "2.0.0"), -1);
});

test("HTTP reads distinguish absent packages from authentication and server failures", async () => {
  const request = (status, options = {}) => requestJson("https://registry.npmjs.org/example", {
    ...options, fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(status === 200 ? '{"version":"1.0.0"}' : "", { status });
    },
  });
  assert.equal(await request(404), undefined);
  assert.deepEqual(await request(200), { version: "1.0.0" });
  for (const status of [401, 403]) await assert.rejects(request(status), error => !error.retryable && error.message.includes(String(status)));
  for (const status of [429, 500, 503]) await assert.rejects(request(status), error => error.retryable);
  await assert.rejects(request(404, { method: "POST", body: {} }), error => !error.retryable);
  await assert.rejects(requestJson("https://registry.npmjs.org/example", { fetchImpl: async () => { throw Error("network down"); } }), error => error.retryable);
  await assert.rejects(requestJson("https://registry.npmjs.org/example", { fetchImpl: async () => new Response("invalid JSON") }), error => error.retryable);
});

test("npm CLI registry reads distinguish absent packages, auth errors, and valid metadata", () => {
  let args;
  const record = npmRegistryRecord("1.9.2", { run: (cmd, argv) => {
    assert.equal(cmd, "npm");
    args = argv;
    return JSON.stringify({ name: "pi-ui-extension", version: "1.9.2" });
  } });
  assert.equal(record.version, "1.9.2");
  assert.ok(args.includes("--prefer-online"));
  assert.ok(args.includes("--fetch-retries=0"));
  assert.equal(npmRegistryRecord("1.9.2", { run: () => { throw Object.assign(Error(), { status: 1, stderr: "npm error code E404" }); } }), undefined);
  assert.throws(() => npmRegistryRecord("1.9.2", { run: () => { throw Object.assign(Error(), { status: 1, stderr: "npm error code E401" }); } }), error => !error.retryable);
  assert.throws(() => npmRegistryRecord("1.9.2", { run: () => { throw Error("timeout"); } }), error => error.retryable);
  assert.throws(() => npmRegistryRecord("1.9.2", { run: () => JSON.stringify({ name: "wrong", version: "1.9.2" }) }), error => error.retryable);
});

test("polling handles indexing delays and temporary HTTP failures within one deadline", async () => {
  const responses = [undefined, Object.assign(Error("HTTP 503"), { retryable: true }), "visible"];
  assert.equal(await poll(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }, clock()), "visible");
  const budgets = [];
  await assert.rejects(poll(async remaining => { budgets.push(remaining); }, clock(25)), /Timed out/);
  assert.deepEqual(budgets, [25, 15, 5]);
  let calls = 0;
  await assert.rejects(poll(async () => { calls++; throw Error("HTTP 403"); }, clock()), /403/);
  assert.equal(calls, 1, "permission failures must not retry for ten minutes");
});

test("HTTP time consumes the polling deadline as well as sleeps", async () => {
  let time = 0;
  const budgets = [];
  await assert.rejects(poll(async remaining => { budgets.push(remaining); time += 7; }, {
    timeoutMs: 25, intervalMs: 10, now: () => time, delay: async ms => { time += ms; }, log: () => {},
  }), /Timed out/);
  assert.deepEqual(budgets, [25, 8]);
  assert.equal(time, 25);
});

test("release gate requires every exact Node/Pi matrix job to succeed", () => {
  assert.equal(matrixPassed(jobs()), true);
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral"]) {
    const incomplete = jobs();
    incomplete[0].conclusion = conclusion;
    assert.equal(matrixPassed(incomplete), false);
  }
  assert.equal(matrixPassed(jobs().slice(1)), false);
});

test("CI gate waits for the exact main push SHA instead of accepting another successful run", async () => {
  let attempts = 0;
  const paths = [];
  const api = async path => {
    paths.push(path);
    if (path.includes("/jobs?")) return { jobs: jobs() };
    attempts++;
    return { workflow_runs: [run({ id: 20, head_sha: "b".repeat(40) }), run({ id: 30, event: "pull_request" }), run({ status: attempts === 1 ? "in_progress" : "completed" })] };
  };
  assert.equal(await waitForCI(api, sha, clock()), 10);
  assert.equal(attempts, 2);
  assert.ok(paths[0].includes(`head_sha=${sha}&branch=main&event=push`));
  assert.ok(paths.at(-1).includes("runs/10/jobs"));
});

test("CI gate rejects failed latest runs and docs-only successful runs", async () => {
  for (const conclusion of ["failure", "cancelled"]) {
    await assert.rejects(waitForCI(async () => ({ workflow_runs: [run({ id: 9 }), run({ conclusion })] }), sha, clock()), /did not succeed/);
  }
  await assert.rejects(waitForCI(async path => path.includes("/jobs?") ? { jobs: [{ name: "docs", status: "completed", conclusion: "success" }] } : { workflow_runs: [run()] }, sha, clock()),
    new RegExp(`all ${EXPECTED_CHECKS.length} Node/Pi checks`));
});

test("CI gate paginates jobs rather than trusting only the first hundred", async () => {
  const api = async path => {
    if (!path.includes("/jobs?")) return { workflow_runs: [run()] };
    return { jobs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ name: "unrelated" })) : jobs() };
  };
  assert.equal(await waitForCI(api, sha, clock()), 10);
});

test("existing npm versions must match both source SHA and tarball integrity", () => {
  assert.doesNotThrow(() => assertPublishedArtifact(published(), metadata));
  for (const change of [{ gitHead: "b".repeat(40) }, { dist: { integrity: "sha512-other" } }, { version: "1.8.3" }, { name: "another-package" }]) {
    assert.throws(() => assertPublishedArtifact({ ...published(), ...change }, metadata), /differs/);
  }
});

test("an identical existing version recovers without publishing or moving latest", async () => {
  const forbidden = () => { throw Error("must not run"); };
  assert.equal(await publishArtifact(metadata, { lookup: async () => published(), latest: forbidden, publish: forbidden }), "already-published");
  await assert.rejects(publishArtifact(metadata, { lookup: async () => ({ ...published(), gitHead: "b".repeat(40) }), publish: forbidden }), /differs/);
});

test("new publication requires a matching tag event and cannot move latest backwards", async () => {
  let calls = 0;
  const options = { lookup: async () => undefined, latest: async () => ({ version: "1.8.3" }), publish: async () => { calls++; }, ref: `refs/tags/${metadata.tag}`, sha };
  for (const change of [{ ref: "refs/heads/main" }, { sha: "b".repeat(40) }]) await assert.rejects(publishArtifact(metadata, { ...options, ...change }), /matching tag/);
  await assert.rejects(publishArtifact(metadata, { ...options, latest: async () => ({ version: "1.9.0" }) }), /backwards/);
  assert.equal(calls, 0);
  assert.equal(await publishArtifact(metadata, options), "published");
  assert.equal(calls, 1);
});

test("verified manual dispatch can publish only with explicit opt-in", async () => {
  let uploads = 0;
  const options = { lookup: async () => undefined, latest: async () => undefined,
    ref: "refs/heads/main", sha: "b".repeat(40), publish: async () => { uploads++; } };
  await assert.rejects(publishArtifact(metadata, options), /matching tag/);
  assert.equal(uploads, 0);
  assert.equal(await publishArtifact(metadata, { ...options, manualDispatch: true }), "published");
  assert.equal(uploads, 1);
});

test("an uncertain npm upload failure is never automatically retried", async () => {
  let calls = 0;
  await assert.rejects(publishArtifact(metadata, {
    lookup: async () => undefined, latest: async () => undefined,
    ref: `refs/tags/${metadata.tag}`, sha,
    publish: async () => { calls++; throw Error("connection lost after upload"); },
  }), /connection lost/);
  assert.equal(calls, 1);
});

test("verification waits for both version and latest indexing, but rejects a different artifact immediately", async () => {
  let versionReads = 0, latestReads = 0;
  const result = await verifyArtifact(metadata, async () => ++versionReads === 1 ? undefined : published(), {
    ...clock(), readLatest: async () => ++latestReads === 1 ? { version: "1.8.3" } : { version: "1.8.4" },
  });
  assert.equal(result.latest.version, "1.8.4");
  assert.equal(versionReads, 3);
  let mismatchReads = 0;
  await assert.rejects(verifyArtifact(metadata, async () => { mismatchReads++; return { ...published(), gitHead: "b".repeat(40) }; }, clock()), /differs/);
  assert.equal(mismatchReads, 1);
});

test("artifact handoff rejects tampered bytes and substituted metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-release-test-"));
  try {
    const bytes = Buffer.from("validated tarball");
    const record = { ...metadata, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const expected = { tag: record.tag, sha: record.sha, expectedIntegrity: record.integrity };
    writeFileSync(join(directory, "release.json"), JSON.stringify(record));
    writeFileSync(join(directory, "package.tgz"), bytes);
    assert.deepEqual(readArtifact(directory, expected), record);
    assert.throws(() => readArtifact(directory, { ...expected, sha: "b".repeat(40) }), /changed/);
    writeFileSync(join(directory, "package.tgz"), "tampered");
    assert.throws(() => readArtifact(directory, expected), /changed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("GitHub recovery preserves existing release notes and avoids making an old version latest", async () => {
  const writes = [];
  const api = async (path, options) => {
    if (options) { writes.push({ path, ...options }); return { id: 42 }; }
    if (path.startsWith("git/ref/")) return { object: { type: "tag", sha: "b".repeat(40) } };
    if (path.startsWith("git/tags/")) return { object: { type: "commit", sha } };
    if (path === "releases/latest") return { tag_name: "v1.9.0" };
    return { id: 42, tag_name: metadata.tag, body: "Maintainer release notes" };
  };
  await ensureGithubRelease(api, metadata);
  assert.deepEqual(writes, [{ path: "releases/42", method: "PATCH", body: { draft: false, prerelease: false, make_latest: "false" } }]);
});

test("new GitHub releases bind the verified tag commit and reject moved tags", async () => {
  const writes = [];
  const api = async (path, options) => {
    if (options) { writes.push(options.body); return options.body; }
    if (path.startsWith("git/ref/")) return { object: { type: "commit", sha } };
    return undefined;
  };
  await ensureGithubRelease(api, metadata);
  assert.equal(writes[0].target_commitish, sha);
  assert.equal(writes[0].tag_name, metadata.tag);
  assert.equal(writes[0].make_latest, "true");
  await assert.rejects(ensureGithubRelease(async () => ({ object: { type: "commit", sha: "b".repeat(40) } }), metadata), /Remote release tag/);
});
