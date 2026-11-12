import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSessionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { BoundaryTracker } from "../../src/boundary.js";
import { until } from "../support/pi.js";
import { runtime } from "../support/runtime.js";
import { snapshot } from "../support/snapshot.js";
import { assistant } from "../support/stream.js";

test("restored exact boundary requires current owner and active branch; cloned and abandoned contexts refuse", () => {
  const tracker = new BoundaryTracker({
    on: () => () => {},
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
  });
  const sessionManager = SessionManager.inMemory("/tmp");
  const leaf = sessionManager.appendMessage({
    role: "user",
    content: "parent",
    timestamp: 1,
  });
  const ctx = { sessionManager };
  expect(() => tracker.current(ctx)).toThrow("no_finished_turn");
  const pin = snapshot(sessionManager.getSessionId(), leaf, 4);
  tracker.restore(pin);
  expect(tracker.current(ctx)).toEqual(pin);
  const copy = tracker.current(ctx);
  copy.messages.length = 0;
  expect(tracker.current(ctx).messages).toHaveLength(2);
  expect(
    tracker.completedTurnsSince({ ...pin.boundary, parentTurnIndex: 2 }),
  ).toBe(2);
  sessionManager.resetLeaf();
  expect(() => tracker.current(ctx)).toThrow("no_finished_turn");
  tracker.restore(snapshot("another-session", leaf));
  expect(() => tracker.current(ctx)).toThrow("no_finished_turn");
});

test("capture includes transformed actual request and freezes it until a fully finished tool batch", async () => {
  const trackers: BoundaryTracker[] = [];
  const host = await runtime((pi) => {
    pi.on("context", (event) => ({
      messages: [
        ...event.messages,
        { role: "user", content: "transformed context", timestamp: 2 },
      ],
    }));
    trackers.push(new BoundaryTracker(pi));
  });
  try {
    const tracker = trackers[0];
    if (!tracker) throw new Error("tracker missing");
    await writeFile(
      join(host.directory, "fixture.txt"),
      "read-only tool output",
    );
    host.provider.hold = true;
    const run = host.session.prompt("parent with tools");
    const first = await until(
      () => host.provider.requests[0],
      "first parent request",
    );
    expect(() => tracker.current(host.ctx)).toThrow("no_finished_turn");
    const call = assistant();
    call.content = [
      {
        type: "toolCall",
        id: "call_read",
        name: "read",
        arguments: { path: "fixture.txt" },
      },
    ];
    call.stopReason = "toolUse";
    first.finish(call);
    const second = await until(
      () => host.provider.requests[1],
      "next parent request held",
    );
    const pin = tracker.current(host.ctx);
    expect(pin.boundary.parentTurnIndex).toBe(1);
    expect(pin.messages.slice(0, first.context.messages.length)).toEqual(
      first.context.messages,
    );
    expect(pin.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_read",
      content: [{ type: "text", text: "read-only tool output" }],
    });
    expect(JSON.stringify(pin.messages)).toContain("transformed context");
    expect(tracker.current(host.ctx)).toEqual(pin);
    second.finish(assistant("parent finished"));
    await run;
    expect(tracker.current(host.ctx).boundary.parentTurnIndex).toBe(2);
    expect(pin.boundary.parentTurnIndex).toBe(1);
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test("aborted and failed responses do not advance the last completed boundary", async () => {
  const trackers: BoundaryTracker[] = [];
  const host = await runtime((pi) => {
    trackers.push(new BoundaryTracker(pi));
  });
  try {
    const tracker = trackers[0];
    if (!tracker) throw new Error("tracker missing");
    await host.session.prompt("complete A");
    const pin = tracker.current(host.ctx);
    for (const stopReason of ["aborted", "error"] as const) {
      host.provider.response = () => assistant("unfinished", stopReason);
      await host.session.prompt(`next ${stopReason}`);
      expect(tracker.current(host.ctx)).toEqual(pin);
    }
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test("compaction changes the next completed snapshot; tree switch refuses abandoned checkpoint and accepts a new branch turn", async () => {
  const trackers: BoundaryTracker[] = [];
  const host = await runtime((pi) => {
    trackers.push(new BoundaryTracker(pi));
  });
  try {
    const tracker = trackers[0];
    if (!tracker) throw new Error("tracker missing");
    await host.session.prompt("old full history");
    const previous = tracker.current(host.ctx);
    host.sessionManager.appendCompaction(
      "Compacted public summary",
      null,
      20000,
    );
    host.session.agent.state.messages = buildSessionContext(
      host.sessionManager.getBranch(),
    ).messages;
    expect(tracker.current(host.ctx)).toEqual(previous);
    await host.session.prompt("new compacted turn");
    const compacted = tracker.current(host.ctx);
    expect(compacted.boundary.prefixDigest).not.toBe(
      previous.boundary.prefixDigest,
    );
    expect(JSON.stringify(compacted.messages)).toContain(
      "Compacted public summary",
    );
    expect(JSON.stringify(compacted.messages)).not.toContain(
      "old full history",
    );
    const oldLeafId = host.sessionManager.getLeafId();
    host.sessionManager.resetLeaf();
    host.session.agent.state.messages = [];
    await host.runner.emit({
      type: "session_tree",
      newLeafId: null,
      oldLeafId,
    });
    expect(() => tracker.current(host.ctx)).toThrow("no_finished_turn");
    await host.session.prompt("new branch turn");
    expect(JSON.stringify(tracker.current(host.ctx).messages)).toContain(
      "new branch turn",
    );
    expect(JSON.stringify(tracker.current(host.ctx).messages)).not.toContain(
      "Compacted public summary",
    );
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});
