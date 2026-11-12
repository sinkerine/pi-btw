export type BtwErrorCode =
  | "no_finished_turn"
  | "busy"
  | "over_budget"
  | "tool_unavailable"
  | "no_thread"
  | "model_unavailable"
  | "provider_error"
  | "snapshot_unavailable"
  | "unsupported_serialization";
const messages: Record<BtwErrorCode, string> = {
  no_finished_turn:
    "No finished parent turn captured on this branch. Finish a parent turn or use /btw:tangent.",
  busy: "BTW is busy. Stop it before changing its settings.",
  over_budget:
    "BTW exceeds the model context budget. Use /btw:new to drop the BTW history or /btw:tangent.",
  tool_unavailable:
    "BTW only executes unchanged Pi read, grep, find and ls tools. Ask the main agent to make changes.",
  no_thread: "No BTW thread. Use /btw <question> or /btw:tangent.",
  model_unavailable:
    "Select an available model with /btw:model provider/model.",
  provider_error: "BTW provider request failed. Retry your question.",
  snapshot_unavailable:
    "The exact BTW snapshot is missing or corrupt. Continuation refused; use /btw:new after a new parent turn.",
  unsupported_serialization:
    "BTW cannot preserve the parent's request settings for this transport.",
};
export class BtwError extends Error {
  constructor(
    readonly code: BtwErrorCode,
    detail?: string,
  ) {
    super(`${code}: ${messages[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "BtwError";
  }
}
