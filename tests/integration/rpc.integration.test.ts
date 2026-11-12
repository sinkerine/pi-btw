import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { httpStub, withoutCacheMarkers } from "../support/http-stub.js";
import { PiFixture, until } from "../support/pi.js";

test("busy parent continues; queued question pins when dequeued; Stop is admitted before held BTW response", async () => {
  const stub = await httpStub("openai-completions", (_capture, index) => ({
    hold: index === 1 || index === 2 || index === 4,
  }));
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await pi.start();
    await pi.parent("parent A");
    const beforeB = pi.records.length;
    await pi.prompt("parent B held");
    await until(() => stub.captures[1], "parent B request");
    await pi.prompt("/btw side while parent runs");
    const running = await pi.state("running");
    await until(() => stub.captures[2], "held BTW request");
    expect(running.boundary.parentTurnIndex).toBe(1);
    expect(JSON.stringify(stub.captures[2]?.body)).not.toContain(
      "parent B held",
    );
    await pi.prompt("/btw queued follow-up");
    stub.release(1);
    await until(
      () =>
        pi.records
          .slice(beforeB)
          .find((record) => record.type === "agent_settled"),
      "parent B completes while BTW held",
    );
    expect(
      pi.events
        .filter(
          (event) =>
            event.type === "state" && event.thread.status === "running",
        )
        .every(
          (event) =>
            event.type === "state" &&
            event.thread.boundary.parentTurnIndex === 1,
        ),
    ).toBe(true);
    const after = pi.events.length;
    stub.release(2);
    const next = await until(
      () =>
        pi.events
          .slice(after)
          .find(
            (event) =>
              event.type === "state" &&
              event.thread.status === "idle" &&
              event.thread.boundary.parentTurnIndex === 2,
          ),
      "queued request pins B",
    );
    expect(next.type).toBe("state");
    expect(JSON.stringify(stub.captures[3]?.body)).toContain("parent B held");
    expect(JSON.stringify(stub.captures[3]?.body)).toContain(
      "side while parent runs",
    );
    const beforeAbort = pi.events.length;
    await pi.prompt("/btw abort this held side answer");
    await until(() => stub.captures[4], "held abort request");
    await pi.prompt("/btw:abort");
    const aborted = await pi.state("aborted", beforeAbort);
    expect(aborted.threadId).toBe(running.threadId);
    expect(stub.captures).toHaveLength(5);
    const state = await pi.rpc("get_state");
    expect(state.data?.isStreaming).toBe(false);
    const file = aborted.sessionFile;
    if (!file) throw new Error("child file missing");
    expect(await readFile(file, "utf8")).toContain('"stopReason":"aborted"');
  } finally {
    await pi.close();
    await stub.close();
  }
});
test("inject while busy and summarize each send one follow-up; close and clear send nothing", async () => {
  const stub = await httpStub("openai-completions", (capture, index) => ({
    hold: index === 2,
    text: JSON.stringify(capture.body).includes("Summarize this BTW")
      ? "SUMMARY FOR MAIN"
      : "fixture answer",
  }));
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await pi.start();
    await pi.parent("parent A");
    await pi.prompt("/btw side explicit return");
    await pi.state();
    const before = pi.records.length;
    await pi.prompt("parent busy for injection");
    await until(() => stub.captures[2], "held parent");
    await pi.prompt("/btw:inject focus on X");
    expect(stub.captures).toHaveLength(3);
    stub.release(2);
    await until(
      () =>
        pi.records
          .slice(before)
          .find((record) => record.type === "agent_settled"),
      "parent follow-up settles",
    );
    expect(stub.captures).toHaveLength(4);
    expect(JSON.stringify(stub.captures[3]?.body)).toContain("focus on X");
    await pi.prompt("/btw:summarize concise");
    await until(() => stub.captures[5], "summary delivered to parent");
    expect(JSON.stringify(stub.captures[5]?.body)).toContain(
      "SUMMARY FOR MAIN",
    );
    await until(
      () => pi.records.findLast((record) => record.type === "agent_settled"),
      "summary parent settled",
    );
    const calls = stub.captures.length;
    await pi.prompt("/btw:clear");
    expect(stub.captures).toHaveLength(calls);
    expect(pi.events.at(-1)).toMatchObject({
      type: "closed",
      reason: "cleared",
    });
  } finally {
    await pi.close();
    await stub.close();
  }
});
test("resume restores exact snapshot and structured tool suffix; missing/corrupt snapshot refuses continuation", async () => {
  let sideRequests = 0;
  const stub = await httpStub("openai-completions", (capture) => {
    if (JSON.stringify(capture.body).includes("<btw>")) {
      sideRequests++;
      if (sideRequests === 1)
        return { tool: { name: "read", arguments: { path: "fixture.txt" } } };
    }
    return {};
  });
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await writeFile(
      join(pi.directory, "work/fixture.txt"),
      "public fixture tool output",
    );
    await pi.start();
    await pi.parent("persistent parent");
    await pi.prompt("/btw remember tools");
    const first = await pi.state();
    const sessions = await readdir(join(pi.directory, "sessions"), {
      recursive: true,
    });
    const parent = sessions.find((path) => path.endsWith(".jsonl"));
    if (!parent || !first.sessionFile)
      throw new Error("persistent files missing");
    const parentFile = join(pi.directory, "sessions", parent);
    const firstMessages = stub.captures.at(-1)?.body.messages;
    await pi.stop();
    await pi.start(parentFile);
    const restored = await pi.state();
    expect(restored).toMatchObject({
      threadId: first.threadId,
      title: first.title,
      status: "idle",
    });
    expect(restored.revision).toBeGreaterThan(first.revision);
    const afterRestore = pi.events.length;
    await pi.prompt("/btw resumed question");
    const resumed = await pi.state("idle", afterRestore);
    expect(resumed.threadId).toBe(first.threadId);
    expect(resumed.boundary.prefixDigest).toBe(first.boundary.prefixDigest);
    expect(
      stub.captures.at(-1)?.body.messages.slice(0, firstMessages?.length),
    ).toEqual(firstMessages);
    expect(JSON.stringify(stub.captures.at(-1)?.body)).toContain(
      "public fixture tool output",
    );
    await pi.stop();
    const snapshotPath = join(
      first.sessionFile,
      "..",
      `${first.boundary.prefixDigest}.json`,
    );
    await writeFile(snapshotPath, "corrupt");
    await pi.start(parentFile);
    const before = stub.captures.length;
    await pi.prompt("/btw must refuse");
    expect(stub.captures).toHaveLength(before);
    expect(
      pi.records.some(
        (record) =>
          typeof record.message === "string" &&
          record.message.includes("snapshot_unavailable"),
      ),
    ).toBe(true);
  } finally {
    await pi.close();
    await stub.close();
  }
});
test("provider failure is retryable; empty commands make no provider request; tangent has separate identity; in-memory is not resumable", async () => {
  let failed = false;
  const stub = await httpStub("openai-completions", (capture) => {
    if (!failed && JSON.stringify(capture.body).includes("fail side")) {
      failed = true;
      return { fail: true };
    }
    return {};
  });
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await pi.start(undefined, true);
    for (const command of ["/btw", "/side", "/btw:new", "/btw:tangent"])
      await pi.prompt(command);
    expect(stub.captures).toHaveLength(0);
    await pi.prompt("/btw:clear");
    await pi.parent("parent");
    await pi.prompt("/btw fail side");
    const failure = await pi.state("failed");
    expect(failure.error).toContain("fixture provider failure");
    const after = pi.events.length;
    await pi.prompt("/side retry side");
    const retry = await pi.state("idle", after);
    expect(retry.threadId).toBe(failure.threadId);
    expect(retry.resumable).toBe(false);
    expect(retry.sessionFile).toBeNull();
    const beforeTangent = pi.events.length;
    await pi.prompt("/btw:tangent independent question");
    const tangent = await pi.state("idle", beforeTangent);
    expect(tangent.mode).toBe("tangent");
    expect(tangent.cache.reason).toBe("tangent");
    expect(tangent.cache.requestSessionId).not.toBe(
      retry.cache.requestSessionId,
    );
    expect(JSON.stringify(stub.captures.at(-1)?.body)).not.toContain(
      "context-transform",
    );
  } finally {
    await pi.close();
    await stub.close();
  }
});

