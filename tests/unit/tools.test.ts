import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import {
  createCodingTools,
  createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createBtwTools, foldDeclaredTools } from "../../src/tools.js";

test("tool declarations are identical; only unchanged read-only builtins execute", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "btw-tools-"));
  try {
    await writeFile(join(cwd, "file.txt"), "original");
    const declarations = [
      ...createCodingTools(cwd),
      ...createReadOnlyTools(cwd).filter((tool) => tool.name !== "read"),
    ].map(toToolDeclaration);
    const tools = createBtwTools(declarations, cwd);
    expect(tools.map(toToolDeclaration)).toEqual(declarations);
    const read = tools.find((tool) => tool.name === "read");
    expect(await read?.execute("read", { path: "file.txt" })).toMatchObject({
      content: [{ type: "text", text: "original" }],
    });
    for (const name of ["write", "edit", "bash"]) {
      const tool = tools.find((tool) => tool.name === name);
      await expect(
        tool?.execute(name, {
          path: "file.txt",
          content: "changed",
          command: `touch ${join(cwd, "launched")}`,
        }),
      ).rejects.toThrow("tool_unavailable");
    }
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("original");
    await expect(access(join(cwd, "launched"))).rejects.toThrow();
    const changed = declarations.find((tool) => tool.name === "read");
    if (!changed) throw new Error("read declaration missing");
    const renamedExtension = createBtwTools(
      [{ ...changed, description: "arbitrary extension named read" }],
      cwd,
    );
    await expect(
      renamedExtension[0]?.execute("read", { path: "file.txt" }),
    ).rejects.toThrow("tool_unavailable");
    expect(
      foldDeclaredTools([
        {
          role: "system",
          content: "parent",
          toolsAdded: declarations,
          timestamp: 1,
        },
        {
          role: "system",
          content: "",
          toolsRemoved: [{ name: "write" }],
          timestamp: 2,
        },
      ]),
    ).toEqual(declarations.filter((tool) => tool.name !== "write"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
