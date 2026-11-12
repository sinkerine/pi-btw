import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BtwSnapshot } from "./boundary.js";
import type {
  BtwBoundary,
  BtwCacheIdentity,
  BtwMode,
  BtwThreadState,
} from "./contract.js";
import { digest } from "./digest.js";
import { BtwError } from "./errors.js";
export const PARTIAL_CHECKPOINT_INTERVAL_MS = 250;
export interface BtwThreadIndex {
  parentSessionId: string;
  threadId: string;
  sessionFile: string | null;
  mode: BtwMode;
  boundary: BtwBoundary;
  cache: BtwCacheIdentity;
}
function privateDirectory(path: string): void {
  if (!existsSync(path)) {
    privateDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
  }
}
function atomic(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validBoundary(value: unknown): value is BtwBoundary {
  if (!record(value)) return false;
  const turn =
    value.parentTurnIndex === null ||
    (Number.isSafeInteger(value.parentTurnIndex) &&
      Number(value.parentTurnIndex) >= 1);
  return (
    ["turn_end", "none"].includes(String(value.kind)) &&
    (value.parentLeafEntryId === null ||
      typeof value.parentLeafEntryId === "string") &&
    turn &&
    Number.isSafeInteger(value.messageCount) &&
    Number(value.messageCount) >= 0 &&
    typeof value.prefixDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.prefixDigest) &&
    typeof value.pinnedAt === "string" &&
    Number.isFinite(Date.parse(value.pinnedAt))
  );
}
function validCache(value: unknown): value is BtwCacheIdentity {
  return (
    record(value) &&
    ["provider", "modelId", "api", "thinkingLevel", "requestSessionId"].every(
      (key) => typeof value[key] === "string",
    ) &&
    typeof value.sharesParentPrefix === "boolean" &&
    (value.reason === null ||
      ["model_override", "tangent", "unverified_serialization"].includes(
        String(value.reason),
      ))
  );
}
function validIndex(value: unknown): value is BtwThreadIndex {
  return (
    record(value) &&
    typeof value.parentSessionId === "string" &&
    typeof value.threadId === "string" &&
    /^[a-f0-9-]+$/.test(value.threadId) &&
    (value.sessionFile === null || typeof value.sessionFile === "string") &&
    ["contextual", "tangent"].includes(String(value.mode)) &&
    validBoundary(value.boundary) &&
    validCache(value.cache)
  );
}
function snapshotFromJson(text: string, expected?: string): BtwSnapshot {
  try {
    const snapshot: BtwSnapshot = JSON.parse(text);
    const valid =
      snapshot &&
      Array.isArray(snapshot.messages) &&
      snapshot.messages.every(
        (message) =>
          record(message) &&
          ["system", "user", "assistant", "toolResult"].includes(
            String(message.role),
          ),
      ) &&
      snapshot.model &&
      typeof snapshot.model.id === "string" &&
      typeof snapshot.model.provider === "string" &&
      typeof snapshot.model.api === "string" &&
      typeof snapshot.model.baseUrl === "string" &&
      Number.isFinite(snapshot.model.contextWindow) &&
      Number.isFinite(snapshot.model.maxTokens) &&
      snapshot.request &&
      record(snapshot.request.options) &&
      typeof snapshot.parentSessionId === "string" &&
      validBoundary(snapshot.boundary) &&
      snapshot.boundary.messageCount === snapshot.messages.length &&
      digest(snapshot.messages) === snapshot.boundary.prefixDigest;
    if (!valid || (expected && expected !== snapshot.boundary.prefixDigest))
      throw new Error("snapshot digest mismatch");
    return snapshot;
  } catch (error) {
    throw new BtwError(
      "snapshot_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}
export class BtwStore {
  readonly file: string | null;
  private messages: AgentMessage[] = [];
  private snapshots = new Map<string, BtwSnapshot>();
  private leaf: string | null = null;
  private savedState: BtwThreadState | null = null;
  private partialWrittenAt = -Infinity;
  private pendingPartial: AssistantMessage | null = null;
  private constructor(
    private directory: string | null,
    readonly threadId: string,
    private parentSessionId: string,
    cwd: string,
  ) {
    this.file = directory ? join(directory, "thread.jsonl") : null;
    if (!this.file) return;
    privateDirectory(dirname(this.file));
    if (!existsSync(this.file)) {
      writeFileSync(
        this.file,
        `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: threadId, timestamp: new Date().toISOString(), cwd })}\n`,
        { mode: 0o600 },
      );
      return;
    }
    try {
      const lines = readFileSync(this.file, "utf8").trim().split("\n");
      const header = JSON.parse(lines.shift() ?? "{}");
      if (
        header.type !== "session" ||
        header.id !== threadId ||
        header.version !== CURRENT_SESSION_VERSION
      )
        throw new Error("invalid child header");
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.parentId !== this.leaf || typeof entry.id !== "string")
          throw new Error("invalid child ancestry");
        this.leaf = entry.id;
        if (entry.type === "message") {
          if (
            !["user", "assistant", "toolResult", "system"].includes(
              entry.message?.role,
            )
          )
            throw new Error("invalid child message");
          this.messages.push(entry.message);
        }
      }
    } catch (error) {
      throw new BtwError(
        "snapshot_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  static open(
    ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
    threadId: string,
    parentFile: string | undefined,
  ): BtwStore {
    const directory = parentFile
      ? join(
          getAgentDir(),
          "btw",
          "sessions",
          ctx.sessionManager.getSessionId(),
          threadId,
        )
      : null;
    return new BtwStore(
      directory,
      threadId,
      ctx.sessionManager.getSessionId(),
      ctx.cwd,
    );
  }
  static resume(
    ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
    index: BtwThreadIndex,
  ): BtwStore {
    const expected = join(
      getAgentDir(),
      "btw",
      "sessions",
      ctx.sessionManager.getSessionId(),
      index.threadId,
      "thread.jsonl",
    );
    if (
      index.parentSessionId !== ctx.sessionManager.getSessionId() ||
      index.sessionFile !== expected ||
      !existsSync(expected)
    )
      throw new BtwError(
        "snapshot_unavailable",
        "Missing or foreign thread file",
      );
    return BtwStore.open(
      ctx,
      index.threadId,
      ctx.sessionManager.getSessionFile(),
    );
  }
  checkpointPartial(message: AssistantMessage, now = performance.now()): void {
    const hasContent = message.content.some(
      (part) =>
        (part.type === "text" && part.text.length > 0) ||
        (part.type === "thinking" && part.thinking.length > 0) ||
        (part.type === "toolCall" && part.id.length > 0),
    );
    if (!hasContent || !this.directory) return;
    this.pendingPartial = structuredClone(message);
    if (now - this.partialWrittenAt >= PARTIAL_CHECKPOINT_INTERVAL_MS)
      this.flushPartial(now);
  }
  flushPartial(now = performance.now()): void {
    if (!this.directory || !this.pendingPartial) return;
    atomic(join(this.directory, "partial.json"), {
      threadId: this.threadId,
      parentSessionId: this.parentSessionId,
      messageOffset: this.messages.length,
      message: this.pendingPartial,
    });
    this.pendingPartial = null;
    this.partialWrittenAt = now;
  }
  clearPartial(): void {
    this.pendingPartial = null;
    this.partialWrittenAt = -Infinity;
    if (!this.directory) return;
    const path = join(this.directory, "partial.json");
    if (existsSync(path)) unlinkSync(path);
  }
  recoverInterrupted(): void {
    if (!this.directory) return;
    const path = join(this.directory, "partial.json");
    if (existsSync(path)) {
      try {
        const partial: {
          threadId: string;
          parentSessionId: string;
          messageOffset: number;
          message: AssistantMessage;
        } = JSON.parse(readFileSync(path, "utf8"));
        const valid =
          partial &&
          partial.threadId === this.threadId &&
          partial.parentSessionId === this.parentSessionId &&
          Number.isSafeInteger(partial.messageOffset) &&
          partial.messageOffset >= 0 &&
          partial.messageOffset <= this.messages.length &&
          partial.message?.role === "assistant" &&
          Array.isArray(partial.message.content);
        if (!valid) throw new Error("Invalid interrupted assistant checkpoint");
        if (partial.messageOffset === this.messages.length)
          this.appendMessage({
            ...partial.message,
            stopReason: "aborted",
            errorMessage:
              "BTW interrupted by process exit; send a new question to continue.",
          });
        else if (this.messages[partial.messageOffset]?.role !== "assistant")
          throw new Error(
            "Interrupted assistant offset does not match the transcript",
          );
      } catch (error) {
        throw new BtwError(
          "snapshot_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const pending = new Map<string, ToolCall>();
    for (const message of this.messages) {
      if (message.role === "assistant")
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          if (!content.id || !content.name)
            throw new BtwError(
              "snapshot_unavailable",
              "Interrupted tool call has no stable identity",
            );
          pending.set(content.id, content);
        }
      if (message.role === "toolResult") pending.delete(message.toolCallId);
    }
    for (const call of pending.values())
      this.appendMessage({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        content: [
          {
            type: "text",
            text: "BTW process exited before this tool result was persisted. The tool is not replayed.",
          },
        ],
        timestamp: Date.now(),
      });
    this.clearPartial();
  }
  saveState(state: BtwThreadState): void {
    this.savedState = structuredClone(state);
    if (this.directory) atomic(join(this.directory, "state.json"), state);
  }
  readState(): BtwThreadState | null {
    if (!this.directory) return structuredClone(this.savedState);
    try {
      const state: BtwThreadState = JSON.parse(
        readFileSync(join(this.directory, "state.json"), "utf8"),
      );
      const valid =
        state &&
        state.version === 1 &&
        state.threadId === this.threadId &&
        state.sessionFile === this.file &&
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        typeof state.title === "string" &&
        ["idle", "running", "failed", "aborted"].includes(state.status) &&
        validBoundary(state.boundary) &&
        validCache(state.cache);
      if (!valid) throw new Error("Invalid persisted BTW state");
      return state;
    } catch (error) {
      throw new BtwError(
        "snapshot_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  private append(entry: object): void {
    const id = randomUUID().slice(0, 8);
    if (this.file)
      appendFileSync(
        this.file,
        `${JSON.stringify({ ...entry, id, parentId: this.leaf, timestamp: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    this.leaf = id;
  }
  appendMessage(message: AgentMessage): void {
    this.append({ type: "message", message });
    this.messages.push(structuredClone(message));
  }
  appendBoundary(boundary: BtwBoundary, kind: "boundary" | "rebase"): void {
    this.append({
      type: "custom",
      customType: `pi-btw/${kind}`,
      data: boundary,
    });
  }
  readMessages(): AgentMessage[] {
    return structuredClone(this.messages);
  }
  async saveSnapshot(snapshot: BtwSnapshot): Promise<string | null> {
    this.snapshots.set(
      snapshot.boundary.prefixDigest,
      structuredClone(snapshot),
    );
    if (!this.directory) return null;
    const path = join(this.directory, `${snapshot.boundary.prefixDigest}.json`);
    if (!existsSync(path)) atomic(path, snapshot);
    return path;
  }
  async loadSnapshot(prefixDigest: string): Promise<BtwSnapshot> {
    const memory = this.snapshots.get(prefixDigest);
    if (memory) return structuredClone(memory);
    if (!this.directory || !/^[a-f0-9]{64}$/.test(prefixDigest))
      throw new BtwError("snapshot_unavailable");
    try {
      return snapshotFromJson(
        readFileSync(join(this.directory, `${prefixDigest}.json`), "utf8"),
        prefixDigest,
      );
    } catch (error) {
      throw new BtwError(
        "snapshot_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
export function latestThreadIndex(
  branch: readonly SessionEntry[],
  owner: string,
): BtwThreadIndex | null {
  let index: BtwThreadIndex | null = null;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (!record(entry.data) || entry.data.parentSessionId !== owner) continue;
    if (entry.customType === "pi-btw/clear") index = null;
    if (entry.customType === "pi-btw/thread") {
      if (!validIndex(entry.data))
        throw new BtwError("snapshot_unavailable", "Invalid thread index");
      index = entry.data;
    }
  }
  return index;
}
export function saveCheckpoint(
  snapshot: BtwSnapshot,
  ctx: Pick<ExtensionContext, "sessionManager">,
): void {
  if (!ctx.sessionManager.getSessionFile()) return;
  const directory = join(
    getAgentDir(),
    "btw",
    "sessions",
    snapshot.parentSessionId,
  );
  atomic(join(directory, "latest.json"), snapshot);
  // Selected snapshots live in thread directories; replacing this checkpoint bounds parent history copies.
}
export function loadCheckpoint(
  ctx: Pick<ExtensionContext, "sessionManager">,
): BtwSnapshot | null {
  if (!ctx.sessionManager.getSessionFile()) return null;
  const path = join(
    getAgentDir(),
    "btw",
    "sessions",
    ctx.sessionManager.getSessionId(),
    "latest.json",
  );
  if (!existsSync(path)) return null;
  const snapshot = snapshotFromJson(readFileSync(path, "utf8"));
  const active = ctx.sessionManager
    .getBranch()
    .some((entry) => entry.id === snapshot.boundary.parentLeafEntryId);
  return snapshot.parentSessionId === ctx.sessionManager.getSessionId() &&
    active
    ? snapshot
    : null;
}
