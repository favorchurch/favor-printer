import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const sources = readdirSync(dir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

describe("no shell strings in the main-process services", () => {
  it("finds the service sources", () => {
    expect(sources.map((source) => source.name)).toContain("command.ts");
  });

  it("starts processes in command.ts only, and only with execFile", () => {
    const importers = sources.filter((source) => /child_process/.test(source.text)).map((source) => source.name);
    expect(importers).toEqual(["command.ts"]);
    const command = sources.find((source) => source.name === "command.ts")!;
    expect(command.text).toMatch(/import \{ execFile \} from "node:child_process";/);
  });

  it.each(sources.map((source) => [source.name, source.text] as const))("%s has no exec/spawn call or shell option", (_name, text) => {
    expect(text).not.toMatch(/\b(exec|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/);
    expect(text).not.toMatch(/\bshell\s*:/);
    expect(text).not.toMatch(/\b(sh|bash|zsh)\s+-c\b/);
    expect(text).not.toMatch(/\/bin\/(ba|z)?sh\b/);
  });
});
