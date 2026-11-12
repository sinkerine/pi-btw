#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REVISION = "374465f0a2bd3df502c4f981405e61567d92046b";
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const output = resolve(
  option("--out", join(ROOT, "artifacts/cache-report.md")),
);
const baseline = resolve(
  option("--baseline", join(ROOT, ".fixtures/dbachelder-pi-btw-374465f")),
);
const sourceAgentDir = resolve(
  option(
    "--agent-dir",
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
  ),
);
const binary = process.env.PI_BINARY ?? "pi";
const checksum = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const fixture = await mkdtemp(join(tmpdir(), "pi-btw-cache-"));
const samples = [];
const failures = [];
const processes = [];
const started = new Date().toISOString();
const context = Array.from(
  { length: 900 },
  (_, index) =>
    `Public synthetic record ${index}: river pebble orchard violet compass library. No private data is present.`,
).join("\n");
const seed = `Read this public fixture. Remember sentinel PEBBLE-ORCHARD-42 and answer READY only. Do not call tools.\n${context}`;
let metadata = { provider: "unknown", model: "unknown", api: "unknown" };
let baselineArchiveSha256 = "unknown";
let settingsDigest = "unknown";
let version = "unknown";
let stage = "initialization";
function redact(error) {
  // Errors can contain an upstream URL/query or echoed authorization material. Keep bounded provider diagnostics.
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|key-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[provider URL]")
    .slice(0, 600);
}
async function wait(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = read();
    if (found !== undefined) return found;
    await setTimeout(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function prepare(name) {
  const directory = join(fixture, name);
  await mkdir(directory, { mode: 0o700 });
  const settings = JSON.parse(
    await readFile(join(sourceAgentDir, "settings.json"), "utf8"),
  );
  const selected = Object.fromEntries(
    [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "transport",
      "thinkingBudgets",
      "enableInstallTelemetry",
      "retry",
      "httpIdleTimeoutMs",
    ]
      .filter((key) => settings[key] !== undefined)
      .map((key) => [key, settings[key]]),
  );
  settingsDigest = checksum(selected);
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({
      ...selected,
      packages: [],
      extensions: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
    { mode: 0o600 },
  );
  await copyFile(
    join(sourceAgentDir, "models.json"),
    join(directory, "models.json"),
  );
  await copyFile(
    join(sourceAgentDir, "auth.json"),
    join(directory, "auth.json"),
  );
  return directory;
}
async function start(directory, extension, sessionFile) {
  const records = [];
  const events = [];
  const notifications = [];
  const bridge = join(directory, "measurement-bridge.ts");
  await writeFile(
    bridge,
    `export default function(pi) { let ctx; pi.on("session_start", (_e,c) => {ctx=c;}); pi.events.on("pi-btw:thread", e => ctx?.ui.notify("MEASURE_BTW " + JSON.stringify(e), "info")); }`,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("PI_")) delete env[key];
  env.PI_CODING_AGENT_DIR = directory;
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    extension,
    "-e",
    bridge,
    "--session-dir",
    join(directory, "sessions"),
  ];
  if (sessionFile) args.push("--session", sessionFile);
  const child = spawn(binary, args, {
    cwd: join(fixture, "work"),
    env,
    stdio: "pipe",
  });
  processes.push(child);
  let partial = "";
  child.stdout.on("data", (chunk) => {
    partial += chunk.toString();
    let index = partial.indexOf("\n");
    while (index !== -1) {
      const line = partial.slice(0, index);
      partial = partial.slice(index + 1);
      try {
        const record = JSON.parse(line);
        records.push({ ...record, receivedAt: performance.now() });
        if (
          record.type === "extension_ui_request" &&
          record.method === "notify"
        ) {
          if (record.message.startsWith("MEASURE_BTW "))
            events.push(JSON.parse(record.message.slice(12)));
          else notifications.push(record.message);
        }
      } catch {
        /* The bounded report records protocol failures through request deadlines. */
      }
      index = partial.indexOf("\n");
    }
  });
  child.stderr.on("data", () => {}); // Never copy provider startup diagnostics or credentials into artifacts.
  let sequence = 0;
  async function rpc(type, fields = {}) {
    const id = `measure-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const result = await wait(
      () =>
        records.find(
          (record) => record.type === "response" && record.id === id,
        ),
      type,
    );
    if (!result.success) throw new Error(result.error ?? `${type} failed`);
    return result;
  }
  async function parent(question, label) {
    const before = records.length;
    const startAt = performance.now();
    await rpc("prompt", { message: question });
    await wait(
      () =>
        records.slice(before).find((record) => record.type === "agent_settled"),
      label,
    );
    const slice = records.slice(before);
    const final = slice.findLast(
      (record) =>
        record.type === "message_end" && record.message?.role === "assistant",
    )?.message;
    if (
      !final ||
      final.stopReason === "error" ||
      final.stopReason === "aborted"
    )
      throw new Error(
        final?.errorMessage ??
          "Parent returned no successful assistant response",
      );
    metadata = { provider: final.provider, model: final.model, api: final.api };
    const first = slice.find(
      (record) =>
        record.type === "message_update" &&
        record.assistantMessageEvent?.type === "text_delta",
    );
    samples.push({
      label,
      usage: final.usage ?? null,
      elapsedMs: Math.round(performance.now() - startAt),
      firstTokenMs: first ? Math.round(first.receivedAt - startAt) : null,
      at: new Date().toISOString(),
    });
  }
  async function side(question, label, baselineMode = false) {
    const before = events.length;
    const startAt = performance.now();
    await rpc("prompt", { message: `/btw ${question}` });
    if (baselineMode) {
      const state = await rpc("get_state");
      const parentFile = state.data?.sessionFile;
      if (typeof parentFile !== "string")
        throw new Error(
          "Baseline runtime did not expose its persistent session file",
        );
      const lines = (await readFile(parentFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const result = lines.findLast(
        (line) =>
          line.type === "custom" && line.customType === "btw-thread-entry",
      );
      if (!result)
        throw new Error(
          notifications.at(-1) ?? "Baseline produced no persisted usage entry",
        );
      samples.push({
        label,
        usage: result.data.usage ?? null,
        elapsedMs: Math.round(performance.now() - startAt),
        firstTokenMs: null,
        at: new Date().toISOString(),
      });
      return;
    }
    const event = await wait(
      () =>
        events
          .slice(before)
          .find(
            (event) =>
              event.type === "state" &&
              event.thread.revision > 0 &&
              ["idle", "failed", "aborted"].includes(event.thread.status),
          ),
      label,
    );
    if (event.thread.status !== "idle")
      throw new Error(event.thread.error ?? event.thread.status);
    samples.push({
      label,
      usage: event.thread.lastUsage,
      boundary: event.thread.boundary,
      cache: event.thread.cache,
      elapsedMs: Math.round(performance.now() - startAt),
      firstTokenMs: null,
      at: new Date().toISOString(),
    });
  }
  async function stop() {
    if (child.exitCode !== null) return;
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exit;
  }
  await rpc("get_commands");
  return { parent, side, stop };
}
async function findSession(directory) {
  const files = await readdir(join(directory, "sessions"), { recursive: true });
  const relative = files.find((file) => file.endsWith(".jsonl"));
  if (!relative) throw new Error("Parent session file unavailable");
  return join(directory, "sessions", relative);
}
try {
  version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  if (version !== "1.4.0")
    throw new Error(`Expected real Pi 1.4.0; received ${version}`);
  const provenance = JSON.parse(
    await readFile(join(ROOT, ".fixtures/baseline-provenance.json"), "utf8"),
  );
  if (provenance.commit !== BASELINE_REVISION)
    throw new Error("Baseline provenance revision mismatch");
  baselineArchiveSha256 = createHash("sha256")
    .update(await readFile(join(ROOT, ".fixtures/dbachelder-374465f0.tar.gz")))
    .digest("hex");
  if (baselineArchiveSha256 !== provenance.archiveSha256)
    throw new Error("Baseline archive digest mismatch");
  await mkdir(join(fixture, "work"));
  const currentDirectory = await prepare("current");
  const current = await start(
    currentDirectory,
    join(ROOT, "extensions/btw.ts"),
  );
  await current.parent(seed, "parent last request");
  const sameSession = await readFile(
    await findSession(currentDirectory),
    "utf8",
  );
  await current.side(
    "What is the sentinel? Reply with only the sentinel; do not call tools.",
    "BTW question 1",
  );
  await current.side(
    "Repeat the sentinel and explain its public fixture origin in one sentence. Do not call tools.",
    "BTW unchanged-boundary follow-up",
  );
  await current.parent(
    "The latest public sentinel is VIOLET-COMPASS-99. Reply READY only; do not call tools.",
    "parent advanced request",
  );
  await current.side(
    "What is the latest sentinel? Reply with only the sentinel; do not call tools.",
    "BTW after repin",
  );
  await current.stop();
  const baselineDirectory = await prepare("baseline");
  stage = "prepare baseline session";
  await mkdir(join(baselineDirectory, "sessions"));
  const header = JSON.parse(sameSession.split("\n")[0]);
  const baselineSession = join(
    baselineDirectory,
    "sessions",
    `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`,
  );
  await writeFile(baselineSession, sameSession, { mode: 0o600 });
  stage = "start exact baseline runtime";
  const reference = await start(
    baselineDirectory,
    join(baseline, "extensions/btw.ts"),
    baselineSession,
  );
  stage = "baseline question and persisted usage";
  await reference.side(
    "What is the sentinel? Reply with only the sentinel; do not call tools.",
    "dbachelder 0.8.1 question 1",
    true,
  );
  await reference.stop();
} catch (error) {
  failures.push(`${stage}: ${redact(error)}`);
} finally {
  for (const child of processes)
    if (child.exitCode === null) child.kill("SIGKILL");
  const parentSample = samples.find(
    (sample) => sample.label === "parent last request",
  );
  const firstSide = samples.find((sample) => sample.label === "BTW question 1");
  const followUp = samples.find(
    (sample) => sample.label === "BTW unchanged-boundary follow-up",
  );
  const baselineSample = samples.find(
    (sample) => sample.label === "dbachelder 0.8.1 question 1",
  );
  const inputSize = (sample) =>
    sample?.usage
      ? sample.usage.input + sample.usage.cacheRead + sample.usage.cacheWrite
      : null;
  const parentSize = inputSize(parentSample);
  const sideSize = inputSize(firstSide);
  const h1 = baselineSample?.usage
    ? baselineSample.usage.cacheRead === 0
      ? "supported: baseline reports zero cacheRead"
      : "inconclusive: baseline reports cacheRead, but the source of those cached tokens is unknown"
    : "inconclusive: baseline usage unavailable";
  const coverage = (priorTotal, next) =>
    priorTotal !== null && next?.usage
      ? `cacheRead ${next.usage.cacheRead} versus prior total input ${priorTotal} (= uncached input + cacheRead + cacheWrite), difference ${next.usage.cacheRead - priorTotal}; ${next.usage.cacheRead >= priorTotal ? "reported count covers the prior input size, consistent with reuse; token provenance/routing remains unobservable" : "partial cache reuse observed; strict full-prefix coverage is not observed, and cache-block granularity/tail/routing are unknown"}`
      : "usage unavailable";
  const h2 = `inconclusive for strict parent-prefix coverage: ${coverage(parentSize, firstSide)}`;
  const h3 = `inconclusive for strict prior-BTW-prefix coverage: ${coverage(sideSize, followUp)}; see separate after-repin sample for parent advancement`;
  const hypotheses = `H1: ${h1}.\\nH2: ${h2}.\\nH3: ${h3}.\\nH4: inconclusive: provider counters do not expose upstream account/replica affinity.`;
  const rows = samples
    .map(
      (sample) =>
        `| ${sample.label} | ${sample.usage?.input ?? "unknown"} | ${sample.usage?.cacheRead ?? "unknown"} | ${sample.usage?.cacheWrite ?? "unknown"} | ${sample.usage?.output ?? "unknown"} | ${sample.firstTokenMs ?? "unknown"} | ${sample.elapsedMs} |`,
    )
    .join("\n");
  const report = `# Live cache observations\n\nStarted: ${started}\nPi: ${version}\nProvider/model/API: ${metadata.provider}/${metadata.model}/${metadata.api}\nSettings digest: ${settingsDigest}\nSynthetic context SHA256: ${checksum(seed)}; UTF-8 bytes: ${Buffer.byteLength(seed)}; estimated ~${Math.ceil(seed.length / 4)} tokens (provider tokenization differs).\nBaseline: dbachelder/pi-btw 0.8.1, commit ${BASELINE_REVISION}; downloaded archive SHA256 ${baselineArchiveSha256}.\n\n| Request (execution order) | input | cacheRead | cacheWrite | output | first token ms | elapsed ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows || "| No successful request | unknown | unknown | unknown | unknown | unknown | unknown |"}\n\n${failures.length ? `Provider/fixture failure: ${failures.join("; ")}\n\n` : ""}${hypotheses.replaceAll("\\n", "\n")}\n\nCounters alone do not identify upstream account/replica routing or establish causality; assess each recorded sample rather than treating a miss as a serialization failure.\n\nUsage source: Pi-normalized usage counters. Raw provider usage-field availability is unknown; a normalized zero alone does not prove the provider explicitly reported zero or establish a cache miss. Retention option: short (the isolated measurement clears inherited PI_* values and sets no PI_CACHE_RETENTION override). Provider TTL/account/replica routing: unknown; no auth probes were performed. Parent and baseline use the same captured parent session identity, equivalent context, model and cwd in separate disposable agent directories. Baseline runs after the current extension and may be affected by elapsed time, cache eviction and shared routing. No warming timer runs. Child first-token time is unknown because contract v1 streams completion/state, not token timestamps. Unknown counters are never converted to zero. Parent output is not interpreted as cache proof. Only synthetic public context was submitted; credentials/config were copied privately into the temporary fixture and removed afterward.\n\nRaw public measurement samples:\n\n\`\`\`json\n${JSON.stringify(samples, null, 2)}\n\`\`\`\n`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, report, { mode: 0o600 });
  await rm(fixture, { recursive: true, force: true });
  process.stdout.write(
    `Wrote ${output}; successful samples=${samples.length}; failures=${failures.length}\n`,
  );
  if (failures.length) process.exitCode = 1;
}