test("real TUI opens BTW while main streams and records latest-finished pinning without interrupting main", async () => {
  const stub = await httpStub("openai-completions", (_capture, index) => ({
    hold: index === 1 || index === 2,
  }));
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  const reportDirectory = process.env.BTW_REPORT_DIR ?? pi.directory;
  await mkdir(reportDirectory, { recursive: true });
  const recording = join(reportDirectory, "tui-busy-parent.cast");
  const eventsFile = join(pi.directory, "tui-events.jsonl");
  await writeFile(eventsFile, "");
  const bridge = join(pi.directory, "tui-bridge.ts");
  await writeFile(
    bridge,
    `import {appendFileSync} from "node:fs";
    export default function(pi) {
      function save(event){appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event)+"\\n");}
      pi.on("session_start", (_e,ctx)=>{save({type:"ready",mode:ctx.mode});ctx.ui.notify("TUI_FIXTURE_READY", "info");});
      pi.on("turn_end", e=>save({type:"parent_end",index:e.turnIndex}));
      pi.on("ui_prompt_end", e=>save({type:"overlay_closed",kind:e.kind}));
      pi.events.on("pi-btw:thread", save);
    }`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  for (const key of Object.keys(env))
    if (key.startsWith("PI_")) delete env[key];
  Object.assign(env, {
    PI_CODING_AGENT_DIR: pi.directory,
    PI_TELEMETRY: "0",
    PI_CACHE_RETENTION: "long",
  });
  const child = spawn(
    "python3",
    [
      "-u",
      resolve("tests/support/record-tui.py"),
      recording,
      process.env.PI_BINARY ?? "pi",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      resolve("extensions/btw.ts"),
      "-e",
      bridge,
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--session-dir",
      join(pi.directory, "sessions"),
    ],
    { cwd: join(pi.directory, "work"), env, stdio: "pipe" },
  );
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    stderr += error.message;
  });
  const input = (text: string) =>
    child.stdin.write(`${JSON.stringify({ text })}\n`);
  async function events() {
    return (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  async function waitEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    label: string,
    after = 0,
  ) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const event = (await events()).slice(after).find(predicate);
      if (event) return event;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(
      `${label}; terminal=${output.slice(-1500)}; stderr=${stderr}`,
    );
  }
  try {
    await until(
      () => (output.includes("TUI_FIXTURE_READY") ? true : undefined),
      `TUI ready; ${stderr}`,
    );
    input("parent A\r");
    await waitEvent(
      (event) => event.type === "parent_end",
      "TUI parent A complete",
    );
    input("parent B held\r");
    await until(() => stub.captures[1], "TUI parent B request");
    input("/btw why from parent context?\r");
    await until(() => stub.captures[2], "TUI side request while main held");
    const running = (await events()).find(
      (event) => event.type === "state" && event.thread.status === "running",
    );
    expect(running?.thread.boundary.parentTurnIndex).toBe(1);
    expect(JSON.stringify(stub.captures[2]?.body)).not.toContain(
      "parent B held",
    );
    const beforeMainCompletion = (await events()).length;
    stub.release(1);
    await waitEvent(
      (event) => event.type === "parent_end",
      "TUI main completes",
      beforeMainCompletion,
    );
    await until(
      () => (output.includes("pinned turn 1") ? true : undefined),
      "TUI overlay displays its pin",
    );
    stub.release(2);
    await waitEvent(
      (event) =>
        event.type === "state" &&
        typeof event.thread === "object" &&
        event.thread !== null &&
        "status" in event.thread &&
        event.thread.status === "idle" &&
        "revision" in event.thread &&
        Number(event.thread.revision) > 0,
      "TUI side completes",
    );
    input("\u001b");
    await waitEvent(
      (event) => event.type === "overlay_closed",
      "TUI overlay dismisses and restores main focus",
    );
    input("/btw next finished parent turn\r");
    await until(() => stub.captures[3], "TUI follow-up request");
    const latest = await waitEvent(
      (event) =>
        event.type === "state" &&
        typeof event.thread === "object" &&
        event.thread !== null &&
        "boundary" in event.thread &&
        typeof event.thread.boundary === "object" &&
        event.thread.boundary !== null &&
        "parentTurnIndex" in event.thread.boundary &&
        event.thread.boundary.parentTurnIndex === 2,
      "TUI repins to completed B",
    );
    expect(latest.type).toBe("state");
    expect(JSON.stringify(stub.captures[3]?.body)).toContain("parent B held");
    expect(stderr).toBe("");
    expect((await readFile(recording, "utf8")).split("\n")[0]).toContain(
      '"version": 2',
    );
    if (process.env.BTW_REPORT_DIR)
      await writeFile(
        join(reportDirectory, "tui-events.json"),
        JSON.stringify(await events(), null, 2),
      );
  } finally {
    if (process.env.BTW_REPORT_DIR)
      await writeFile(
        join(reportDirectory, "tui-events.json"),
        JSON.stringify(await events(), null, 2),
      );
    const stopped = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write('{"stop":true}\n');
      await stopped;
    }
    await pi.close();
    await stub.close();
  }
});

