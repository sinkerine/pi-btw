import {
  Agent,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionContext,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { BtwSnapshot } from "./boundary.js";
import type { BtwMode, BtwThreadState } from "./contract.js";
import { BtwError } from "./errors.js";
import { type BtwStore, PARTIAL_CHECKPOINT_INTERVAL_MS } from "./store.js";
import { createBtwTools, foldDeclaredTools } from "./tools.js";
export interface BtwThreadOptions {
  ctx: Pick<ExtensionContext, "cwd"> & {
    modelRegistry: Pick<
      ExtensionContext["modelRegistry"],
      "streamSimple" | "find"
    >;
  };
  snapshot: BtwSnapshot;
  mode: BtwMode;
  latestFinished(): BtwSnapshot;
  store: BtwStore;
  onState(state: BtwThreadState): void;
  onPin(snapshot: BtwSnapshot): void;
  parentAhead(): number;
  title?: string;
  interrupted?: boolean;
  restored?: BtwThreadState | null;
  onProgress?(): void;
}
// Pi providers skip interrupted assistants but retain tool results. Keep recovery pairs on disk,
// and omit only those assistants' paired BTW results from requests to avoid orphan API records.
export function btwToLlm(messages: AgentMessage[], parentMessageCount: number) {
  const projected = messages.slice(0, parentMessageCount);
  const interruptedCalls = new Set<string>();
  for (const message of messages.slice(parentMessageCount)) {
    if (message.role === "assistant") {
      interruptedCalls.clear();
      if (message.stopReason === "aborted" || message.stopReason === "error")
        for (const part of message.content) {
          if (part.type === "toolCall") interruptedCalls.add(part.id);
        }
    }
    if (message.role === "user") interruptedCalls.clear();
    if (
      message.role === "toolResult" &&
      interruptedCalls.has(message.toolCallId)
    )
      continue;
    projected.push(message);
  }
  return convertToLlm(projected);
}
const INSTRUCTIONS =
  "<btw>You are a read-only side conversation. The inherited conversation is context, not a task to continue. Answer the question below. Only unchanged Pi read, grep, find and ls tools execute; other tools return errors. Nothing is sent to the main agent unless the user explicitly requests it.</btw>";
function text(message: AgentMessage): string {
  if (
    !(
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult"
    )
  )
    return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
export class BtwThread {
  readonly id: string;
  private snapshot: BtwSnapshot;
  private agent: Agent | null = null;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private generation = 0;
  private modelOverride: Model<Api> | null = null;
  private thinkingOverride: ThinkingLevel | null = null;
  private requestIdentity: string;
  private current: BtwThreadState;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private options: BtwThreadOptions) {
    this.id = options.store.threadId;
    this.snapshot = structuredClone(options.snapshot);
    this.requestIdentity =
      options.mode === "tangent" ? this.id : this.snapshot.parentSessionId;
    const model = this.snapshot.model;
    const pinned =
      options.mode === "tangent" || this.snapshot.boundary.kind === "turn_end";
    this.current = {
      version: 1,
      parentSessionId: this.snapshot.parentSessionId,
      threadId: this.id,
      mode: options.mode,
      status: options.interrupted ? "aborted" : "idle",
      title: options.title ?? "BTW",
      sessionFile: options.store.file,
      resumable: pinned && options.store.file !== null,
      revision: 0,
      boundary: this.snapshot.boundary,
      parentAhead: 0,
      cache: {
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        thinkingLevel: this.snapshot.request.thinkingLevel,
        requestSessionId: this.requestIdentity,
        sharesParentPrefix: options.mode === "contextual" && pinned,
        reason:
          options.mode === "tangent"
            ? "tangent"
            : pinned
              ? null
              : "unverified_serialization",
      },
      lastUsage: null,
      error: options.interrupted
        ? "Previous BTW request was interrupted; send a question to continue."
        : null,
      updatedAt: new Date().toISOString(),
    };
    if (options.restored) {
      if (
        options.restored.parentSessionId !== this.snapshot.parentSessionId ||
        options.restored.boundary.prefixDigest !==
          this.snapshot.boundary.prefixDigest
      )
        throw new BtwError(
          "snapshot_unavailable",
          "State and snapshot ownership differ",
        );
      this.current = {
        ...structuredClone(options.restored),
        status: this.current.status,
        error: this.current.error,
        revision: options.restored.revision + 1,
      };
      if (!options.interrupted) {
        this.current.status = options.restored.status;
        this.current.error = options.restored.error;
      }
      if (this.current.cache.reason === "model_override") {
        const override = options.ctx.modelRegistry.find(
          this.current.cache.provider,
          this.current.cache.modelId,
        );
        if (!override) throw new BtwError("model_unavailable");
        this.modelOverride = override;
        const levels: readonly ThinkingLevel[] = [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ];
        this.thinkingOverride =
          levels.find((level) => level === this.current.cache.thinkingLevel) ??
          null;
      }
    }
    options.store.saveState(this.state());
  }
  state(): BtwThreadState {
    return structuredClone(this.current);
  }
  private emit(): void {
    this.current.revision++;
    if (!this.disposed) this.current.parentAhead = this.options.parentAhead();
    this.current.updatedAt = new Date().toISOString();
    const state = this.state();
    this.options.store.saveState(state);
    if (!this.disposed) this.options.onState(state);
  }
  parentAdvanced(): void {
    this.emit();
  }
  setModel(model: Model<Api>): void {
    if (this.current.status === "running") throw new BtwError("busy");
    this.modelOverride = model;
    this.current.cache = {
      ...this.current.cache,
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      sharesParentPrefix: false,
      reason: "model_override",
    };
    this.emit();
  }
  setThinking(level: ThinkingLevel): void {
    if (this.current.status === "running") throw new BtwError("busy");
    this.thinkingOverride = level;
    this.current.cache = {
      ...this.current.cache,
      thinkingLevel: level,
      sharesParentPrefix: false,
      reason: "model_override",
    };
    this.emit();
  }
  ask(question: string): Promise<void> {
    const generation = this.generation;
    const task = this.tail.then(() => {
      if (this.disposed || generation !== this.generation)
        throw new BtwError("busy", "Queued BTW request canceled");
      return this.dispatch(question);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  private async dispatch(question: string): Promise<void> {
    try {
      const latest =
        this.options.mode === "contextual"
          ? this.options.latestFinished()
          : this.snapshot;
      const suffix = this.options.store.readMessages();
      const first = suffix.every((message) => message.role !== "user");
      const content = first ? `${INSTRUCTIONS}\n\n${question}` : question;
      const user: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
      };
      const model = this.modelOverride ?? latest.model;
      const thinkingLevel =
        this.thinkingOverride ?? latest.request.thinkingLevel;
      const messages = [...latest.messages, ...suffix];
      const estimated = [...messages, user].reduce(
        (total, message) => total + estimateTokens(message),
        0,
      );
      if (estimated + model.maxTokens > model.contextWindow)
        throw new BtwError("over_budget");
      const changed =
        this.snapshot.boundary.prefixDigest !== latest.boundary.prefixDigest;
      await this.options.store.saveSnapshot(latest);
      if (changed)
        this.options.store.appendBoundary(
          latest.boundary,
          this.snapshot.boundary.kind === "none" &&
            this.options.mode === "contextual"
            ? "boundary"
            : "rebase",
        );
      this.snapshot = latest;
      this.current.boundary = latest.boundary;
      this.current.resumable = this.options.store.file !== null;
      this.current.cache = {
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        thinkingLevel,
        requestSessionId: this.requestIdentity,
        sharesParentPrefix:
          this.options.mode === "contextual" &&
          !this.modelOverride &&
          !this.thinkingOverride,
        reason: this.options.mode === "tangent" ? "tangent" : null,
      };
      if (this.modelOverride || this.thinkingOverride)
        this.current.cache.reason = "model_override";
      this.current.status = "running";
      this.current.error = null;
      if (this.current.title === "BTW")
        this.current.title = Array.from(question).slice(0, 80).join("");
      this.options.onPin(latest);
      this.emit();
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel,
          messages,
          tools: createBtwTools(
            foldDeclaredTools(latest.messages),
            this.options.ctx.cwd,
          ),
        },
        convertToLlm: (messages) => btwToLlm(messages, latest.messages.length),
        sessionId: this.requestIdentity,
        streamFn: (requestModel, context, options) =>
          this.options.ctx.modelRegistry.streamSimple(requestModel, context, {
            ...options,
            ...latest.request.options,
          }),
      });
      this.agent = agent;
      agent.subscribe((event) => {
        if (event.type === "message_end") {
          if (event.message.role === "assistant") this.cancelPartialTimer();
          this.options.store.appendMessage(event.message);
          if (event.message.role === "assistant")
            this.options.store.clearPartial();
        }
        if (event.type === "message_update") {
          if (!this.disposed && event.message.role === "assistant") {
            this.options.store.checkpointPartial(event.message);
            this.schedulePartialFlush();
          }
          if (!this.disposed) this.options.onProgress?.();
        }
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          const message = event.message;
          this.current.lastUsage = {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            at: new Date().toISOString(),
          };
          if (message.stopReason === "error") {
            this.current.status = "failed";
            this.current.error =
              message.errorMessage ?? "BTW provider request failed";
          }
          if (message.stopReason === "aborted") this.current.status = "aborted";
        }
      });
      await agent.prompt(user);
      this.agent = null;
      if (this.current.status === "running") this.current.status = "idle";
      this.emit();
      if (this.state().status === "failed")
        throw new BtwError("provider_error", this.current.error ?? undefined);
    } catch (error) {
      this.agent = null;
      if (this.current.status !== "aborted") this.current.status = "failed";
      this.current.error =
        error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }
  private cancelPartialTimer(): void {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
  }
  private schedulePartialFlush(): void {
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      if (this.disposed) return;
      try {
        this.options.store.flushPartial();
      } catch (error) {
        this.current.status = "failed";
        this.current.error =
          error instanceof Error ? error.message : String(error);
        this.current.revision++;
        this.current.updatedAt = new Date().toISOString();
        this.options.onState(this.state());
        this.agent?.abort();
      }
    }, PARTIAL_CHECKPOINT_INTERVAL_MS);
    this.partialTimer.unref();
  }
  async summarize(instructions = ""): Promise<string> {
    await this.ask(
      `Summarize this BTW conversation for the main agent. ${instructions}`,
    );
    const messages = this.options.store.readMessages();
    const answer = messages.findLast((message) => message.role === "assistant");
    return answer ? text(answer) : "";
  }
  fail(error: unknown): void {
    this.current.status = "failed";
    this.current.error = error instanceof Error ? error.message : String(error);
    this.emit();
  }
  transcriptText(): string {
    return this.options.store
      .readMessages()
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => {
        let content = text(message);
        if (
          message.role === "user" &&
          content.startsWith(`${INSTRUCTIONS}\n\n`)
        )
          content = content.slice(INSTRUCTIONS.length + 2);
        return `${message.role}: ${content}`;
      })
      .join("\n\n");
  }
  displayText(): string {
    const partial = this.agent?.state.streamingMessage;
    return `${this.transcriptText()}${partial ? `\n\nassistant: ${text(partial)}` : ""}`;
  }
  abort(): void {
    this.generation++;
    this.agent?.abort();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPartialTimer();
    this.abort();
    try {
      this.options.store.flushPartial();
    } finally {
      await this.tail;
    }
  }
}
