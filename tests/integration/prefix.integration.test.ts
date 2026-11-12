import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { digest } from "../../src/digest.js";
import {
  type Capture,
  httpStub,
  withoutCacheMarkers,
} from "../support/http-stub.js";
import { PiFixture, until } from "../support/pi.js";

function assertPrefix(parent: Capture, child: Capture, api: string): void {
  expect(child.body.model).toBe(parent.body.model);
  expect(child.body.tools).toEqual(parent.body.tools);
  expect(child.body.system).toEqual(parent.body.system);
  expect(child.body.prompt_cache_key).toBe(parent.body.prompt_cache_key);
  for (const header of [
    "session_id",
    "x-session-affinity",
    "x-client-request-id",
    "user-agent",
    "x-title",
    "http-referer",
  ])
    expect(child.headers[header], header).toEqual(parent.headers[header]);
  expect(
    withoutCacheMarkers(
      child.body.messages.slice(0, parent.body.messages.length),
    ),
  ).toEqual(withoutCacheMarkers(parent.body.messages));
  expect(child.body.messages[parent.body.messages.length]?.role).toBe(
    "assistant",
  );
  expect(JSON.stringify(child.body.messages.at(-1))).toContain("<btw>");
  expect(child.body.max_tokens).toEqual(parent.body.max_tokens);
  expect(child.body.reasoning_effort).toEqual(parent.body.reasoning_effort);
  expect(child.body.thinking).toEqual(parent.body.thinking);
  expect(child.headers["x-session-affinity"]).toBeTypeOf("string");
  if (api === "openai-completions") {
    expect(child.headers.session_id).toBeTypeOf("string");
    expect(parent.body.prompt_cache_key).toBeTypeOf("string");
  } else {
    expect(child.headers.session_id).toBeUndefined();
    expect(JSON.stringify(parent.body)).toContain("cache_control");
  }
}
for (const api of ["openai-completions", "anthropic-messages"] as const) {
  test(`${api}: G0 exact final provider prefix/tools/options with real Pi; same boundary, repin, parent unchanged, blocked write`, async () => {
    expect(
      execFileSync(process.env.PI_BINARY ?? "pi", ["--version"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("1.4.0");
    let btwCalls = 0;
    const stub = await httpStub(api, (capture) => {
      const serialized = JSON.stringify(capture.body.messages);
      if (serialized.includes("<btw>")) {
        btwCalls++;
        if (btwCalls === 3)
          return {
            tool: {
              name: "write",
              arguments: { path: "protected.txt", content: "changed" },
            },
          };
      }
      return {};
    });
    const pi = await PiFixture.create(stub.baseUrl, api);
    try {
      await writeFile(join(pi.directory, "work/protected.txt"), "original");
      await pi.start();
      await pi.rpc("set_thinking_level", { level: "high" });
      await pi.parent("parent boundary A");
      expect(stub.captures).toHaveLength(1);
      await pi.prompt("/btw first side question");
      const first = await pi.state();
      expect(first.boundary.parentTurnIndex).toBe(1);
      expect(stub.captures).toHaveLength(2);
      const parent = stub.captures[0];
      const child = stub.captures[1];
      if (!parent || !child) throw new Error("Missing HTTP capture");
      assertPrefix(parent, child, api);
      expect(JSON.stringify(parent.body.messages)).toContain(
        "context-transform",
      );
      const after = pi.events.length;
      await pi.prompt("/btw follow-up same boundary");
      const follow = await pi.state("idle", after);
      expect(follow.boundary.prefixDigest).toBe(first.boundary.prefixDigest);
      expect(
        withoutCacheMarkers(
          stub.captures[2]?.body.messages.slice(0, child.body.messages.length),
        ),
      ).toEqual(withoutCacheMarkers(child.body.messages));
      await pi.parent("parent boundary B");
      const parentB = stub.captures[3];
      expect(JSON.stringify(parentB?.body)).not.toContain("side question");
      const beforeRebase = pi.events.length;
      await pi.prompt("/btw after parent advancement");
      const rebased = await pi.state("idle", beforeRebase);
      expect(rebased.boundary.parentTurnIndex).toBe(2);
      expect(rebased.boundary.prefixDigest).not.toBe(
        first.boundary.prefixDigest,
      );
      expect(JSON.stringify(stub.captures[4]?.body.messages)).toContain(
        "first side question",
      );
      expect(stub.captures[4]?.body.tools).toEqual(parentB?.body.tools);
      expect(
        await readFile(join(pi.directory, "work/protected.txt"), "utf8"),
      ).toBe("original");
      expect(JSON.stringify(stub.captures.at(-1)?.body.messages)).toContain(
        "tool_unavailable",
      );
      await until(
        () =>
          pi.events.find(
            (event) =>
              event.type === "state" && event.thread.lastUsage !== null,
          ),
        "usage",
      );
      const report = {
        api,
        piVersion: "1.4.0",
        orderedPrefixEqual: true,
        toolsEqual: true,
        systemEqual: true,
        modelEqual: true,
        cacheIdentityAndAffinityEqual: true,
        clientIdentityEqual: true,
        maxTokensEqual: true,
        thinkingOptionsEqual: true,
        thinkingLevel: "high",
        retention: "long",
        contextTransformerIncluded: true,
        anthropicCacheMarkers:
          api === "anthropic-messages"
            ? "tool/system equal; only message cache markers normalized because appended suffix moves final marker"
            : "not applicable",
        parentRequestDigest: digest(parent.body),
        childRequestDigest: digest(child.body),
        parentBoundary: first.boundary,
        rebasedBoundary: rebased.boundary,
        parentMessages: parent.body.messages.length,
        childMessages: child.body.messages.length,
      };
      const directory = process.env.BTW_REPORT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `prefix-${api}.json`),
          JSON.stringify(report, null, 2),
        );
      }
    } finally {
      await pi.close();
      await stub.close();
    }
  });
}

