import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildSessionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
  BtwStore,
  type BtwThreadIndex,
  latestThreadIndex,
  loadCheckpoint,
  saveCheckpoint,
} from "../../src/store.js";
import { BtwThread } from "../../src/thread.js";
import { snapshot } from "../support/snapshot.js";
import { assistant, FakeProvider, fixtureModel } from "../support/stream.js";

async function persistent() {
  const directory = await mkdtemp(join(tmpdir(), "btw-store-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const sessionManager = SessionManager.create(
    directory,
    join(directory, "parents"),
  );
  const leaf = sessionManager.appendMessage({
    role: "user",
    content: "parent",
    timestamp: 1,
  });
  const ctx = { sessionManager, cwd: directory };
  const pin = snapshot(sessionManager.getSessionId(), leaf);
  const store = BtwStore.open(
    ctx,
    "12345678-abcd",
    sessionManager.getSessionFile(),
  );
  const path = await store.saveSnapshot(pin);
  if (!path || !store.file) throw new Error("persistent paths missing");
  const provider = new FakeProvider();
  const thread = new BtwThread({
    ctx: {
      cwd: directory,
      modelRegistry: {
        streamSimple: provider.streamSimple,
        find: () => fixtureModel,
      },
    },
    snapshot: pin,
    mode: "contextual",
    store,
    latestFinished: () => pin,
    onState: () => {},
    onPin: () => {},
    parentAhead: () => 0,
  });
  const state = thread.state();
  store.saveState(state);
  const index: BtwThreadIndex = {
    parentSessionId: sessionManager.getSessionId(),
    threadId: store.threadId,
    sessionFile: store.file,
    boundary: pin.boundary,
    mode: "contextual",
    cache: state.cache,
  };
  return {
    directory,
    sessionManager,
    ctx,
    pin,
    store,
    path,
    state,
    index,
    async close() {
      await thread.dispose();
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prior;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("persistent exact snapshots, assistant signatures and complete tool pairs roundtrip privately and stay out of parent context", async () => {
  const host = await persistent();
  try {
    const { store, pin, path, ctx, index, state, sessionManager } = host;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    store.appendMessage({
      role: "user",
      content: "side question",
      timestamp: 2,
    });
    const call = assistant();
    call.stopReason = "toolUse";
    call.content = [
      {
        type: "thinking",
        thinking: "reason",
        thinkingSignature: "opaque-thinking",
      },
      { type: "text", text: "read", textSignature: "opaque-text" },
      { type: "toolCall", name: "read", id: "call", arguments: { path: "a" } },
    ];
    store.appendMessage(call);
    store.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      details: { path: "a" },
      isError: false,
      timestamp: 3,
    });
    store.appendBoundary(pin.boundary, "rebase");
    const reopened = BtwStore.resume(ctx, index);
    expect(reopened.readMessages()).toEqual(store.readMessages());
    expect(reopened.readState()).toEqual(state);
    expect(await reopened.loadSnapshot(pin.boundary.prefixDigest)).toEqual(pin);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(pin));
    if (!store.file) throw new Error("file missing");
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.file, "utf8")).not.toContain("parent context");
    sessionManager.appendCustomEntry("pi-btw/thread", index);
    expect(
      latestThreadIndex(
        sessionManager.getBranch(),
        sessionManager.getSessionId(),
      ),
    ).toEqual(index);
    expect(
      latestThreadIndex(sessionManager.getBranch(), "cloned-owner"),
    ).toBeNull();
    sessionManager.appendCustomEntry("pi-btw/clear", {
      parentSessionId: "source-owner",
    });
    expect(
      latestThreadIndex(
        sessionManager.getBranch(),
        sessionManager.getSessionId(),
      ),
    ).toEqual(index);
    expect(
      JSON.stringify(buildSessionContext(sessionManager.getBranch()).messages),
    ).not.toContain("side question");
    sessionManager.appendCustomEntry("pi-btw/clear", {
      parentSessionId: sessionManager.getSessionId(),
    });
    expect(
      latestThreadIndex(
        sessionManager.getBranch(),
        sessionManager.getSessionId(),
      ),
    ).toBeNull();
    sessionManager.appendCustomEntry("pi-btw/thread", {
      ...index,
      boundary: null,
    });
    expect(() =>
      latestThreadIndex(
        sessionManager.getBranch(),
        sessionManager.getSessionId(),
      ),
    ).toThrow("snapshot_unavailable");
  } finally {
    await host.close();
  }
});

