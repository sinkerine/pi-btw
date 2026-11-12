import { PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { requestSettings } from "../../src/request.js";

test("boundary settings inherit thinking, retention, transport, budgets, retry/timeouts and Pi client identity", () => {
  const retention = process.env.PI_CACHE_RETENTION;
  const telemetry = process.env.PI_TELEMETRY;
  process.env.PI_CACHE_RETENTION = "long";
  process.env.PI_TELEMETRY = "true";
  try {
    expect(
      requestSettings({
        getThinkingLevel: () => "high",
        getSettings: () => ({
          transport: "sse",
          enableInstallTelemetry: false,
          thinkingBudgets: { high: 8192 },
          retry: {
            provider: { timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 5000 },
          },
          websocketConnectTimeoutMs: 800,
        }),
      }),
    ).toEqual({
      thinkingLevel: "high",
      options: {
        transport: "sse",
        cacheRetention: "long",
        thinkingBudgets: { high: 8192 },
        timeoutMs: 1234,
        maxRetries: 2,
        maxRetryDelayMs: 5000,
        websocketConnectTimeoutMs: 800,
        identity: {
          userAgent: "detailed",
          version: VERSION,
          attribution: PI_ATTRIBUTION,
        },
      },
    });
  } finally {
    if (retention === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = retention;
    if (telemetry === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = telemetry;
  }
});
test("explicit shared WebSocket transports refuse rather than changing the parent's options", () => {
  for (const transport of ["websocket", "websocket-cached"] as const)
    expect(() =>
      requestSettings({
        getThinkingLevel: () => "off",
        getSettings: () => ({ transport }),
      }),
    ).toThrow("unsupported_serialization");
});
