import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  getCurrentTools,
  type Tool,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { digest } from "./digest.js";
import { BtwError } from "./errors.js";
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export function foldDeclaredTools(messages: readonly AgentMessage[]): Tool[] {
  return getCurrentTools(convertToLlm([...messages]));
}
export function createBtwTools(
  declared: readonly Tool[],
  cwd: string,
): AgentTool[] {
  const builtins = createReadOnlyTools(cwd);
  return declared.map((declaration) => {
    const builtin = builtins.find(
      (tool) =>
        tool.name === declaration.name &&
        digest(toToolDeclaration(tool)) === digest(declaration),
    );
    return {
      ...declaration,
      label: declaration.name,
      execute: async (id, args, signal, update) => {
        if (!builtin) throw new BtwError("tool_unavailable", declaration.name);
        return builtin.execute(id, args, signal, update);
      },
    };
  });
}