for (const api of ["openai-completions", "anthropic-messages"] as const) {
  test(`${api}: completed parent tool results form a coherent exact prefix while its next model turn is held`, async () => {
    const stub = await httpStub(api, (_capture, index) => {
      if (index === 0)
        return { tool: { name: "read", arguments: { path: "parent.txt" } } };
      return { hold: index === 1 };
    });
    const pi = await PiFixture.create(stub.baseUrl, api);
    try {
      await writeFile(
        join(pi.directory, "work/parent.txt"),
        "parent completed tool result",
      );
      await pi.start();
      await pi.prompt("parent question with read");
      await until(
        () => stub.captures[1],
        "parent next response held after complete tool batch",
      );
      await pi.prompt("/btw explain the completed read");
      const state = await pi.state();
      const parent = stub.captures[0];
      const child = stub.captures[2];
      if (!parent || !child) throw new Error("Missing tool-boundary captures");
      assertPrefix(parent, child, api);
      expect(JSON.stringify(child.body.messages)).toContain(
        "parent completed tool result",
      );
      expect(state.boundary.parentTurnIndex).toBe(1);
      expect((await pi.rpc("get_state")).data?.isStreaming).toBe(true);
      const beforeCompletion = pi.records.length;
      stub.release(1);
      await until(
        () =>
          pi.records
            .slice(beforeCompletion)
            .find((event) => event.type === "agent_settled"),
        "parent completes independently",
      );
      const reportDirectory = process.env.BTW_REPORT_DIR;
      if (reportDirectory)
        await writeFile(
          join(reportDirectory, `prefix-${api}-tool-results.json`),
          JSON.stringify(
            {
              api,
              piVersion: "1.4.0",
              coherentToolBoundary: true,
              orderedPrefixEqual: true,
              toolsEqual: true,
              parentRemainedRunning: true,
              boundary: state.boundary,
              parentRequestDigest: digest(parent.body),
              childRequestDigest: digest(child.body),
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

test("real Pi compaction keeps an in-flight pin immutable; next request rebases and tree switch refuses abandoned context", async () => {
  const stub = await httpStub("openai-completions", (_capture, index) => ({
    hold: index === 2,
  }));
  const pi = await PiFixture.create(stub.baseUrl, "openai-completions");
  try {
    await pi.start();
    await pi.parent(
      `old verbose public context ${"orchard river violet. ".repeat(1200)}`,
    );
    await pi.parent(
      `second parent boundary before compaction ${"retained public context. ".repeat(20)}`,
    );
    await pi.prompt("/btw held side before compaction");
    const held = await pi.state("running");
    await until(() => stub.captures[2], "held side request");
    expect(held.boundary.parentTurnIndex).toBe(2);
    await pi.rpc("compact", {
      customInstructions: "Summarize the public fixture concisely",
    });
    expect(stub.captures).toHaveLength(4);
    await pi.parent("parent compacted advancement");
    expect(stub.captures).toHaveLength(5);
    expect(JSON.stringify(stub.captures[4]?.body)).not.toContain(
      "old verbose public context",
    );
    const beforeRelease = pi.events.length;
    stub.release(2);
    const finishedHeld = await pi.state("idle", beforeRelease);
    expect(finishedHeld.boundary).toEqual(held.boundary);
    const beforeRebase = pi.events.length;
    await pi.prompt("/btw follow-up using completed compacted parent");
    const rebased = await pi.state("idle", beforeRebase);
    expect(rebased.boundary.parentTurnIndex).toBe(3);
    const parent = stub.captures[4];
    const child = stub.captures[5];
    if (!parent || !child) throw new Error("compacted captures missing");
    expect(child.body.messages.slice(0, parent.body.messages.length)).toEqual(
      parent.body.messages,
    );
    expect(child.body.tools).toEqual(parent.body.tools);
    expect(JSON.stringify(child.body)).toContain("held side before compaction");
    const state = await pi.rpc("get_state");
    const file = state.data?.sessionFile;
    if (typeof file !== "string")
      throw new Error("persistent parent path missing");
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstUser = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    if (!firstUser) throw new Error("native rewind target missing");
    await pi.prompt(`/fixture:branch ${firstUser.id}`);
    expect(pi.events.at(-1)).toMatchObject({
      type: "closed",
      threadId: rebased.threadId,
    });
    const calls = stub.captures.length;
    await pi.prompt("/btw refuse abandoned checkpoint");
    expect(stub.captures).toHaveLength(calls);
    expect(
      pi.records.some(
        (record) =>
          typeof record.message === "string" &&
          record.message.includes("no_finished_turn"),
      ),
    ).toBe(true);
    await pi.parent("finished new branch parent");
    const afterBranch = pi.events.length;
    await pi.prompt("/btw new branch side");
    const branched = await pi.state("idle", afterBranch);
    expect(branched.threadId).not.toBe(rebased.threadId);
    expect(JSON.stringify(stub.captures.at(-1)?.body)).not.toContain(
      "parent compacted advancement",
    );
    expect(JSON.stringify(stub.captures.at(-1)?.body)).not.toContain(
      "held side before compaction",
    );
  } finally {
    await pi.close();
    await stub.close();
  }
});
