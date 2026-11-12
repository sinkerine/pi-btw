import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { BtwThreadState } from "../../src/contract.js";
import { BtwOverlay } from "../../src/tui/overlay.js";
import { snapshot } from "../support/snapshot.js";

test("overlay focuses composer and Esc stops BTW before dismissal; Unicode renders at narrow widths", () => {
  const actions: string[] = [];
  let running = true;
  const state: BtwThreadState = {
    version: 1,
    parentSessionId: "parent",
    threadId: "thread",
    mode: "contextual",
    status: "running",
    title: "Unicode",
    sessionFile: null,
    resumable: false,
    revision: 2,
    boundary: snapshot().boundary,
    parentAhead: 1,
    cache: {
      provider: "fixture",
      modelId: "fixture",
      api: "openai-completions",
      thinkingLevel: "off",
      requestSessionId: "parent",
      sharesParentPrefix: true,
      reason: null,
    },
    lastUsage: null,
    error: null,
    updatedAt: "2026-11-12T00:00:00.000Z",
  };
  const overlay = new BtwOverlay({
    state: () => ({ ...state, status: running ? "running" : "aborted" }),
    transcript: () => "雪の質問 👩‍💻\nRead-only answer",
    ask: async (question) => {
      actions.push(question);
    },
    abort: () => {
      actions.push("abort");
      running = false;
    },
    dismiss: () => {
      actions.push("dismiss");
    },
    render: () => {},
  });
  overlay.focused = true;
  expect(overlay.input.focused).toBe(true);
  overlay.handleInput("雪");
  expect(overlay.input.getValue()).toBe("雪");
  expect(overlay.render(14).every((line) => visibleWidth(line) <= 14)).toBe(
    true,
  );
  overlay.handleInput("\u001b");
  expect(actions).toEqual(["abort"]);
  overlay.handleInput("\u001b");
  expect(actions).toEqual(["abort", "dismiss"]);
  overlay.focused = false;
  expect(overlay.input.focused).toBe(false);
});

test("composer keeps a failed draft and visible error, then clears it only after a successful retry", async () => {
  let fail = true;
  let renders = 0;
  const submitted: string[] = [];
  const overlay = new BtwOverlay({
    state: () => null,
    transcript: () => "",
    ask: async (question) => {
      submitted.push(question);
      if (fail) throw new Error("over_budget: use /btw:new");
    },
    abort: () => {},
    dismiss: () => {},
    render: () => {
      renders++;
    },
  });
  overlay.input.setValue("雪の質問");
  overlay.handleInput("\r");
  overlay.handleInput("\r");
  await new Promise((done) => setTimeout(done, 0));
  expect(submitted).toEqual(["雪の質問"]);
  expect(overlay.input.getValue()).toBe("雪の質問");
  expect(overlay.render(50).join("\n")).toContain("over_budget");
  fail = false;
  overlay.handleInput("\r");
  await new Promise((done) => setTimeout(done, 0));
  expect(submitted).toEqual(["雪の質問", "雪の質問"]);
  expect(overlay.input.getValue()).toBe("");
  expect(renders).toBe(2);
});
