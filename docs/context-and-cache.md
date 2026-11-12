# Context and provider cache

BTW captures `context_with_system`, after Pi's `context` transforms. At `turn_end` it appends the completed assistant message and every tool result. The snapshot is the last coherent request boundary; an unanswered parent prompt, partial assistant response or incomplete tool batch never enters it.

Load pi-btw **after** any extension that rewrites `context_with_system`. Ordinary `context` transforms run before this event regardless of extension order. Installing into an existing session cannot recover past request transforms: complete a new parent turn before asking contextually. Cloned/forked session ownership and active-branch ancestry must match; abandoned branch checkpoints do not become context. A tree switch restores only an exact captured checkpoint on the active branch or the active thread’s saved snapshot. Rewinding before a thread rebase closes that thread with a notice; start a new thread on the restored boundary. The old transcript stays on disk but is never injected or continued from the rewound branch.

At each contextual question's dispatch, select the latest completed boundary. Equal boundary digest keeps the inherited prefix and replays the structured side suffix. A changed digest replaces only the inherited snapshot; it retains all side questions, assistant signatures, tool calls and results. A queued question pins when dequeued. Parent compaction affects the next completed boundary, never an answer already running. BTW performs no automatic compaction or arbitrary truncation. Recovery retains a coalesced partial-assistant checkpoint separately from completed JSONL messages, appends it once as aborted, and closes any missing tool results with errors. Pi 1.4's provider adapters omit aborted/error assistants but retain tool results. The worker therefore omits only the paired results of those skipped assistants from the **BTW suffix request projection**. Parent snapshot messages stay untouched, successful/unrelated tool results stay present, and later valid calls may reuse an earlier id. The full recovery pair, text and opaque metadata remain on disk/display. Interrupted calls are never executed again. Its context-budget estimate includes the entire snapshot, tool declarations, BTW suffix, new question and model output reserve.

## Request identity and tool declarations

The worker is a raw `@earendil-works/pi-agent-core` Agent, avoiding AgentSession prompt/resource reconstruction. It uses Pi's converter and `ctx.modelRegistry.streamSimple`. Its executable stubs reproduce the parent's declaration objects so Pi's tool-delta logic sees no change. Only identical read-only built-ins execute. BTW instructions are appended user content, never a changed system prompt.

Contextual requests inherit the boundary's model, thinking level, transport, thinking budgets, provider retry/timeouts, cache retention and Pi client attribution identity. They forward the parent's session id for cache routing while keeping distinct child storage. Tangent has its own request identity and no inherited conversation. Explicit model/thinking overrides mark `sharesParentPrefix: false` and `reason: "model_override"`.

Verified transport: independent SSE for `openai-completions` and `anthropic-messages` under real Pi 1.4.0. `auto` inherits Pi's selected transport; explicit `websocket` or `websocket-cached` is refused because independent shared-session transport state is not proven. Other APIs and arbitrary `before_provider_request`/`before_provider_headers` extension hooks are **not verified**: the raw worker does not run parent extension hooks. Do not treat an untested custom provider transform as cache-equality proof. The provided proof includes an ordinary `context` transformer and built-in provider serialization.

No cache-warming loop, timer, extra idle request, parent fork or parent clone runs. A provider must support independent concurrent requests using the inherited routing key; a provider error is surfaced rather than canceling main.

## What is proved

The capturing HTTP fixtures run the real Pi 1.4.0 process and this extension against local OpenAI-compatible and Anthropic-compatible endpoints. They compare the final serialized request, not an internal transcript approximation:

- Ordered parent messages, followed by the completed assistant/tool results and appended BTW question.
- Equal model, system, loaded tools, output token limit, cache key, affinity headers and client identity.
- Long retention and Anthropic cache-control markers; only movable message-level cache markers are removed for prefix comparison. Tool/system marker objects remain byte-structure equal.
- Same-boundary follow-ups, automatic rebasing, transformed context, parent isolation and blocked writes.

