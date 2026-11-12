import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import {
  createCodingTools,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { BtwSnapshot } from "../../src/boundary.js";
import { digest } from "../../src/digest.js";
import { BtwStore } from "../../src/store.js";
import { BtwThread, btwToLlm } from "../../src/thread.js";
import { until } from "../support/pi.js";
import { snapshot } from "../support/snapshot.js";
import { assistant, FakeProvider, fixtureModel } from "../support/stream.js";

function pin(turn: number): BtwSnapshot {
  const value = snapshot("parent", `leaf${turn}`, turn);
  value.model = fixtureModel;
  value.messages = [
    {
      role: "system",
      content: `parent system ${turn}`,
      timestamp: 1,
      toolsAdded: createCodingTools("/tmp").map(toToolDeclaration),
    },
    { role: "user", content: `parent turn ${turn}`, timestamp: 2 },
  ];
  value.boundary.prefixDigest = digest(value.messages);
  return value;
}
function setup() {
  const sessionManager = SessionManager.inMemory("/tmp");
  const store = BtwStore.open(
    { sessionManager, cwd: "/tmp" },
    "unit-thread",
    undefined,
  );
  const provider = new FakeProvider();
  let latest = pin(1);
  const thread: BtwThread = new BtwThread({
    ctx: {
      cwd: "/tmp",
      modelRegistry: {
        streamSimple: provider.streamSimple,
        find: () => fixtureModel,
      },
    },
    snapshot: latest,
    mode: "contextual",
    latestFinished: () => structuredClone(latest),
    store,
    onState: () => {},
    onPin: () => {},
    parentAhead: () =>
      Math.max(
        0,
        (latest.boundary.parentTurnIndex ?? 0) -
          (thread.state().boundary.parentTurnIndex ?? 0),
      ),
  });
  return {
    thread,
    store,
    provider,
    advance(value: BtwSnapshot) {
      latest = value;
    },
  };
}

test("budget counts the inherited tools/history and output reserve; refuses before provider call and keeps suffix intact", async () => {
  const host = setup();
  const tiny = pin(2);
  tiny.model = { ...fixtureModel, contextWindow: 1000, maxTokens: 900 };
  host.advance(tiny);
  await expect(
    host.thread.ask("Question too large for this model"),
  ).rejects.toThrow("over_budget");
  expect(host.provider.requests).toHaveLength(0);
  expect(host.thread.state()).toMatchObject({
    status: "failed",
    error: expect.stringContaining("btw:new"),
  });
  expect(host.store.readMessages()).toEqual([]);
  await host.thread.dispose();
});

test("same-boundary follow-ups append; rebase replaces only inherited prefix and retains complete structured suffix", async () => {
  const host = setup();
  try {
    await host.thread.ask("first side question");
    const before = host.store.readMessages();
    const boundary = host.thread.state().boundary;
    await host.thread.ask("same boundary follow-up");
    expect(host.thread.state().boundary).toEqual(boundary);
    expect(host.provider.requests[1]?.context.messages).toEqual([
      ...pin(1).messages,
      ...before,
      {
        role: "user",
        content: [{ type: "text", text: "same boundary follow-up" }],
        timestamp: expect.any(Number),
      },
    ]);
    const suffix = host.store.readMessages();
    const next = pin(2);
    host.advance(next);
    await host.thread.ask("after parent advanced");
    expect(host.provider.requests[2]?.context.messages.slice(0, -1)).toEqual([
      ...next.messages,
      ...suffix,
    ]);
    expect(host.thread.state().boundary).toEqual(next.boundary);
    expect(host.store.readMessages().slice(0, suffix.length)).toEqual(suffix);
  } finally {
    await host.thread.dispose();
  }
});

test("queued questions pin at dispatch; one answer's whole tool loop stays on its original boundary", async () => {
  const host = setup();
  host.provider.hold = true;
  try {
    const first = host.thread.ask("held first question");
    const request = await until(
      () => host.provider.requests[0],
      "held first side request",
    );
    const queued = host.thread.ask("queued second question");
    host.advance(pin(2));
    host.thread.parentAdvanced();
    expect(host.thread.state()).toMatchObject({
      boundary: { parentTurnIndex: 1 },
      parentAhead: 1,
    });
    const call = assistant();
    call.stopReason = "toolUse";
    call.content = [
      {
        type: "toolCall",
        id: "blocked",
        name: "write",
        arguments: { path: "/tmp/btw-must-not-write", content: "forbidden" },
      },
    ];
    request.finish(call);
    const toolLoop = await until(
      () => host.provider.requests[1],
      "side tool loop",
    );
    expect(toolLoop.context.messages.slice(0, pin(1).messages.length)).toEqual(
      pin(1).messages,
    );
    expect(toolLoop.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "blocked",
      isError: true,
    });
    toolLoop.finish(assistant("tool refusal understood"));
    await first;
    const dequeued = await until(
      () => host.provider.requests[2],
      "dequeued side request",
    );
    expect(dequeued.context.messages.slice(0, pin(2).messages.length)).toEqual(
      pin(2).messages,
    );
    expect(JSON.stringify(dequeued.context.messages)).toContain(
      '"toolCallId":"blocked"',
    );
    expect(host.thread.state().boundary.parentTurnIndex).toBe(2);
    dequeued.finish();
    await queued;
  } finally {
    await host.thread.dispose();
  }
});

