# pi-btw

Ask a read-only side question about your Pi agent's latest finished turn while the main agent keeps working. The side conversation stays separate until you explicitly send it to main.

Requires Pi **1.4.0**. The declared peer range is `>=1.4.0 <2`; only 1.4.0 is verified. Package name: `@sinkerine/pi-btw`. This repository is independent of Paseo.

Load a local checkout without changing your Pi installation:

```sh
pi -e /absolute/path/to/pi-btw/extensions/btw.ts
```

For a persistent package entry, add the checkout through your normal Pi package configuration. Hosts should pin a reviewed Git revision. This release has no npm publication.

## Commands

| Command                                                     | Behavior                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/btw <question>`                                           | Ask in the active side conversation; creates a contextual thread when needed.                                  |
| `/side <question>`                                          | Alias for `/btw`.                                                                                              |
| `/btw:new [question]`                                       | Replace the active conversation with a fresh contextual conversation.                                          |
| `/btw:tangent [question]`                                   | Replace it with an independent conversation, without inherited parent context and with its own cache identity. |
| `/btw:abort`                                                | Stop BTW and discard its queued questions. Main keeps running.                                                 |
| `/btw:inject [instructions]`                                | Send the BTW transcript and optional instructions to main as one user message.                                 |
| `/btw:summarize [instructions]`                             | Ask BTW for a summary, show it in the thread, then send that summary to main as one user message.              |
| `/btw:clear`                                                | Abort and clear the active thread.                                                                             |
| `/btw:model provider/model`                                 | Override the BTW model. Status marks parent-prefix sharing false.                                              |
| `/btw:thinking off\|minimal\|low\|medium\|high\|xhigh\|max` | Override BTW thinking.                                                                                         |
| `/btw:status`                                               | Show structured status, pin, cache identity, last usage, resumability and error.                               |

Empty `/btw`, `/side`, `/btw:new` and `/btw:tangent` initialize or reopen an idle thread without calling a provider. TUI opens the composer; RPC emits idle `pi-btw:thread` state without an overlay. Pass an inline question for headless JSON/print runs. In the overlay, Esc stops a running BTW request; press Esc again after it stops to dismiss. The overlay streams BTW's answer while the main agent continues. Dismiss it to use the main editor again.

A question sent while BTW is answering queues in order. Each contextual question selects the latest **fully completed model turn and all its tool results** when it reaches dispatch. Parent progress never changes an answer already in flight. A changed parent boundary replaces the inherited context and keeps the full structured BTW history. There is no manual refresh. Before the first completed parent turn on a branch, use Tangent or finish a parent turn.

## Tool policy

BTW declares the exact same tools as the captured parent request, preserving cache-relevant declarations. It executes only unchanged Pi built-in `read`, `grep`, `find` and `ls` tools that the parent declared. All other calls, including bash, edit and write, return error tool results without executing. A custom tool named `read` is not automatically trusted. Ask main to make changes.

## Persistence and errors

For a persistent parent, private files live under `<agentDir>/btw/sessions/<parentSessionId>/<threadId>/`: exact digest-named snapshots, `thread.jsonl` containing the structured BTW suffix, and atomic `state.json`. The parent holds only `pi-btw/*` custom references, excluded from model context. One atomic `latest.json` checkpoint per parent preserves the latest completed request even if BTW was not active. Snapshots referenced by a thread remain available across rebases.

Restart Pi with the same parent session to recover the thread, pin, title, usage and tool history. A crashed running request becomes aborted and is never resubmitted automatically. Partial assistant content has a separate private `partial.json` checkpoint: first content is saved immediately, then updates coalesce on a 250 ms timer. A hard crash can lose the tail since the latest checkpoint (about 250 ms plus scheduling and disk latency); completion and graceful abort persist the final structured message. Recovery appends the partial once and closes interrupted tool calls with explicit error results without replaying them. Missing/corrupt snapshots or child files refuse continuation with `snapshot_unavailable`. Fix the files or start `/btw:new` after a new parent turn; there is no fallback rebuilt from parent history. In-memory parents report `resumable: false` and have no cross-process recovery.

Over-budget requests fail before provider dispatch. Start a new thread to drop the BTW suffix or use Tangent. Provider errors leave the thread available for the next question. Inject and summarize queue a single `followUp` when main is busy; neither clears the side conversation.

## Hosts, cache and development

[Paseo and other hosts](docs/host-contract.md) consume versioned `pi.events`, not terminal output. [Context and cache](docs/context-and-cache.md) describes exact-prefix serialization, routing limits, supported transports, reproducible fixtures and live measurement.

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
PI_BINARY=pi npm run test:integration
```

The implementation is original. dbachelder/pi-btw 0.8.1 is an observational comparison fixture; its source and license are not distributed in this package.