test.each([
  "missing",
  "malformed",
  "digest mismatch",
  "invalid model",
  "invalid boundary",
])(
  "%s snapshot refuses without rebuilding from parent history",
  async (kind) => {
    const host = await persistent();
    try {
      if (kind === "missing") await unlink(host.path);
      if (kind === "malformed") await writeFile(host.path, "{corrupt");
      if (kind === "digest mismatch")
        await writeFile(
          host.path,
          JSON.stringify({ ...host.pin, messages: [] }),
        );
      if (kind === "invalid model")
        await writeFile(host.path, JSON.stringify({ ...host.pin, model: {} }));
      if (kind === "invalid boundary")
        await writeFile(
          host.path,
          JSON.stringify({
            ...host.pin,
            boundary: { ...host.pin.boundary, messageCount: 999 },
          }),
        );
      const reopened = BtwStore.resume(host.ctx, host.index);
      await expect(
        reopened.loadSnapshot(host.pin.boundary.prefixDigest),
      ).rejects.toThrow("snapshot_unavailable");
      expect(reopened.readMessages()).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test("latest checkpoint replacement is bounded, selected snapshots remain, and abandoned branch checkpoint is ignored", async () => {
  const host = await persistent();
  try {
    saveCheckpoint(host.pin, host.ctx);
    expect(loadCheckpoint(host.ctx)).toEqual(host.pin);
    const nextLeaf = host.sessionManager.appendMessage(
      assistant("new completed boundary"),
    );
    const next = snapshot(host.sessionManager.getSessionId(), nextLeaf, 2);
    saveCheckpoint(next, host.ctx);
    expect(loadCheckpoint(host.ctx)).toEqual(next);
    const parentDirectory = dirname(dirname(host.path));
    expect(
      (await readdir(parentDirectory)).filter((path) => path.endsWith(".json")),
    ).toEqual(["latest.json"]);
    expect(
      await host.store.loadSnapshot(host.pin.boundary.prefixDigest),
    ).toEqual(host.pin);
    host.sessionManager.resetLeaf();
    expect(loadCheckpoint(host.ctx)).toBeNull();
    await writeFile(join(parentDirectory, "latest.json"), "corrupt checkpoint");
    expect(() => loadCheckpoint(host.ctx)).toThrow("snapshot_unavailable");
  } finally {
    await host.close();
  }
});

test("missing child, foreign file, malformed state and invalid child ancestry fail closed", async () => {
  const host = await persistent();
  try {
    expect(() =>
      BtwStore.resume(host.ctx, {
        ...host.index,
        parentSessionId: "cloned-owner",
      }),
    ).toThrow("snapshot_unavailable");
    expect(() =>
      BtwStore.resume(host.ctx, {
        ...host.index,
        sessionFile: "/tmp/foreign.jsonl",
      }),
    ).toThrow("snapshot_unavailable");
    await writeFile(
      join(dirname(host.path), "state.json"),
      JSON.stringify({ ...host.state, version: 2 }),
    );
    const reopened = BtwStore.resume(host.ctx, host.index);
    expect(() => reopened.readState()).toThrow("snapshot_unavailable");
    const file = host.store.file;
    if (!file) throw new Error("file missing");
    const original = await readFile(file, "utf8");
    await writeFile(
      file,
      `${original}${JSON.stringify({ type: "message", id: "bad", parentId: "missing", message: { role: "user", content: "corrupt" } })}\n`,
    );
    expect(() => BtwStore.resume(host.ctx, host.index)).toThrow(
      "snapshot_unavailable",
    );
    await unlink(file);
    expect(() => BtwStore.resume(host.ctx, host.index)).toThrow(
      "snapshot_unavailable",
    );
    await expect(readFile(file)).rejects.toThrow();
  } finally {
    await host.close();
  }
});

test("in-memory parent never promises a file, checkpoint or cross-process recovery", async () => {
  const sessionManager = SessionManager.inMemory("/tmp");
  const ctx = { sessionManager, cwd: "/tmp" };
  const store = BtwStore.open(ctx, "memory", undefined);
  const pin = snapshot(sessionManager.getSessionId());
  expect(store.file).toBeNull();
  expect(await store.saveSnapshot(pin)).toBeNull();
  expect(await store.loadSnapshot(pin.boundary.prefixDigest)).toEqual(pin);
  saveCheckpoint(pin, ctx);
  expect(loadCheckpoint(ctx)).toBeNull();
  const fresh = BtwStore.open(ctx, "memory", undefined);
  await expect(fresh.loadSnapshot(pin.boundary.prefixDigest)).rejects.toThrow(
    "snapshot_unavailable",
  );
});

test("partial checkpoints coalesce, preserve signed assistant metadata and recover exactly once with closed tool pairs", async () => {
  const host = await persistent();
  try {
    host.store.appendMessage({
      role: "user",
      content: "interrupted question",
      timestamp: 1,
    });
    const partial = assistant("partial signed answer", "pending");
    partial.content = [
      {
        type: "thinking",
        thinking: "partial thought",
        thinkingSignature: "opaque-signature",
      },
      {
        type: "text",
        text: "partial signed answer",
        textSignature: "opaque-text",
      },
      {
        type: "toolCall",
        id: "interrupted-call",
        name: "write",
        arguments: { path: "never-replayed", content: "blocked" },
      },
    ];
    host.store.checkpointPartial(partial, 0);
    const path = join(dirname(host.path), "partial.json");
    const first = await readFile(path, "utf8");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const newer = {
      ...partial,
      content: partial.content.map((part) =>
        part.type === "text"
          ? { ...part, text: "new partial signed answer" }
          : part,
      ),
    };
    for (let tick = 1; tick < 250; tick++)
      host.store.checkpointPartial(newer, tick);
    expect(await readFile(path, "utf8")).toBe(first);
    host.store.flushPartial(250);
    const restored = BtwStore.resume(host.ctx, host.index);
    restored.recoverInterrupted();
    const recovered = restored.readMessages();
    expect(recovered).toHaveLength(3);
    expect(recovered[1]).toMatchObject({
      ...newer,
      stopReason: "aborted",
      errorMessage: expect.stringContaining("interrupted"),
    });
    expect(recovered[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "interrupted-call",
      toolName: "write",
      isError: true,
    });
    expect(JSON.stringify(recovered[2])).toContain("not replayed");
    restored.recoverInterrupted();
    expect(restored.readMessages()).toEqual(recovered);
    await expect(readFile(path)).rejects.toThrow();
  } finally {
    await host.close();
  }
});

test("completed assistant wins over leftover partial checkpoint; interrupted tool batches retain existing results and close only missing pairs", async () => {
  const host = await persistent();
  try {
    host.store.appendMessage({
      role: "user",
      content: "tool batch",
      timestamp: 1,
    });
    const partial = assistant("partial", "pending");
    host.store.checkpointPartial(partial, 0);
    const final = assistant("completed tool calls", "toolUse");
    final.content = [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
    ];
    host.store.appendMessage(final);
    host.store.appendMessage({
      role: "toolResult",
      toolCallId: "a",
      toolName: "read",
      content: [{ type: "text", text: "persisted result" }],
      isError: false,
      timestamp: 2,
    });
    const restored = BtwStore.resume(host.ctx, host.index);
    restored.recoverInterrupted();
    const messages = restored.readMessages();
    expect(messages).toHaveLength(4);
    expect(messages[1]).toEqual(final);
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "a",
      isError: false,
    });
    expect(messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "b",
      isError: true,
    });
    expect(JSON.stringify(messages)).not.toContain('"text":"partial"');
    restored.recoverInterrupted();
    expect(restored.readMessages()).toEqual(messages);
  } finally {
    await host.close();
  }
});

test("foreign or corrupt partial checkpoint refuses recovery without appending an assistant", async () => {
  const host = await persistent();
  try {
    host.store.appendMessage({
      role: "user",
      content: "question",
      timestamp: 1,
    });
    host.store.checkpointPartial(assistant("partial", "pending"), 0);
    const path = join(dirname(host.path), "partial.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...record, parentSessionId: "foreign-owner" }),
    );
    const restored = BtwStore.resume(host.ctx, host.index);
    expect(() => restored.recoverInterrupted()).toThrow("snapshot_unavailable");
    expect(restored.readMessages()).toHaveLength(1);
    await writeFile(path, "malformed");
    expect(() => restored.recoverInterrupted()).toThrow("snapshot_unavailable");
    expect(restored.readMessages()).toHaveLength(1);
  } finally {
    await host.close();
  }
});
