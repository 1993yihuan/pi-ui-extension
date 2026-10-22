import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { EXPECTED_CHECKS } from "./ci.mjs";
import { checkPackageFiles } from "./check-package.mjs";

const PACKAGE = "pi-ui-extension";
const REGISTRY = "https://registry.npmjs.org";
const SHA = /^[0-9a-f]{40}$/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000 }).trim();
const output = (name, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`); };
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function stableVersion(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !STABLE.test(tag.slice(1))) throw new Error("Release tag must be a stable vX.Y.Z version");
  return tag.slice(1);
}
export function compareVersions(a, b) {
  if (!STABLE.test(a) || !STABLE.test(b)) throw new Error("Expected stable package versions");
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function assertPublishedArtifact(record, metadata) {
  if (record?.name !== PACKAGE || record.version !== metadata.version ||
      record.gitHead !== metadata.sha || record.dist?.integrity !== metadata.integrity) {
    throw new Error("Published package differs from the validated commit/artifact; refusing to skip or overwrite it");
  }
}
export function matrixPassed(jobs) {
  return EXPECTED_CHECKS.every(name => jobs.some(job => job.name === name && job.status === "completed" && job.conclusion === "success"));
}

class RequestError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}
export async function requestJson(url, { token, method = "GET", body, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method, signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, timeoutMs))),
      headers: { Accept: "application/json", "Cache-Control": "no-cache", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new RequestError(`Request to ${new URL(url).host} failed or timed out`, true); }
  if (response.status === 404 && method === "GET") return undefined;
  if (!response.ok) throw new RequestError(`Request to ${new URL(url).host} failed: HTTP ${response.status}`, response.status === 429 || response.status >= 500);
  try { return await response.json(); }
  catch { throw new RequestError("Registry/API returned invalid JSON", true); }
}


/** npm CLI shares network/proxy settings with npm ci and npm publish. */
export function npmRegistryRecord(version, { run = execFileSync, timeoutMs = 20_000 } = {}) {
  if (version !== "latest" && !STABLE.test(version)) throw new Error("Invalid npm version lookup");
  const budget = Math.max(1, Math.min(20_000, timeoutMs));
  try {
    const raw = run("npm", ["view", `${PACKAGE}@${version}`, "--json", `--registry=${REGISTRY}`,
      `--fetch-timeout=${budget}`, "--fetch-retries=0", "--prefer-online"],
    { encoding: "utf8", timeout: budget + 1_000, maxBuffer: 4 * 1024 * 1024 });
    const record = JSON.parse(raw);
    if (!record || Array.isArray(record) || record.name !== PACKAGE || !STABLE.test(record.version)) {
      throw new RequestError("Registry returned invalid package metadata", true);
    }
    return record;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    const detail = String(error.stderr ?? "");
    if (error.status === 1 && /\bE404\b/.test(detail)) return undefined;
    if (/\b(?:E401|E403)\b/.test(detail)) throw new RequestError("Registry rejected npm credentials", false);
    throw new RequestError("npm registry lookup failed or timed out", true);
  }
}

/** The deadline includes HTTP time, retries and sleeps; credentials/errors never become a false 404. */
export async function poll(read, { timeoutMs = 600_000, intervalMs = 20_000, now = Date.now, delay = sleep, log = console.log } = {}) {
  const deadline = now() + timeoutMs;
  let lastError = "not visible yet";
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Timed out waiting for verification: ${lastError}. Do not republish blindly; use recovery mode.`);
    try {
      const value = await read(Math.min(20_000, remaining));
      if (value !== undefined) return value;
    } catch (error) {
      if (!error.retryable) throw error;
      lastError = error.message;
    }
    const wait = Math.min(intervalMs, deadline - now());
    if (wait <= 0) continue;
    log(`Waiting for verification (${lastError})`);
    await delay(wait);
  }
}