BTW questions use structured text blocks because Anthropic converts a final string message into blocks when attaching a cache marker. Starting with blocks keeps the prefix shape stable when that marker moves on follow-up. Array/key order is retained in persistence; snapshot digests hash insertion-ordered JSON.

Run `PI_BINARY=pi BTW_REPORT_DIR=/absolute/artifacts npm run test:integration`. The prefix tests write per-API reports. A reviewed producer receipt combines them as `prefix-report.json` and records the producer revision/archive digest separately.

## What a cache hit means

Pi exposes provider usage counters (`input`, `cacheRead`, `cacheWrite`), not KV tensors. Equal request prefixes make reuse possible; they do not promise it. Minimum prefix sizes, TTL, retention, upstream account/replica, eviction and routing still apply. The user's Magpie configuration may derive conversation identity from the first message when session-affinity headers are absent. An identical first message preserves that input; counters cannot establish the selected upstream replica.

The isolated live measurement command is:

```sh
node scripts/measure-cache.mjs --out /absolute/artifacts/cache-report.md
```

It uses the configured default provider/model, private temporary copies of `models.json`, `auth.json` and selected settings, no inherited auto-resume extensions, and synthetic public context targeted above 20k tokens. It measures the parent, first BTW, unchanged-boundary follow-up, parent advancement and repin, then dbachelder/pi-btw 0.8.1 at commit `374465f0a2bd3df502c4f981405e61567d92046b` on a copy of the same parent session. The baseline checkout is read from `.fixtures/dbachelder-pi-btw-374465f`; `.fixtures/baseline-provenance.json` must name the exact commit and downloaded archive SHA256. It never installs, publishes or probes auth.

A live run on 2026-11-12 used Pi 1.4.0, `magpie/gpt-6.1-sol` through `openai-completions`, and a 91,793-byte synthetic context (about 23k tokens). Pi reported:

| Request                      | uncached input | cacheRead | cacheWrite | elapsed ms |
| ---------------------------- | -------------: | --------: | ---------: | ---------: |
| Parent last request          |         23,354 |         0 |          0 |      2,041 |
| BTW question 1               |            276 |    23,168 |          0 |      3,803 |
| Unchanged-boundary follow-up |            185 |    23,296 |          0 |      2,417 |
| Parent advanced              |            220 |    23,168 |          0 |      1,972 |
| BTW after repin              |            268 |    23,296 |          0 |      1,864 |
| dbachelder 0.8.1 question 1  |         19,133 |     4,480 |          0 |      5,109 |

These are Pi-normalized usage counters. Raw provider field availability and upstream routing were not exposed. First BTW reads 23,168 cached tokens versus the parent's **total input** of 23,354 (uncached input + cacheRead + cacheWrite). The follow-up reads 23,296 versus the first BTW's total input of 23,444. Substantial reuse is observed; full-prefix token coverage is not established, and cache-block granularity and token provenance remain unknown. The baseline's 4,480 cached tokens cannot be attributed specifically to the parent. H1–H4 remain inconclusive at that stricter causal level; no serialization assertion or numeric cache threshold was weakened. A first measurement failed on the baseline fixture's assumed filename; its report is preserved separately, and the successful comparison reads Pi's actual runtime session path.

The run's `cache-report.md` owns the full raw Pi samples, settings/context digests, execution order, elapsed times, failures and H1–H4 assessments. Parent first-token time comes from RPC text deltas. Child first-token timing is unavailable in contract v1 and is recorded as unknown; completion latency is measured. Unknown usage counters stay unknown. A provider failure is evidence, never a cache success or an auth skip. There is no numeric cache pass threshold. The table reflects an isolated live run captured during 0.1.0 development on an earlier source tree. Run `node scripts/measure-cache.mjs --out <path>/cache-report.md` for evidence from your exact revision and provider.