test("hard process crash preserves one partial answer as aborted without replay and leaves parent context isolated", async () => {
  const partialText = "PARTIAL_SIDE_ANSWER retained exactly once";
  const stub = await httpStub("openai-completions", (_capture, index) =>
    index === 1
      ? {
          textChunks: ["PARTIAL_SIDE_ANSWER retained", " exactly once"],
          pauseAfterContent: true,
        }
      : {},
  );
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await pi.start();
    await pi.parent("parent before side crash");
    const parentState = await pi.rpc("get_state");
    const parentFile = parentState.data?.sessionFile;
    if (typeof parentFile !== "string") throw new Error("parent file missing");
    await pi.prompt("/btw hold interrupted side request");
    const running = await pi.state("running");
    if (!running.sessionFile) throw new Error("persistent child missing");
    const partialFile = join(running.sessionFile, "..", "partial.json");
    await until(
      () =>
        existsSync(partialFile) &&
        readFileSync(partialFile, "utf8").includes(partialText)
          ? true
          : undefined,
      "durable partial checkpoint before hard crash",
    );
    expect((await pi.rpc("get_state")).data?.isStreaming).toBe(false);
    expect(stub.captures).toHaveLength(2);
    await pi.stop("SIGKILL");
    await pi.start(parentFile);
    const restored = await pi.state("aborted");
    expect(restored).toMatchObject({
      threadId: running.threadId,
      boundary: running.boundary,
      error: expect.stringContaining("interrupted"),
    });
    expect(stub.captures).toHaveLength(2);
    const entries = (await readFile(running.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const answers = entries.filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    expect(answers).toHaveLength(1);
    expect(answers[0].message).toMatchObject({
      stopReason: "aborted",
      content: [{ type: "text", text: partialText }],
    });
    expect(existsSync(partialFile)).toBe(false);
    const afterRestore = pi.events.length;
    await pi.prompt("/btw explicit question after crash");
    await pi.state("idle", afterRestore);
    expect(stub.captures).toHaveLength(3);
    expect(JSON.stringify(stub.captures[2]?.body.messages.at(-1))).toContain(
      "explicit question after crash",
    );
    const recoveredEntries = (await readFile(running.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      recoveredEntries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message).includes(partialText),
      ),
    ).toHaveLength(1);
    await pi.parent("parent after side recovery");
    expect(JSON.stringify(stub.captures[3]?.body)).not.toContain(partialText);
    expect(JSON.stringify(stub.captures[3]?.body)).not.toContain(
      "hold interrupted side request",
    );
    if (process.env.BTW_REPORT_DIR)
      await writeFile(
        join(process.env.BTW_REPORT_DIR, "hard-crash-report.json"),
        JSON.stringify(
          {
            piVersion: "1.4.0",
            signal: "SIGKILL",
            partialPreservedExactlyOnce: true,
            noAutomaticProviderReplay: true,
            explicitNextQuestionWorks: true,
            parentContextIsolated: true,
            threadId: restored.threadId,
            boundary: restored.boundary,
            checkpointCadenceMs: 250,
          },
          null,
          2,
        ),
      );
  } finally {
    await pi.close();
    await stub.close();
  }
});

