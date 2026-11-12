import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  PI_ATTRIBUTION,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { BtwError } from "./errors.js";
export interface BtwRequestSettings {
  thinkingLevel: ThinkingLevel;
  options: Pick<
    SimpleStreamOptions,
    | "transport"
    | "thinkingBudgets"
    | "cacheRetention"
    | "identity"
    | "timeoutMs"
    | "maxRetryDelayMs"
    | "maxRetries"
    | "websocketConnectTimeoutMs"
  >;
}
export function requestSettings(
  pi: Pick<ExtensionAPI, "getSettings" | "getThinkingLevel">,
): BtwRequestSettings {
  const request = captureRequestSettings(pi);
  requireIndependentTransport(request);
  return request;
}
export function requireIndependentTransport(request: BtwRequestSettings): void {
  const transport = request.options.transport;
  // An explicit WebSocket session can carry mutable response state. Do not share it.
  if (transport === "websocket" || transport === "websocket-cached")
    throw new BtwError("unsupported_serialization", transport);
}
export function captureRequestSettings(
  pi: Pick<ExtensionAPI, "getSettings" | "getThinkingLevel">,
): BtwRequestSettings {
  const manager = SettingsManager.inMemory(pi.getSettings());
  const settings = manager.getSettings();
  const retry = manager.getProviderRetrySettings();
  const idle = manager.getHttpIdleTimeoutMs();
  const telemetryEnv = process.env.PI_TELEMETRY;
  const telemetry =
    telemetryEnv === undefined
      ? settings.enableInstallTelemetry !== false
      : /^(1|true|yes)$/i.test(telemetryEnv);
  const transport = settings.transport ?? "auto";
  const retention = process.env.PI_CACHE_RETENTION;
  const cacheRetention =
    retention === "long" || retention === "none" ? retention : "short";
  return {
    thinkingLevel: pi.getThinkingLevel(),
    options: {
      transport,
      cacheRetention,
      thinkingBudgets: settings.thinkingBudgets,
      timeoutMs: retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
      maxRetries: retry.maxRetries,
      maxRetryDelayMs: retry.maxRetryDelayMs,
      websocketConnectTimeoutMs: manager.getWebSocketConnectTimeoutMs(),
      identity: {
        userAgent: "detailed",
        version: VERSION,
        attribution: telemetry ? PI_ATTRIBUTION : null,
      },
    },
  };
}