function githubApi(repository, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  return (path, options = {}) => requestJson(`https://api.github.com/repos/${repository}/${path}`, { token, ...options });
}
function requestBudget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RequestError("API request budget exhausted", true);
    return remaining;
  };
}
export async function waitForCI(api, sha, options = {}) {
  return poll(async timeoutMs => {
    const remaining = requestBudget(timeoutMs);
    const data = await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`, { timeoutMs: remaining() });
    const run = data?.workflow_runs?.filter(run => run.head_sha === sha && run.event === "push" && run.head_branch === "main").sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") return undefined;
    if (run.conclusion !== "success") throw new Error("The latest main CI run for the release commit did not succeed");
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const data = await api(`actions/runs/${run.id}/jobs?per_page=100&page=${page}`, { timeoutMs: remaining() });
      if (!Array.isArray(data?.jobs)) throw new Error("Cannot read release commit CI jobs");
      jobs.push(...data.jobs);
      if (data.jobs.length < 100) break;
    }
    if (!matrixPassed(jobs)) throw new Error(`Release requires all ${EXPECTED_CHECKS.length} Node/Pi checks for this exact SHA; documentation-only CI is insufficient`);
    return run.id;
  }, { intervalMs: 10_000, ...options });
}

async function prepare() {
  const tag = process.env.RELEASE_TAG, version = stableVersion(tag);
  const mode = process.env.RELEASE_MODE;
  if (!["validate", "release", "recover"].includes(mode)) throw new Error("Invalid release mode");
  const sha = git("rev-parse", `refs/tags/${tag}^{commit}`);
  if (!SHA.test(sha)) throw new Error("Invalid tag commit");
  git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  const manifest = JSON.parse(git("show", `${sha}:package.json`));
  if (manifest.name !== PACKAGE || manifest.version !== version) throw new Error("Tag and package name/version do not match");
  const ci = await waitForCI(githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN), sha);
  for (const [key, value] of Object.entries({ tag, sha, version, mode })) output(key, value);
  console.log(`Validated ${tag} at ${sha}, main CI run ${ci}, mode ${mode}`);
}

function pack() {
  const source = resolve(process.env.RELEASE_SOURCE ?? "."), directory = resolve(process.env.RELEASE_DIRECTORY);
  const sha = process.env.RELEASE_SHA, tag = process.env.RELEASE_TAG, version = stableVersion(tag);
  if (!SHA.test(sha)) throw new Error("Invalid release SHA");
  const manifestPath = join(source, "package.json"), original = readFileSync(manifestPath, "utf8"), manifest = JSON.parse(original);
  if (manifest.name !== PACKAGE || manifest.version !== version) throw new Error("Unexpected package to pack");
  if (git("-C", source, "rev-parse", "HEAD") !== sha) throw new Error("Source checkout differs from release SHA");
  mkdirSync(directory, { recursive: true });
  let result;
  try {
    // Bind registry gitHead and the tarball itself to the validated source commit.
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, gitHead: sha }, null, 2)}\n`);
    result = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: source, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }))[0];
  } finally { writeFileSync(manifestPath, original); }
  checkPackageFiles(source, result.files.map(file => file.path));
  const tarball = join(directory, "package.tgz");
  renameSync(join(directory, result.filename), tarball);
  const metadata = { name: PACKAGE, version, tag, sha, integrity: integrity(readFileSync(tarball)) };
  writeFileSync(join(directory, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  output("integrity", metadata.integrity);
  output("artifact_name", `release-${sha}-${process.env.GITHUB_RUN_ATTEMPT ?? "local"}`);
  console.log(`Packed validated artifact ${metadata.integrity}`);
}

export function readArtifact(directory, { tag, sha, expectedIntegrity } = {}) {
  const metadata = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  if (metadata.name !== PACKAGE || stableVersion(metadata.tag) !== metadata.version || !SHA.test(metadata.sha) ||
      metadata.tag !== tag || metadata.sha !== sha || metadata.integrity !== expectedIntegrity ||
      integrity(readFileSync(join(directory, "package.tgz"))) !== metadata.integrity) throw new Error("Release artifact or its metadata was changed");
  return metadata;
}

/** Never retry npm publish itself. Existing versions must match both source and bytes. */
export async function publishArtifact(metadata, { lookup, latest, publish, ref, sha, manualDispatch = false }) {
  const existing = await lookup();
  if (existing) { assertPublishedArtifact(existing, metadata); return "already-published"; }
  if (!manualDispatch && (ref !== `refs/tags/${metadata.tag}` || sha !== metadata.sha)) throw new Error("New publication must run from the matching tag or verified main dispatch; use recovery mode for an existing package");
  const current = await latest();
  if (current && compareVersions(current.version, metadata.version) > 0) throw new Error("Refusing to move npm latest backwards");
  await publish();
  return "published";
}

async function publish(metadata, directory) {
  const lookup = path => poll(timeoutMs => Promise.resolve({ record: npmRegistryRecord(path, { timeoutMs }) }), { timeoutMs: 60_000 }).then(value => value.record);
  try {
    const result = await publishArtifact(metadata, {
      lookup: () => lookup(metadata.version), latest: () => lookup("latest"),
      ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
      manualDispatch: process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        process.env.GITHUB_REF === "refs/heads/main" && process.env.RELEASE_MODE === "release" &&
        process.env.RELEASE_TAG === metadata.tag && process.env.RELEASE_SHA === metadata.sha,
      publish: () => execFileSync("npm", ["publish", join(directory, "package.tgz"), "--access", "public", "--tag", "latest", "--ignore-scripts", `--registry=${REGISTRY}`, "--fetch-timeout=120000", "--fetch-retries=0"], { stdio: "inherit", timeout: 180_000 }),
    });
    console.log(result);
  } catch (error) {
    throw new Error(`${error.message}. If npm may have accepted the upload, use recover mode; do not automatically repeat publish.`);
  }
}

export async function verifyArtifact(metadata, read, { readLatest, ...options } = {}) {
  return poll(async timeoutMs => {
    const remaining = requestBudget(timeoutMs);
    const record = await read(remaining());
    if (!record) return undefined;
    assertPublishedArtifact(record, metadata);
    if (readLatest) {
      const latest = await readLatest(remaining());
      if (!latest || compareVersions(latest.version, metadata.version) < 0) return undefined;
      return { record, latest };
    }
    return record;
  }, options);
}
export async function ensureGithubRelease(api, metadata) {
  // Recheck the remote tag immediately before modifying a Release.
  let ref = await api(`git/ref/tags/${metadata.tag}`);
  for (let depth = 0; depth < 4 && ref?.object?.type === "tag"; depth++) ref = await api(`git/tags/${ref.object.sha}`);
  if (ref?.object?.type !== "commit" || ref.object.sha !== metadata.sha) throw new Error("Remote release tag differs from the verified artifact");
  const existing = await api(`releases/tags/${metadata.tag}`);
  const latest = await api("releases/latest");
  const makeLatest = !latest || (latest.tag_name?.startsWith("v") && STABLE.test(latest.tag_name.slice(1)) && compareVersions(metadata.version, latest.tag_name.slice(1)) >= 0);
  if (existing) {
    if (existing.tag_name !== metadata.tag) throw new Error("Unexpected GitHub Release");
    return api(`releases/${existing.id}`, { method: "PATCH", body: { draft: false, prerelease: false, make_latest: String(Boolean(makeLatest)) } });
  }
  return api("releases", { method: "POST", body: { tag_name: metadata.tag, target_commitish: metadata.sha, name: metadata.tag, draft: false, prerelease: false, generate_release_notes: true, make_latest: String(Boolean(makeLatest)) } });
}

async function main(command) {
  if (command === "prepare") return prepare();
  if (command === "pack") return pack();
  const directory = resolve(process.env.RELEASE_DIRECTORY);
  const metadata = readArtifact(directory, { tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA, expectedIntegrity: process.env.RELEASE_INTEGRITY });
  if (command === "publish") return publish(metadata, directory);
  if (command === "verify") {
    const { latest } = await verifyArtifact(metadata,
      timeoutMs => Promise.resolve(npmRegistryRecord(metadata.version, { timeoutMs })),
      { readLatest: timeoutMs => Promise.resolve(npmRegistryRecord("latest", { timeoutMs })) });
    console.log(`Verified ${metadata.tag}, commit ${metadata.sha}, integrity and npm latest=${latest.version}`);
    return;
  }
  if (command === "github") return ensureGithubRelease(githubApi(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN), metadata);
  throw new Error("Usage: node scripts/release.mjs prepare|pack|publish|verify|github");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