for (const api of ["openai-completions", "anthropic-messages"] as const) {
  test(`${api}: hard crash during streamed tool call preserves recovery pair but sends no orphan result or replay`, async () => {
    const stub = await httpStub(api, (_capture, index) =>
      index === 1
        ? {
            tool: {
              name: "write",
              arguments: {
                path: "crash-protected.txt",
                content: "forbidden crash mutation",
              },
            },
            pauseAfterContent: true,
          }
        : {},
    );
    const pi = await PiFixture.create(stub.baseUrl, api);
    try {
      const protectedFile = join(pi.directory, "work/crash-protected.txt");
      await writeFile(protectedFile, "original");
      await pi.start();
      await pi.parent("parent before tool-call crash");
      const parent = stub.captures[0];
      const parentFile = (await pi.rpc("get_state")).data?.sessionFile;
      if (typeof parentFile !== "string" || !parent)
        throw new Error("persistent parent capture missing");
      await pi.prompt("/btw stream a tool call before interruption");
      const running = await pi.state("running");
      if (!running.sessionFile) throw new Error("child file missing");
      const partialFile = join(running.sessionFile, "..", "partial.json");
      await until(
        () =>
          existsSync(partialFile) &&
          readFileSync(partialFile, "utf8").includes("forbidden crash mutation")
            ? true
            : undefined,
        "checkpoint complete structured streamed tool call",
      );
      expect(await readFile(protectedFile, "utf8")).toBe("original");
      await pi.stop("SIGKILL");
      await pi.start(parentFile);
      const restored = await pi.state("aborted");
      expect(restored.threadId).toBe(running.threadId);
      expect(stub.captures).toHaveLength(2);
      const entries = (await readFile(running.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const calls = entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some(
            (part: { type: string; id?: string }) =>
              part.type === "toolCall" && part.id === "call_fixture",
          ),
      );
      const results = entries.filter(
        (entry) =>
          entry.type === "message" && entry.message.role === "toolResult",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].message.stopReason).toBe("aborted");
      expect(results).toHaveLength(1);
      expect(results[0].message).toMatchObject({
        toolCallId: "call_fixture",
        isError: true,
      });
      const afterRestore = pi.events.length;
      await pi.prompt("/btw explicit continuation after interrupted tool");
      await pi.state("idle", afterRestore);
      expect(stub.captures).toHaveLength(3);
      const continued = stub.captures[2];
      if (!continued) throw new Error("continued request missing");
      expect(
        withoutCacheMarkers(
          continued.body.messages.slice(0, parent.body.messages.length),
        ),
      ).toEqual(withoutCacheMarkers(parent.body.messages));
      expect(continued.body.tools).toEqual(parent.body.tools);
      expect(continued.body.system).toEqual(parent.body.system);
      expect(continued.body.prompt_cache_key).toEqual(
        parent.body.prompt_cache_key,
      );
      expect(continued.headers["x-session-affinity"]).toEqual(
        parent.headers["x-session-affinity"],
      );
      expect(JSON.stringify(continued.body.messages)).not.toContain(
        "call_fixture",
      );
      expect(JSON.stringify(continued.body.messages)).not.toContain(
        "forbidden crash mutation",
      );
      expect(JSON.stringify(continued.body.messages)).not.toContain(
        '"role":"tool"',
      );
      expect(JSON.stringify(continued.body.messages)).not.toContain(
        '"type":"tool_result"',
      );
      expect(await readFile(protectedFile, "utf8")).toBe("original");
      const completed = (await readFile(running.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        completed.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "aborted",
        ),
      ).toHaveLength(1);
      if (process.env.BTW_REPORT_DIR)
        await writeFile(
          join(process.env.BTW_REPORT_DIR, `hard-crash-tool-${api}.json`),
          JSON.stringify(
            {
              api,
              piVersion: "1.4.0",
              signal: "SIGKILL",
              parentPrefixUnchanged: true,
              persistedInterruptedAssistantExactlyOnce: true,
              missingToolResultsClosedExactlyOnce: true,
              noOrphanProviderResult: true,
              noAutomaticReplay: true,
              protectedFileUnchanged: true,
              explicitContinuationWorks: true,
              boundary: restored.boundary,
            },
            null,
            2,
          ),
        );
    } finally {
      await pi.close();
      await stub.close();
    }
  });
}
