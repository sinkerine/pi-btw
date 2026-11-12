import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BoundaryTracker, type BtwSnapshot } from "./boundary.js";
import {
  BTW_SYNC_CHANNEL,
  BTW_THREAD_CHANNEL,
  type BtwMode,
  type BtwThreadState,
} from "./contract.js";
import { digest } from "./digest.js";
import { BtwError } from "./errors.js";
import { requestSettings } from "./request.js";
import {
  BtwStore,
  latestThreadIndex,
  loadCheckpoint,
  saveCheckpoint,
} from "./store.js";
import { BtwThread } from "./thread.js";
import { BtwOverlay } from "./tui/overlay.js";
export const COMMANDS = [
  "btw",
  "side",
  "btw:new",
  "btw:tangent",
  "btw:abort",
  "btw:inject",
  "btw:summarize",
  "btw:clear",
  "btw:model",
  "btw:thinking",
  "btw:status",
] as const;
export class BtwCommands {
  private tracker: BoundaryTracker;
  private thread: BtwThread | null = null;
  private store: BtwStore | null = null;
  private restoreError: Error | null = null;
  private generation = 0;
  private deliveryPending = false;
  private composerMode: BtwMode = "contextual";
  private rerender: (() => void) | null = null;
  private dismiss: (() => void) | null = null;
  constructor(private pi: ExtensionAPI) {
    this.tracker = new BoundaryTracker(pi, async (snapshot, ctx) => {
      saveCheckpoint(snapshot, ctx);
      this.restoreError = null;
      this.thread?.parentAdvanced();
    });
    pi.on("session_start", async (_event, ctx) => {
      await this.restore(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      try {
        await this.restore(ctx, true);
      } catch (error) {
        await this.close("replaced");
        this.restoreError =
          error instanceof Error ? error : new Error(String(error));
        this.notice(ctx, this.restoreError);
      }
    });
    pi.on("session_shutdown", async () => {
      await this.close("replaced");
    });
    pi.events.on(BTW_SYNC_CHANNEL, () => {
      if (this.thread) this.emit(this.thread.state());
    });
    for (const name of COMMANDS)
      pi.registerCommand(name, {
        description: commandDescription(name),
        handler: async (args, ctx) => {
          try {
            await this.run(name, args, ctx);
          } catch (error) {
            this.notice(ctx, error);
          }
        },
      });
  }
  private async restore(ctx: ExtensionContext, tree = false): Promise<void> {
    this.restoreError = null;
    try {
      const checkpoint = loadCheckpoint(ctx);
      if (checkpoint) this.tracker.restore(checkpoint);
      const index = latestThreadIndex(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
      const activeBoundary = this.thread?.state().boundary;
      const sameThread =
        this.thread &&
        index?.threadId === this.thread.id &&
        index.boundary.prefixDigest === activeBoundary?.prefixDigest;
      const draft =
        this.thread &&
        !index &&
        activeBoundary?.kind === "none" &&
        this.thread.state().parentSessionId ===
          ctx.sessionManager.getSessionId();
      if (sameThread || draft) {
        if (!checkpoint && index?.mode === "contextual" && this.store) {
          const snapshot = await this.store.loadSnapshot(
            index.boundary.prefixDigest,
          );
          this.restoreBoundary(snapshot, ctx);
        }
        // Pi tree navigation changes only the in-memory leaf until an entry is appended.
        if (tree && index) this.pi.appendEntry("pi-btw/thread", index);
        return;
      }
      await this.close("replaced");
      if (!index) return;
      const store = BtwStore.resume(ctx, index);
      const snapshot = await store.loadSnapshot(index.boundary.prefixDigest);
      const saved = store.readState();
      if (!checkpoint && index.mode === "contextual")
        this.restoreBoundary(snapshot, ctx);
      if (
        saved &&
        saved.boundary.prefixDigest !== index.boundary.prefixDigest
      ) {
        // The append-only child suffix moved past this branch's index. Never replay abandoned turns.
        this.pi.appendEntry("pi-btw/clear", {
          parentSessionId: ctx.sessionManager.getSessionId(),
        });
        this.notice(
          ctx,
          new BtwError(
            "no_thread",
            "BTW closed after parent rewind before a rebase; use /btw to start a new thread on this branch",
          ),
        );
        return;
      }
      if (saved?.status === "running") store.recoverInterrupted();
      this.makeThread(
        ctx,
        index.mode,
        snapshot,
        store,
        saved?.status === "running",
        saved,
      );
      if (tree) this.index(snapshot);
      this.emit(this.threadState());
    } catch (error) {
      await this.close("replaced");
      this.restoreError =
        error instanceof Error ? error : new Error(String(error));
      this.notice(ctx, this.restoreError);
    }
  }
  private restoreBoundary(snapshot: BtwSnapshot, ctx: ExtensionContext): void {
    if (
      snapshot.parentSessionId === ctx.sessionManager.getSessionId() &&
      ctx.sessionManager
        .getBranch()
        .some((entry) => entry.id === snapshot.boundary.parentLeafEntryId)
    ) {
      this.tracker.restore(snapshot);
      saveCheckpoint(snapshot, ctx);
    }
  }
  private notice(ctx: ExtensionContext, error: unknown): void {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    this.rerender?.();
  }
  private threadState(): BtwThreadState {
    if (!this.thread) throw new BtwError("no_thread");
    return this.thread.state();
  }
  private emit(state: BtwThreadState): void {
    this.pi.events.emit(BTW_THREAD_CHANNEL, { type: "state", thread: state });
    this.rerender?.();
  }
  private index(snapshot: BtwSnapshot): void {
    if (!this.thread || !this.store) return;
    const state = this.thread.state();
    this.pi.appendEntry("pi-btw/thread", {
      parentSessionId: state.parentSessionId,
      threadId: state.threadId,
      sessionFile: this.store.file,
      mode: state.mode,
      boundary: snapshot.boundary,
      cache: state.cache,
    });
  }
  private makeThread(
    ctx: ExtensionContext,
    mode: BtwMode,
    snapshot: BtwSnapshot,
    store: BtwStore,
    interrupted = false,
    restored: BtwThreadState | null = null,
  ): void {
    this.store = store;
    this.thread = new BtwThread({
      ctx,
      mode,
      snapshot,
      store,
      interrupted,
      restored,
      onProgress: () => this.rerender?.(),
      latestFinished: () => this.tracker.current(ctx),
      parentAhead: () =>
        this.tracker.completedTurnsSince(this.threadState().boundary),
      onState: (state) => this.emit(state),
      onPin: (pin) => this.index(pin),
    });
  }
  private async ensureThread(
    ctx: ExtensionContext,
    mode: BtwMode,
    allowEmpty = false,
  ): Promise<BtwThread> {
    if (this.restoreError) throw this.restoreError;
    if (this.thread) return this.thread;
    if (!ctx.model) throw new BtwError("model_unavailable");
    let snapshot: BtwSnapshot | undefined;
    if (mode === "contextual") {
      try {
        snapshot = this.tracker.current(ctx);
      } catch (error) {
        if (
          !allowEmpty ||
          !(error instanceof BtwError) ||
          error.code !== "no_finished_turn"
        )
          throw error;
      }
    }
    if (mode === "tangent" || !snapshot) {
      // An unpinned contextual composer has no inherited request and is not a resumable snapshot.
      const messages: AgentMessage[] =
        mode === "tangent"
          ? [
              {
                role: "system",
                content:
                  "You answer side questions independently of the main conversation.",
                timestamp: Date.now(),
              },
            ]
          : [];
      snapshot = {
        messages,
        model: ctx.model,
        parentSessionId: ctx.sessionManager.getSessionId(),
        request: requestSettings(this.pi),
        boundary: {
          kind: "none",
          parentLeafEntryId: null,
          parentTurnIndex: null,
          messageCount: messages.length,
          prefixDigest: digest(messages),
          pinnedAt: new Date().toISOString(),
        },
      };
    }
    const store = BtwStore.open(
      ctx,
      randomUUID(),
      ctx.sessionManager.getSessionFile(),
    );
    const pinned = mode === "tangent" || snapshot.boundary.kind === "turn_end";
    if (pinned) {
      await store.saveSnapshot(snapshot);
      store.appendBoundary(snapshot.boundary, "boundary");
    }
    this.makeThread(ctx, mode, snapshot, store);
    if (pinned) this.index(snapshot);
    this.emit(this.threadState());
    if (!this.thread) throw new BtwError("no_thread");
    return this.thread;
  }
  private async close(reason: "replaced" | "cleared"): Promise<void> {
    this.generation++;
    this.deliveryPending = false;
    this.dismiss?.();
    const previous = this.thread;
    this.thread = null;
    this.store = null;
    if (!previous) return;
    await previous.dispose();
    this.pi.events.emit(BTW_THREAD_CHANNEL, {
      type: "closed",
      version: 1,
      parentSessionId: previous.state().parentSessionId,
      threadId: previous.id,
      reason,
    });
  }
  private background(task: Promise<unknown>, ctx: ExtensionContext): void {
    const generation = this.generation;
    void task.catch((error: unknown) => {
      if (generation === this.generation) this.notice(ctx, error);
    });
  }
  private open(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || this.dismiss) return;
    this.background(
      ctx.ui
        .custom<void>(
          (tui, _theme, _keys, done) => {
            this.rerender = () => tui.requestRender();
            this.dismiss = () => done();
            return new BtwOverlay({
              state: () => this.thread?.state() ?? null,
              transcript: () => this.thread?.displayText() ?? "",
              ask: async (question) => {
                const thread = await this.ensureThread(ctx, this.composerMode);
                await thread.ask(question);
              },
              abort: () => this.thread?.abort(),
              dismiss: () => done(),
              render: () => tui.requestRender(),
            });
          },
          {
            overlay: true,
            overlayOptions: {
              width: "85%",
              maxHeight: "70%",
              anchor: "bottom-right",
            },
          },
        )
        .finally(() => {
          this.rerender = null;
          this.dismiss = null;
        }),
      ctx,
    );
  }
  private async deliver(text: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.isIdle()) this.pi.sendUserMessage(text);
    else this.pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
  private async run(
    name: (typeof COMMANDS)[number],
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (name === "btw:clear") {
      await this.close("cleared");
      this.restoreError = null;
      this.pi.appendEntry("pi-btw/clear", {
        parentSessionId: ctx.sessionManager.getSessionId(),
      });
      return;
    }
    if (name === "btw:abort") {
      this.thread?.abort();
      return;
    }
    if (name === "btw:status") {
      ctx.ui.notify(JSON.stringify(this.threadState()), "info");
      return;
    }
    if (name === "btw:new" || name === "btw:tangent") {
      await this.close("replaced");
      this.restoreError = null;
      this.pi.appendEntry("pi-btw/clear", {
        parentSessionId: ctx.sessionManager.getSessionId(),
      });
    }
    if (name === "btw:model" || name === "btw:thinking") {
      if (!this.thread) throw new BtwError("no_thread");
      if (name === "btw:model") {
        const separator = args.indexOf("/");
        if (separator < 1) throw new BtwError("model_unavailable");
        const model = ctx.modelRegistry.find(
          args.slice(0, separator),
          args.slice(separator + 1),
        );
        if (!model) throw new BtwError("model_unavailable");
        this.thread.setModel(model);
      } else {
        const levels: readonly ThinkingLevel[] = [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ];
        const level = levels.find((level) => level === args);
        if (!level)
          throw new BtwError(
            "model_unavailable",
            "Thinking: off, minimal, low, medium, high, xhigh or max",
          );
        this.thread.setThinking(level);
      }
      return;
    }
    if (name === "btw:inject" || name === "btw:summarize") {
      const thread = this.thread;
      if (!thread) throw new BtwError("no_thread");
      if (!thread.transcriptText().trim())
        throw new BtwError(
          "no_thread",
          "BTW is empty; ask a question before sending to main",
        );
      if (this.deliveryPending)
        throw new BtwError("busy", "BTW delivery already pending");
      this.deliveryPending = true;
      const generation = this.generation;
      const task = async () => {
        const content =
          name === "btw:summarize"
            ? await thread.summarize(args)
            : `${thread.transcriptText()}${args ? `\n\nInstructions: ${args}` : ""}`;
        if (generation !== this.generation)
          throw new BtwError("no_thread", "Thread replaced before delivery");
        await this.deliver(content, ctx);
      };
      this.background(
        task()
          .catch((error: unknown) => {
            if (
              generation === this.generation &&
              thread.state().status !== "aborted" &&
              !(error instanceof BtwError && error.code === "busy")
            )
              thread.fail(error);
            throw error;
          })
          .finally(() => {
            if (generation === this.generation) this.deliveryPending = false;
          }),
        ctx,
      );
      return;
    }
    const mode = name === "btw:tangent" ? "tangent" : "contextual";
    this.composerMode = mode;
    if (!args.trim()) {
      await this.ensureThread(ctx, mode, true);
      this.open(ctx);
      return;
    }
    const thread = await this.ensureThread(ctx, mode);
    this.background(thread.ask(args), ctx);
    this.open(ctx);
  }
}
function commandDescription(name: string): string {
  const descriptions: Record<string, string> = {
    btw: "Ask a read-only side question",
    side: "Alias for /btw",
    "btw:new": "Start a new contextual BTW conversation",
    "btw:tangent": "Start an independent side conversation",
    "btw:abort": "Stop only BTW",
    "btw:inject": "Send the BTW transcript to the main agent",
    "btw:summarize": "Summarize BTW and send to main",
    "btw:clear": "Clear the active BTW conversation",
    "btw:model": "Override BTW provider/model",
    "btw:thinking": "Override BTW thinking level",
    "btw:status": "Show BTW status",
  };
  return descriptions[name] ?? name;
}