test("abort preserves partial answer and cancels queued work; provider failures leave a retryable suffix", async () => {
  const host = setup();
  host.provider.hold = true;
  try {
    const first = host.thread.ask("abort me");
    await until(() => host.provider.requests[0], "abort request");
    const queued = host.thread.ask("queued must not run");
    const rejected = expect(queued).rejects.toThrow(
      "Queued BTW request canceled",
    );
    host.thread.abort();
    await first;
    await rejected;
    expect(host.thread.state().status).toBe("aborted");
    expect(host.thread.displayText()).toContain("partial unit answer");
    expect(host.provider.requests).toHaveLength(1);
    host.provider.hold = false;
    host.provider.response = () => ({
      ...assistant("", "error"),
      errorMessage: "fixture failure",
    });
    await expect(host.thread.ask("fail next")).rejects.toThrow(
      "fixture failure",
    );
    expect(host.thread.state().status).toBe("failed");
    host.provider.response = () => assistant("successful retry");
    await host.thread.ask("retry question");
    expect(host.thread.state().status).toBe("idle");
    expect(host.thread.transcriptText()).toContain("successful retry");
  } finally {
    await host.thread.dispose();
  }
});

test("crashed running state restores as aborted, retains title/usage/revision and never replays automatically", async () => {
  const host = setup();
  try {
    await host.thread.ask("remember this thread");
    const saved = { ...host.thread.state(), status: "running" as const };
    const requests = host.provider.requests.length;
    const restored = new BtwThread({
      ctx: {
        cwd: "/tmp",
        modelRegistry: {
          streamSimple: host.provider.streamSimple,
          find: () => fixtureModel,
        },
      },
      snapshot: pin(1),
      mode: "contextual",
      store: host.store,
      latestFinished: () => pin(2),
      onState: () => {},
      onPin: () => {},
      parentAhead: () => 1,
      restored: saved,
      interrupted: true,
    });
    expect(restored.state()).toMatchObject({
      status: "aborted",
      title: "remember this thread",
      revision: saved.revision + 1,
      lastUsage: saved.lastUsage,
    });
    expect(host.provider.requests).toHaveLength(requests);
    await restored.ask("resume explicitly");
    expect(restored.state().boundary.parentTurnIndex).toBe(2);
    expect(JSON.stringify(host.provider.requests.at(-1)?.context)).toContain(
      "remember this thread",
    );
    await restored.dispose();
  } finally {
    await host.thread.dispose();
  }
});

test.each(["aborted", "error"] as const)(
  "%s tool-result projection changes only paired BTW results and preserves parent prefix and later reused IDs",
  (stopReason) => {
    const interrupted = assistant("interrupted", stopReason);
    interrupted.content = [
      { type: "toolCall", id: "reused", name: "write", arguments: {} },
    ];
    const result = {
      role: "toolResult",
      toolCallId: "reused",
      toolName: "write",
      content: [{ type: "text", text: "not replayed" }],
      isError: true,
      timestamp: 1,
    } satisfies AgentMessage;
    const prefix: AgentMessage[] = [interrupted, result];
    const unrelated = { ...result, toolCallId: "unrelated", toolName: "read" };
    const successful = assistant("later valid", "toolUse");
    successful.content = [
      { type: "toolCall", id: "reused", name: "read", arguments: {} },
    ];
    const validResult = { ...result, toolName: "read", isError: false };
    const messages: AgentMessage[] = [
      ...prefix,
      interrupted,
      result,
      unrelated,
      successful,
      validResult,
    ];
    expect(btwToLlm(messages, prefix.length)).toEqual([
      ...prefix,
      interrupted,
      unrelated,
      successful,
      validResult,
    ]);
    expect(messages).toHaveLength(7);
    expect(messages[3]).toEqual(result);
  },
);
