import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { BtwThreadEvent } from "../../src/contract.js";
export interface RpcRecord {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  method?: string;
  message?: unknown;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}
export async function until<T>(
  read: () => T | undefined,
  label: string,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await setTimeout(20);
  }
  throw new Error(`Timed out: ${label}`);
}
export class PiFixture {
  records: RpcRecord[] = [];
  events: BtwThreadEvent[] = [];
  stderr = "";
  private process: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private constructor(
    readonly directory: string,
    readonly api: string,
  ) {}
  static async create(baseUrl: string, api: string): Promise<PiFixture> {
    const directory = await mkdtemp(join(tmpdir(), "pi-btw-test-"));
    await mkdir(join(directory, "work"));
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        defaultProvider: "fixture",
        defaultModel: "fixture",
        defaultThinkingLevel: "off",
        transport: "sse",
        cacheWarming: "off",
        enableInstallTelemetry: false,
        compaction: {
          enabled: false,
          keepRecentTokens: 32,
          reserveTokens: 256,
        },
        retry: { enabled: false },
        codemode: { enabled: false },
      }),
    );
    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${baseUrl}${api === "openai-completions" ? "/v1" : ""}`,
            api,
            apiKey: "public-fixture-key",
            models: [
              {
                id: "fixture",
                name: "fixture",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 4096,
                compat: {
                  sendSessionAffinityHeaders: true,
                  supportsLongCacheRetention: true,
                },
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(directory, "bridge.ts"),
      `export default function(pi) {
      pi.events.on("pi-btw:thread", e => pi.events.emit("fixture:thread", e));
      let ctx;
      pi.on("session_start", (_e,c) => {ctx=c; pi.events.emit("pi-btw:sync", {});});
      pi.events.on("fixture:thread", e => ctx?.ui.notify("FIXTURE_BTW " + JSON.stringify(e), "info"));
      pi.registerCommand("fixture:branch", {handler: async(args, c) => {await c.navigateTree(args, {summarize:false});}});
      pi.on("context", e => ({messages:e.messages.map(m => {
        if (m.role !== "user") return m;
        const content = typeof m.content === "string" ? m.content + " [context-transform]" : [...m.content, {type:"text", text:" [context-transform]"}];
        return {...m, content};
      })}));
    }`,
    );
    return new PiFixture(directory, api);
  }
  async start(sessionFile?: string, memory = false): Promise<void> {
    this.records = [];
    this.events = [];
    this.stderr = "";
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("PI_")) delete env[key];
    Object.assign(env, {
      PI_CODING_AGENT_DIR: this.directory,
      PI_CACHE_RETENTION: "long",
      PI_TELEMETRY: "0",
    });
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      resolve("extensions/btw.ts"),
      "-e",
      join(this.directory, "bridge.ts"),
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--session-dir",
      join(this.directory, "sessions"),
    ];
    if (sessionFile) args.push("--session", sessionFile);
    if (memory) args.push("--no-session");
    const child = spawn(process.env.PI_BINARY ?? "pi", args, {
      cwd: join(this.directory, "work"),
      env,
      stdio: "pipe",
    });
    this.process = child;
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const record: RpcRecord = JSON.parse(line);
          this.records.push(record);
          if (
            record.type === "extension_ui_request" &&
            record.method === "notify" &&
            typeof record.message === "string" &&
            record.message.startsWith("FIXTURE_BTW ")
          )
            this.events.push(JSON.parse(record.message.slice(12)));
        } catch {
          this.stderr += `Non-JSON stdout: ${line}\n`;
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      this.stderr += error.message;
    });
    await this.rpc("get_commands");
  }
  async rpc(type: string, fields: object = {}): Promise<RpcRecord> {
    const child = this.process;
    if (!child) throw new Error("Pi not started");
    const id = String(++this.sequence);
    child.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
    const record = await until(
      () =>
        this.records.find(
          (record) => record.type === "response" && record.id === id,
        ),
      `${type}; stderr=${this.stderr}`,
      30000,
    );
    if (!record.success)
      throw new Error(`${type}: ${record.error}; stderr=${this.stderr}`);
    return record;
  }
  async prompt(message: string): Promise<void> {
    await this.rpc("prompt", { message });
  }
  async parent(message: string): Promise<void> {
    const before = this.records.length;
    await this.prompt(message);
    await until(
      () =>
        this.records
          .slice(before)
          .find((record) => record.type === "agent_settled"),
      `parent settled; ${this.stderr}`,
    );
  }
  async state(status = "idle", after = 0) {
    return until(
      () =>
        this.events
          .slice(after)
          .find(
            (event) =>
              event.type === "state" &&
              event.thread.status === status &&
              event.thread.revision > 0,
          ),
      `BTW ${status}; ${this.stderr}`,
    ).then((event) => {
      if (event.type !== "state") throw new Error("Not state");
      return event.thread;
    });
  }
  async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    const child = this.process;
    if (!child) return;
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill(signal);
    await exit;
    this.process = null;
  }
  async close(): Promise<void> {
    await this.stop();
    await rm(this.directory, { recursive: true, force: true });
  }
}
