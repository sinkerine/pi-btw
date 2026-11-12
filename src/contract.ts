export const BTW_CONTRACT_VERSION = 1 as const;
export const BTW_THREAD_CHANNEL = "pi-btw:thread" as const;
export const BTW_SYNC_CHANNEL = "pi-btw:sync" as const;
export type BtwMode = "contextual" | "tangent";
export type BtwStatus = "idle" | "running" | "failed" | "aborted";
export interface BtwBoundary {
  kind: "turn_end" | "none";
  parentLeafEntryId: string | null;
  parentTurnIndex: number | null;
  messageCount: number;
  prefixDigest: string;
  pinnedAt: string;
}
export interface BtwCacheIdentity {
  provider: string;
  modelId: string;
  api: string;
  thinkingLevel: string;
  requestSessionId: string;
  sharesParentPrefix: boolean;
  reason: "model_override" | "tangent" | "unverified_serialization" | null;
}
export interface BtwUsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  at: string;
}
export interface BtwThreadState {
  version: typeof BTW_CONTRACT_VERSION;
  parentSessionId: string;
  threadId: string;
  mode: BtwMode;
  status: BtwStatus;
  title: string;
  sessionFile: string | null;
  resumable: boolean;
  revision: number;
  boundary: BtwBoundary;
  parentAhead: number;
  cache: BtwCacheIdentity;
  lastUsage: BtwUsageSample | null;
  error: string | null;
  updatedAt: string;
}
export type BtwThreadEvent =
  | { type: "state"; thread: BtwThreadState }
  | {
      type: "closed";
      version: 1;
      parentSessionId: string;
      threadId: string;
      reason: "cleared" | "replaced";
    };
