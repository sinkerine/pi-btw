import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
export function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, child]) => [key, withoutCacheMarkers(child)]),
    );
  return value;
}
export interface WireMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}
export interface WireBody {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
  system?: unknown;
  prompt_cache_key?: string;
  max_tokens?: number;
  [key: string]: unknown;
}
export interface Capture {
  body: WireBody;
  headers: IncomingHttpHeaders;
  at: number;
}
export interface Reply {
  text?: string;
  textChunks?: readonly string[];
  tool?: { name: string; arguments: object };
  hold?: boolean;
  pauseAfterContent?: boolean;
  fail?: boolean;
}
export async function httpStub(
  api: "openai-completions" | "anthropic-messages",
  plan: (capture: Capture, index: number) => Reply = () => ({}),
) {
  const captures: Capture[] = [];
  const held = new Map<number, () => void>();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const capture: Capture = {
      body: JSON.parse(raw),
      headers: request.headers,
      at: Date.now(),
    };
    captures.push(capture);
    const index = captures.length - 1;
    const reply = plan(capture, index);
    const send = () => {
      if (response.destroyed) return;
      if (reply.fail) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "fixture provider failure",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (api === "openai-completions")
        openai(
          response,
          reply,
          reply.pauseAfterContent
            ? (finish) => {
                held.set(index, finish);
              }
            : undefined,
        );
      else
        anthropic(
          response,
          reply,
          reply.pauseAfterContent
            ? (finish) => {
                held.set(index, finish);
              }
            : undefined,
        );
    };
    if (reply.hold) held.set(index, send);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    captures,
    baseUrl: `http://127.0.0.1:${address.port}`,
    release(index: number) {
      held.get(index)?.();
      held.delete(index);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function openai(
  response: ServerResponse,
  reply: Reply,
  pause?: (finish: () => void) => void,
): void {
  const delta = reply.tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: {
              name: reply.tool.name,
              arguments: JSON.stringify(reply.tool.arguments),
            },
          },
        ],
      }
    : { role: "assistant", content: reply.text ?? "fixture answer" };
  const deltas = reply.textChunks
    ? reply.textChunks.map((content) => ({ role: "assistant", content }))
    : [delta];
  for (const part of deltas)
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: part, finish_reason: null }] })}\n\n`,
    );
  const finish = () => {
    if (response.destroyed) return;
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 200, completion_tokens: 4, total_tokens: 204, prompt_tokens_details: { cached_tokens: 128 } } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  };
  if (pause) pause(finish);
  else finish();
}
function anthropic(
  response: ServerResponse,
  reply: Reply,
  pause?: (finish: () => void) => void,
): void {
  function event(type: string, payload: object): void {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`,
    );
  }
  event("message_start", {
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 200,
        output_tokens: 0,
        cache_read_input_tokens: 128,
        cache_creation_input_tokens: 0,
      },
    },
  });
  if (reply.tool) {
    event("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_fixture",
        name: reply.tool.name,
        input: {},
      },
    });
    event("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(reply.tool.arguments),
      },
    });
  } else {
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: reply.text ?? "fixture answer" },
    });
  }
  event("content_block_stop", { index: 0 });
  const finish = () => {
    if (response.destroyed) return;
    event("message_delta", {
      delta: {
        stop_reason: reply.tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 4 },
    });
    event("message_stop", {});
    response.end();
  };
  if (pause) pause(finish);
  else finish();
}
