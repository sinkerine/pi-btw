import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { BtwSnapshot } from "../../src/boundary.js";
import { digest } from "../../src/digest.js";
export function snapshot(
  owner = "owner",
  leaf = "leaf",
  turn = 1,
): BtwSnapshot {
  const messages: BtwSnapshot["messages"] = [
    { role: "system", content: "parent context", timestamp: 1 },
    { role: "user", content: "public question", timestamp: 2 },
  ];
  return {
    messages,
    model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
    parentSessionId: owner,
    request: {
      thinkingLevel: "off",
      options: { cacheRetention: "long", transport: "sse" },
    },
    boundary: {
      kind: "turn_end",
      parentLeafEntryId: leaf,
      parentTurnIndex: turn,
      messageCount: messages.length,
      prefixDigest: digest(messages),
      pinnedAt: "2026-11-12T00:00:00.000Z",
    },
  };
}
