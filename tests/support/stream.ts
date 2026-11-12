import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
export const fixtureModel: Model<Api> = {
  id: "unit-model",
  name: "Unit model",
  provider: "btw-unit",
  api: "openai-completions",
  baseUrl: "http://unused.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};
export function assistant(
  content = "unit answer",
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: fixtureModel.api,
    provider: fixtureModel.provider,
    model: fixtureModel.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 2,
      cacheRead: 64,
      cacheWrite: 0,
      totalTokens: 166,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export interface StreamRequest {
  model: Model<Api>;
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
  stream: AssistantMessageEventStream;
  finish(message?: AssistantMessage): void;
}
export class FakeProvider {
  readonly requests: StreamRequest[] = [];
  hold = false;
  response: () => AssistantMessage = () => assistant();
  streamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    let finished = false;
    const request: StreamRequest = {
      model,
      context: structuredClone(context),
      options,
      stream,
      finish: (message = this.response()) => {
        if (finished) return;
        finished = true;
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (message.stopReason === "aborted" || message.stopReason === "error")
          stream.push({
            type: "error",
            reason: message.stopReason,
            error: message,
          });
        else if (message.stopReason === "pending")
          throw new Error("Cannot finish a pending fixture response");
        else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      },
    };
    this.requests.push(request);
    options?.signal?.addEventListener(
      "abort",
      () => request.finish(assistant("partial unit answer", "aborted")),
      { once: true },
    );
    if (!this.hold) request.finish();
    return stream;
  };
}
