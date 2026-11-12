# Host contract v1

Import types and constants from `@sinkerine/pi-btw/contract` (`src/contract.ts`). Hosts run a bridge inside the same Pi extension runtime. Listen to `pi-btw:thread` **before** emitting `pi-btw:sync`. Sync re-emits the existing state at the same revision and makes no model call, file append or new conversation. A late/reconnected host may repeat sync; deduplicate by parent session, thread id and revision.

```ts
pi.events.on("pi-btw:thread", (event) => {
  // Validate before forwarding across your IPC boundary.
});
pi.events.emit("pi-btw:sync", {});
```

Events:

- `{ type: "state", thread: BtwThreadState }`
- `{ type: "closed", version: 1, parentSessionId, threadId, reason: "cleared" | "replaced" }`

`BtwThreadState.version` is `1`. All state fields are required: native parent/session ownership, thread id, contextual/tangent mode, idle/running/failed/aborted status, title (first question, at most 80 characters), nullable child `sessionFile`, `resumable`, monotonic `revision`, boundary, `parentAhead`, cache identity, nullable last usage/error, and ISO `updatedAt`. Types in `src/contract.ts` own the complete field definitions. Restoration preserves revision monotonicity. An interrupted running thread restores aborted without resubmitting its question. Its private `partial.json` checkpoint is separate from the followed timeline and is recovered into JSONL once before state is announced. Updates coalesce every 250 ms after the first content, so a hard crash may lose the latest tail within that interval plus scheduling/disk latency. Completed messages and graceful aborts flush the final content. Recovered incomplete tool batches receive missing error results; they are never replayed.

The boundary identifies the selected completed model turn through native leaf entry id, turn index, message count, SHA256 prefix digest and pin time. Tangent has `kind: "none"` and nullable turn/leaf ids. Empty contextual commands also emit an idle thread before any completed parent turn exists: its boundary has `kind: "none"`, null turn/leaf ids and zero messages, with `sharesParentPrefix: false`, `reason: "unverified_serialization"` and `resumable: false`. This draft has an empty timeline but no saved snapshot or parent thread index; it does not survive restart. Its first explicit question must obtain a real completed boundary or fail with `no_finished_turn`. A successful pin enables persistence for a persistent parent. A running answer keeps its boundary even if main advances; `parentAhead` reports completed turns since that pin. The next contextual question selects the latest finished boundary when dispatched.

Cache identity names provider/model/API, thinking level, request session id, prefix-sharing expectation and reason. Last usage is provider-reported `input`, `output`, `cacheRead`, `cacheWrite` plus its timestamp. Prefix-sharing expectation is not a measured cache-hit guarantee.

## Child timeline

A persistent thread's `sessionFile` names the Pi-compatible `thread.jsonl` under `<agentDir>/btw/sessions/<parentSessionId>/<threadId>/`. It contains a current Pi session header, append-only structured BTW `message` entries with ids/parent ids, and `pi-btw/boundary` / `pi-btw/rebase` custom references. It excludes inherited parent messages and snapshot JSON. Follow **only** this file for the visible timeline; never read the digest-named snapshot as chat.

Keep a long-lived file offset across idle → running → idle. Apply read budgets per poll, rather than imposing a lifetime item cap. A new file identity/thread generation resets the reader explicitly. Clear/replacement removes it. In-memory parents report `sessionFile: null, resumable: false`; they emit status but have no persistent file to follow.

BTW emits state when an answer starts, completes/fails/aborts, the parent advances, or settings change. Token deltas render locally in the TUI; they are not forwarded as contract state events. Tool calls/results persist as completed messages. Plain RPC mode does not notify answer content. `/btw:status` sends a JSON status notification for diagnostics; hosts use events for normal operation.

## Command dispatch and failure

Send the documented slash commands through Pi RPC `prompt`, as JSON string values. Pi handles registered extension commands immediately while the parent streams; do not abort or steer main first. Command handlers admit BTW work and acknowledge without awaiting its generation, allowing Stop and Clear to arrive before a held provider response finishes. RPC success means command admission, not successful generation or delivery. Observe the corresponding failed/idle state; do not automatically retry ambiguous requests.

Empty `/btw`, `/side`, `/btw:new` and `/btw:tangent` commands open an idle composer without a provider request. New emits a replaced close for the previous thread followed by the new idle state; Clear emits removal only. Existing aliases reopen the current thread. BTW asks queue within one active thread. Clear/replacement/shutdown abort and dispose old work; late queued tasks cannot emit replacement state or inject into main. Parent cancellation alone does not cancel BTW. Only Inject and Summarize call `sendUserMessage`; busy parents receive one `followUp`. Duplicate delivery actions are refused while a delivery is pending. An empty thread rejects Inject and Summarize without a model request or main delivery. Summarize forwards only its own completed, non-empty answer; Stop cancels active and queued summaries without forwarding previous or partial answers, and keeps canceled state. Provider failures remain failed. Neither hide, reconnect nor Clear forwards anything.

A host validates version, schema, native owner, revision and extension-owned child file identity. Unknown/malformed state must be dropped with a bounded warning. Failed status keeps the composer usable; error text explains retry or a new thread. Snapshot corruption refuses continuation and surfaces `snapshot_unavailable` rather than reconstructing context. An unsupported version is not a valid v1 state.
