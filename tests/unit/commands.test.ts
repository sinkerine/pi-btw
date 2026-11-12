import { expect, test } from "vitest";
import { BtwCommands } from "../../src/commands.js";
import type { BtwThreadEvent, BtwThreadState } from "../../src/contract.js";
import { until } from "../support/pi.js";
import { runtime } from "../support/runtime.js";
import { assistant, fixtureModel } from "../support/stream.js";

function states(events: readonly BtwThreadEvent[]): BtwThreadState[] {
  return events.flatMap((event) =>
    event.type === "state" ? [event.thread] : [],
  );
}
async function setup() {
  const events: BtwThreadEvent[] = [];
  const host = await runtime((pi) => {
    pi.events.on("pi-btw:thread", (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    });
    new BtwCommands(pi);
  });
  const notices: string[] = [];
  host.runner.setUIContext(
    {
      ...host.ctx.ui,
      notify: (message) => {
        notices.push(message);
      },
    },
    "rpc",
  );
  return { ...host, events, notices };
}
async function finished(events: BtwThreadEvent[], offset: number) {
  return until(
    () =>
      states(events.slice(offset)).find(
        (state) => state.status === "idle" && state.revision > 0,
      ),
    "BTW command completion",
  );
}

test("empty mode/alias commands make no request; contextual aliases, new, tangent and clear preserve their distinct behaviors", async () => {
  const host = await setup();
  try {
    for (const command of ["/btw", "/side", "/btw:new", "/btw:tangent"]) {
      await host.session.prompt(command);
      expect(host.provider.requests).toHaveLength(0);
    }
    expect(states(host.events).at(-1)).toMatchObject({
      mode: "tangent",
      boundary: { kind: "none" },
    });
    await host.session.prompt("/btw:clear");
    await host.session.prompt("/btw no completed parent");
    expect(host.notices.at(-1)).toContain("no_finished_turn");
    expect(host.provider.requests).toHaveLength(0);
    await host.session.prompt("parent A");
    let offset = host.events.length;
    await host.session.prompt("/btw first contextual question");
    const first = await finished(host.events, offset);
    offset = host.events.length;
    await host.session.prompt("/side second contextual question");
    const alias = await finished(host.events, offset);
    expect(alias.threadId).toBe(first.threadId);
    expect(alias.mode).toBe("contextual");
    offset = host.events.length;
    await host.session.prompt("/btw:new fresh question");
    const fresh = await finished(host.events, offset);
    expect(fresh.threadId).not.toBe(first.threadId);
    const freshRequest = host.provider.requests.at(-1);
    expect(JSON.stringify(freshRequest?.context)).not.toContain(
      "first contextual question",
    );
    expect(JSON.stringify(freshRequest?.context)).toContain("parent A");
    offset = host.events.length;
    await host.session.prompt("/btw:tangent independent question");
    const tangent = await finished(host.events, offset);
    expect(tangent.cache).toMatchObject({
      reason: "tangent",
      sharesParentPrefix: false,
      requestSessionId: tangent.threadId,
    });
    expect(
      JSON.stringify(host.provider.requests.at(-1)?.context),
    ).not.toContain("parent A");
    const count = host.provider.requests.length;
    await host.session.prompt("/btw:clear");
    expect(host.provider.requests).toHaveLength(count);
    expect(host.events.at(-1)).toMatchObject({
      type: "closed",
      reason: "cleared",
      threadId: tangent.threadId,
    });
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test.each(["/btw", "/side", "/btw:new", "/btw:tangent"])(
  "%s empty opens honest idle state before a finished turn; an explicit question still requires context",
  async (command) => {
    const host = await setup();
    try {
      await host.session.prompt(command);
      const draft = states(host.events).at(-1);
      expect(draft).toMatchObject({
        mode: command === "/btw:tangent" ? "tangent" : "contextual",
        status: "idle",
        title: "BTW",
        boundary: {
          kind: "none",
          parentLeafEntryId: null,
          parentTurnIndex: null,
          messageCount: command === "/btw:tangent" ? 1 : 0,
        },
        resumable: false,
        cache: {
          sharesParentPrefix: false,
          reason:
            command === "/btw:tangent" ? "tangent" : "unverified_serialization",
        },
      });
      expect(host.provider.requests).toHaveLength(0);
      expect(host.notices).toEqual([]);
      const branch = host.sessionManager.getBranch();
      host.pi.events.emit("pi-btw:sync", {});
      expect(states(host.events).at(-1)).toEqual(draft);
      expect(host.sessionManager.getBranch()).toEqual(branch);
      expect(host.provider.requests).toHaveLength(0);
      if (command !== "/btw:tangent") {
        expect(
          branch.some(
            (entry) =>
              entry.type === "custom" && entry.customType === "pi-btw/thread",
          ),
        ).toBe(false);
        await host.session.prompt("/side question before a finished turn");
        await until(
          () => states(host.events).find((state) => state.status === "failed"),
          "unpinned explicit question fails",
        );
        expect(states(host.events).at(-1)?.error).toContain("no_finished_turn");
        expect(host.provider.requests).toHaveLength(0);
        await host.session.prompt("parent A");
      }
      const offset = host.events.length;
      await host.session.prompt("/btw explicit question");
      const answer = await finished(host.events, offset);
      expect(answer.threadId).toBe(draft?.threadId);
      expect(answer.cache).toMatchObject({
        sharesParentPrefix: command !== "/btw:tangent",
        reason: command === "/btw:tangent" ? "tangent" : null,
        requestSessionId:
          command === "/btw:tangent" ? draft?.threadId : draft?.parentSessionId,
      });
      expect(answer.boundary.kind).toBe(
        command === "/btw:tangent" ? "none" : "turn_end",
      );
      expect(host.provider.requests).toHaveLength(
        command === "/btw:tangent" ? 1 : 2,
      );
      await host.session.prompt("/btw:clear");
      expect(host.events.at(-1)).toMatchObject({
        type: "closed",
        reason: "cleared",
        threadId: draft?.threadId,
      });
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test.each(["/btw", "/side", "/btw:new", "/btw:tangent"])(
  "%s empty opens after a finished turn and aliases reopen the same thread without a request",
  async (command) => {
    const host = await setup();
    try {
      await host.session.prompt("parent A");
      await host.session.prompt(command);
      const opened = states(host.events).at(-1);
      expect(opened).toMatchObject({
        status: "idle",
        mode: command === "/btw:tangent" ? "tangent" : "contextual",
        boundary: {
          kind: command === "/btw:tangent" ? "none" : "turn_end",
        },
        cache: { sharesParentPrefix: command !== "/btw:tangent" },
      });
      expect(host.provider.requests).toHaveLength(1);
      await host.session.prompt("/side");
      await host.session.prompt("/btw");
      host.pi.events.emit("pi-btw:sync", {});
      expect(states(host.events).at(-1)).toEqual(opened);
      expect(host.provider.requests).toHaveLength(1);
      expect(host.notices).toEqual([]);
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test("model/thinking/status report override semantics and RPC questions acknowledge before a held answer; repeated sync is side-effect free", async () => {
  const host = await setup();
  try {
    await host.session.prompt("parent A");
    await host.session.prompt("/btw question");
    await finished(host.events, 0);
    await host.session.prompt(
      `/btw:model ${fixtureModel.provider}/${fixtureModel.id}`,
    );
    await host.session.prompt("/btw:thinking high");
    expect(states(host.events).at(-1)?.cache).toMatchObject({
      reason: "model_override",
      sharesParentPrefix: false,
      thinkingLevel: "high",
    });
    await host.session.prompt("/btw:status");
    expect(JSON.parse(host.notices.at(-1) ?? "{}").cache.thinkingLevel).toBe(
      "high",
    );
    const calls = host.provider.requests.length;
    const branch = host.sessionManager.getBranch();
    const before = states(host.events).at(-1);
    host.pi.events.emit("pi-btw:sync", {});
    host.pi.events.emit("pi-btw:sync", {});
    expect(states(host.events).slice(-2)).toEqual([before, before]);
    expect(host.provider.requests).toHaveLength(calls);
    expect(host.sessionManager.getBranch()).toEqual(branch);
    host.provider.hold = true;
    await host.session.prompt("/side held follow-up");
    const request = await until(
      () => host.provider.requests[calls],
      "held side request",
    );
    expect(states(host.events).at(-1)?.status).toBe("running");
    await host.session.prompt("/btw:abort");
    await until(
      () => states(host.events).findLast((state) => state.status === "aborted"),
      "aborted side",
    );
    expect(request.options?.signal?.aborted).toBe(true);
    expect(host.session.isStreaming).toBe(false);
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test("explicit inject and summarize deliver exactly once; duplicate pending summary is refused and replaced generation cannot inject", async () => {
  const host = await setup();
  try {
    await host.session.prompt("parent A");
    await host.session.prompt("/btw side answer");
    await finished(host.events, 0);
    const count = host.provider.requests.length;
    await host.session.prompt("/btw:inject focus on X");
    await until(() => host.provider.requests[count], "injected main request");
    await host.session.agent.waitForIdle();
    expect(JSON.stringify(host.provider.requests[count]?.context)).toContain(
      "focus on X",
    );
    expect(host.provider.requests).toHaveLength(count + 1);
    host.provider.hold = true;
    await host.session.prompt("/btw:summarize concise");
    const summary = await until(
      () => host.provider.requests[count + 1],
      "held summary",
    );
    await host.session.prompt("/btw:summarize duplicate");
    expect(host.notices.at(-1)).toContain("delivery already pending");
    expect(host.provider.requests).toHaveLength(count + 2);
    await host.session.prompt("/btw:new");
    expect(summary.options?.signal?.aborted).toBe(true);
    summary.finish(assistant("late summary must not inject"));
    await Promise.resolve();
    expect(host.provider.requests).toHaveLength(count + 2);
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test("tree switch releases a thread outside active ancestry and refuses context until the new branch finishes", async () => {
  const host = await setup();
  try {
    await host.session.prompt("source branch parent");
    await host.session.prompt("/btw source branch side");
    const source = await finished(host.events, 0);
    const oldLeafId = host.sessionManager.getLeafId();
    host.sessionManager.resetLeaf();
    host.session.agent.state.messages = [];
    await host.runner.emit({
      type: "session_tree",
      oldLeafId,
      newLeafId: null,
    });
    expect(host.events.at(-1)).toMatchObject({
      type: "closed",
      threadId: source.threadId,
    });
    const calls = host.provider.requests.length;
    await host.session.prompt("/btw cannot use abandoned context");
    expect(host.notices.at(-1)).toContain("no_finished_turn");
    expect(host.provider.requests).toHaveLength(calls);
    await host.session.prompt("new branch parent");
    const after = host.events.length;
    await host.session.prompt("/btw new branch side");
    const active = await finished(host.events, after);
    expect(active.threadId).not.toBe(source.threadId);
    expect(
      JSON.stringify(host.provider.requests.at(-1)?.context),
    ).not.toContain("source branch");
    expect(JSON.stringify(host.provider.requests.at(-1)?.context)).toContain(
      "new branch parent",
    );
    expect(host.errors).toEqual([]);
  } finally {
    await host.close();
  }
});

test.each(["/btw:inject", "/btw:summarize"])(
  "%s refuses an empty thread without a main or side provider request",
  async (command) => {
    const host = await setup();
    try {
      await host.session.prompt("parent A");
      await host.session.prompt("/btw:new");
      await host.session.prompt(command);
      expect(host.notices.at(-1)).toContain("BTW is empty");
      expect(host.provider.requests).toHaveLength(1);
      expect(host.session.isStreaming).toBe(false);
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test.each([false, true])(
  "abort summary queued=%s retains canceled status and never delivers a previous/partial answer to main",
  async (queued) => {
    const host = await setup();
    try {
      await host.session.prompt("parent A");
      await host.session.prompt("/btw old answer");
      await finished(host.events, 0);
      host.provider.hold = true;
      if (queued) {
        await host.session.prompt("/btw ahead of summary");
        await until(() => host.provider.requests[2], "ahead of summary");
      }
      await host.session.prompt("/btw:summarize canceled");
      if (!queued)
        await until(() => host.provider.requests[2], "running summary");
      const offset = host.events.length;
      await host.session.prompt("/btw:abort");
      await until(
        () => host.notices.find((notice) => notice.includes("canceled")),
        "canceled summary notice",
      );
      expect(states(host.events.slice(offset)).at(-1)?.status).toBe("aborted");
      expect(host.provider.requests).toHaveLength(3);
      expect(host.session.isStreaming).toBe(false);
      host.provider.hold = false;
      const recovery = host.events.length;
      await host.session.prompt("/btw next explicit question");
      await finished(host.events, recovery);
      expect(host.provider.requests).toHaveLength(4);
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test.each(["websocket", "websocket-cached"] as const)(
  "%s capture preserves normal parent turns and refuses BTW with unsupported_serialization",
  async (transport) => {
    const host = await setup();
    try {
      host.session.settingsManager.setTransport(transport);
      await host.session.prompt("parent under unsupported BTW transport");
      await host.session.prompt("/btw refuse unsupported transport");
      expect(host.notices.at(-1)).toContain("unsupported_serialization");
      expect(host.notices.at(-1)).not.toContain("no_finished_turn");
      expect(host.provider.requests).toHaveLength(1);
      await host.session.prompt("normal parent continues");
      expect(host.provider.requests).toHaveLength(2);
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test("same active branch tree event preserves a transient unpinned composer", async () => {
  const host = await setup();
  try {
    await host.session.prompt("/btw:new");
    const draft = states(host.events).at(-1);
    const leaf = host.sessionManager.getLeafId();
    await host.runner.emit({
      type: "session_tree",
      oldLeafId: leaf,
      newLeafId: leaf,
    });
    host.pi.events.emit("pi-btw:sync", {});
    expect(states(host.events).at(-1)).toEqual(draft);
    expect(host.provider.requests).toHaveLength(0);
  } finally {
    await host.close();
  }
});

test.each(["empty", "provider error"])(
  "%s summary remains failed and sends nothing to main",
  async (scenario) => {
    const host = await setup();
    try {
      await host.session.prompt("parent A");
      await host.session.prompt("/btw existing conversation");
      await finished(host.events, 0);
      host.provider.response = () =>
        assistant("", scenario === "provider error" ? "error" : "stop");
      const offset = host.events.length;
      await host.session.prompt("/btw:summarize must not deliver");
      await until(
        () =>
          states(host.events.slice(offset)).find(
            (state) => state.status === "failed",
          ),
        "failed summary state",
      );
      expect(host.provider.requests).toHaveLength(3);
      expect(host.session.isStreaming).toBe(false);
      expect(states(host.events).at(-1)?.status).toBe("failed");
      expect(host.errors).toEqual([]);
    } finally {
      await host.close();
    }
  },
);

test("late queued-summary cancellation cannot fail a question retried immediately on Stop", async () => {
  const host = await setup();
  try {
    await host.session.prompt("parent A");
    await host.session.prompt("/btw existing conversation");
    await finished(host.events, 0);
    host.provider.hold = true;
    await host.session.prompt("/btw active question ahead of summary");
    await until(() => host.provider.requests[2], "held active request");
    await host.session.prompt("/btw:summarize queued summary");
    let retried = false;
    const unsubscribe = host.pi.events.on("pi-btw:thread", (raw) => {
      const event = raw as BtwThreadEvent;
      if (
        event.type === "state" &&
        event.thread.status === "aborted" &&
        !retried
      ) {
        retried = true;
        host.provider.hold = false;
        void host.session.prompt("/btw immediate retry after Stop");
      }
    });
    const offset = host.events.length;
    await host.session.prompt("/btw:abort");
    await finished(host.events, offset);
    await until(
      () => host.notices.find((notice) => notice.includes("canceled")),
      "late cancellation settled",
    );
    expect(retried).toBe(true);
    expect(host.provider.requests).toHaveLength(4);
    expect(
      states(host.events.slice(offset)).some(
        (state) => state.status === "failed",
      ),
    ).toBe(false);
    expect(states(host.events).at(-1)?.status).toBe("idle");
    expect(host.errors).toEqual([]);
    unsubscribe();
  } finally {
    await host.close();
  }
});
