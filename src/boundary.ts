import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BtwBoundary } from "./contract.js";
import { digest } from "./digest.js";
import { BtwError } from "./errors.js";
import { type BtwRequestSettings, requestSettings } from "./request.js";
export interface BtwSnapshot {
  messages: AgentMessage[];
  boundary: BtwBoundary;
  model: Model<Api>;
  request: BtwRequestSettings;
  parentSessionId: string;
}
export class BoundaryTracker {
  private pending: Omit<BtwSnapshot, "boundary"> | null = null;
  private coherent: BtwSnapshot | null = null;
  private completed = 0;
  constructor(
    pi: Pick<ExtensionAPI, "on" | "getSettings" | "getThinkingLevel">,
    onComplete: (
      snapshot: BtwSnapshot,
      ctx: ExtensionContext,
    ) => Promise<void> = async () => {},
  ) {
    pi.on("session_start", () => {
      this.pending = null;
      this.coherent = null;
      this.completed = 0;
    });
    pi.on("session_tree", () => {
      this.pending = null;
    });
    pi.on("context_with_system", (event, ctx) => {
      if (!ctx.model) return;
      this.pending = structuredClone({
        messages: convertToLlm(event.messages),
        model: ctx.model,
        request: requestSettings(pi),
        parentSessionId: ctx.sessionManager.getSessionId(),
      });
      return { messages: event.messages };
    });
    pi.on("turn_end", async (event, ctx) => {
      const pending = this.pending;
      this.pending = null;
      if (
        !pending ||
        event.message.role !== "assistant" ||
        event.message.stopReason === "aborted" ||
        event.message.stopReason === "error"
      )
        return;
      const messages = structuredClone([
        ...pending.messages,
        ...convertToLlm([event.message, ...event.toolResults]),
      ]);
      this.completed++;
      this.coherent = {
        ...pending,
        messages,
        boundary: {
          kind: "turn_end",
          parentLeafEntryId:
            event.toolResultEntryIds.at(-1) ?? event.messageEntryId,
          parentTurnIndex: this.completed,
          messageCount: messages.length,
          prefixDigest: digest(messages),
          pinnedAt: new Date().toISOString(),
        },
      };
      await onComplete(this.coherent, ctx);
    });
  }
  restore(snapshot: BtwSnapshot): void {
    this.coherent = structuredClone(snapshot);
    this.completed = snapshot.boundary.parentTurnIndex ?? 0;
  }
  current(ctx: Pick<ExtensionContext, "sessionManager">): BtwSnapshot {
    const snapshot = this.coherent;
    if (
      !snapshot ||
      snapshot.parentSessionId !== ctx.sessionManager.getSessionId()
    )
      throw new BtwError("no_finished_turn");
    const belongs = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.id === snapshot.boundary.parentLeafEntryId);
    if (!belongs) throw new BtwError("no_finished_turn");
    return structuredClone(snapshot);
  }
  completedTurnsSince(boundary: BtwBoundary): number {
    return Math.max(
      0,
      this.completed - (boundary.parentTurnIndex ?? this.completed),
    );
  }
}
