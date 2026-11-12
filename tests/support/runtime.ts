import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FakeProvider, fixtureModel } from "./stream.js";
export async function runtime(extension: ExtensionFactory) {
  const directory = await mkdtemp(join(tmpdir(), "btw-unit-runtime-"));
  const provider = new FakeProvider();
  const apis: ExtensionAPI[] = [];
  const errors: string[] = [];
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    transport: "sse",
    enableInstallTelemetry: false,
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Unit parent system",
    extensionFactories: [
      (pi) => {
        apis.push(pi);
        pi.registerProvider(fixtureModel.provider, {
          api: fixtureModel.api,
          apiKey: "public-unit-key",
          baseUrl: fixtureModel.baseUrl,
          models: [fixtureModel],
          streamSimple: provider.streamSimple,
        });
        return extension(pi);
      },
    ],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: fixtureModel,
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: ["read", "write", "bash"],
  });
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => {
      errors.push(error.error);
    },
  });
  const pi = apis[0];
  if (!pi) throw new Error("Unit extension did not load");
  return {
    directory,
    provider,
    pi,
    errors,
    session,
    sessionManager,
    runner: session.extensionRunner,
    ctx: session.extensionRunner.createContext(),
    async close() {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
