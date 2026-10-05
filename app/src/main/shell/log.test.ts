import { describe, expect, it } from "vitest";

import { createLogger, createRotatingFileSink, describeError, redact, silentLogger, type FileOps } from "./log";

describe("redact", () => {
  it.each([
    ["bearer", "request failed with Bearer abc.def-123_xyz", "abc.def-123_xyz"],
    ["token field", 'body {"token":"s3cr3t-value"}', "s3cr3t-value"],
    ["token assignment", "token=hunter2 failed", "hunter2"],
    ["enrollment code", "enrolling with 123456 failed", "123456"],
    ["query string", "GET https://rsvp.favor.church/api/x?code=999999&y=1", "999999"],
    ["long opaque string", "key 0123456789abcdef0123456789abcdef0123 rejected", "0123456789abcdef0123456789abcdef0123"],
    ["serial", "serial: D2J190800123 seen", "D2J190800123"],
  ])("removes a %s", (_name, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("keeps ordinary text", () => {
    expect(redact("relay exited (code 1); restarting in 1000 ms")).toBe("relay exited (code 1); restarting in 1000 ms");
  });

  it("caps the line length", () => {
    expect(redact("a b ".repeat(300)).length).toBeLessThanOrEqual(403);
  });
});

describe("redact: zpl and person fields", () => {
  it("removes a whole label", () => {
    const out = redact("print failed for ^XA^CF0,60^FO50,50^FDJane Q. Attendee^FS^FD483920^FS^XZ today");
    expect(out).not.toMatch(/Jane|Attendee|483920|\^FD/);
    expect(out).toContain("[zpl]");
  });

  it("removes an unterminated label and stray commands", () => {
    expect(redact("cut off ^XA^FO10,10^FDJane Q. Attendee")).not.toContain("Jane");
    expect(redact("bad ^FDZoe O'Brien")).not.toContain("O'Brien");
  });

  it("leaves CUPS diagnostics like ^C readable", () => {
    expect(redact("lp: Error - The printer or class does not exist ^C")).toBe(
      "lp: Error - The printer or class does not exist ^C",
    );
  });

  it.each([
    ['{"name":"Jane Q. Attendee","age":7}', "Jane"],
    ["attendee=Jane Q. Attendee, room 4", "Jane"],
    ["firstName: Zoe", "Zoe"],
    ["email=jane@example.test", "jane@example.test"],
    ["security_code=SEC7F3A9C", "SEC7F3A9C"],
  ])("removes the value of a person field in %s", (input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });
});

describe("describeError", () => {
  it("is the class name, and never the message", () => {
    const error = new Error("401 for Bearer abc123def456 on https://x.test/a?token=zzz while printing ^XA^FDJane Q. Attendee^XZ");
    expect(describeError(error)).toBe("Error");
  });

  it("adds a well formed error code", () => {
    const error = Object.assign(new TypeError("getaddrinfo failed for Jane"), { code: "ENOTFOUND" });
    expect(describeError(error)).toBe("TypeError (ENOTFOUND)");
  });

  it("ignores a code or name that is not a plain identifier", () => {
    const error = Object.assign(new Error("x"), { code: "Jane Q. Attendee", name: "Jane Q. Attendee" });
    expect(describeError(error)).toBe("Error");
  });

  it("does not print an arbitrary object or string", () => {
    expect(describeError({ token: "x" })).toBe("Unknown error");
    expect(describeError("failed for Jane Q. Attendee")).toBe("Unknown error");
    expect(describeError(null)).toBe("Unknown error");
  });
});

describe("createLogger", () => {
  it("writes one redacted line per entry", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line), () => new Date("2026-10-04T00:00:00Z"));
    log("warn", "cloud", "rejected 123456\nforged line");
    expect(lines).toEqual(["2026-10-04T00:00:00.000Z warn [cloud] rejected [redacted] forged line"]);
  });

  it("has a silent variant", () => {
    expect(() => silentLogger("info", "x", "y")).not.toThrow();
  });
});

describe("createRotatingFileSink", () => {
  const ops = (size: number) => {
    const calls: string[] = [];
    const fileOps: FileOps = {
      append: (file, text) => void calls.push(`append ${file} ${JSON.stringify(text)}`),
      size: () => size,
      rename: (from, to) => void calls.push(`rename ${from} ${to}`),
      mkdir: (dir) => void calls.push(`mkdir ${dir}`),
    };
    return { calls, fileOps };
  };

  it("creates the folder once and appends a line", () => {
    const { calls, fileOps } = ops(0);
    const sink = createRotatingFileSink("/logs/main.log", fileOps);
    sink("one");
    sink("two");
    expect(calls).toEqual(['mkdir /logs', 'append /logs/main.log "one\\n"', 'append /logs/main.log "two\\n"']);
  });

  it("rotates a full file", () => {
    const { calls, fileOps } = ops(2_000_000);
    createRotatingFileSink("/logs/main.log", fileOps, 1_000_000)("x");
    expect(calls).toContain("rename /logs/main.log /logs/main.log.1");
  });

  it("never throws when the disk fails", () => {
    const sink = createRotatingFileSink("/logs/main.log", {
      append: () => {
        throw new Error("disk full");
      },
      size: () => 0,
      rename: () => undefined,
      mkdir: () => undefined,
    });
    expect(() => sink("x")).not.toThrow();
  });
});
