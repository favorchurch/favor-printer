/**
 * Logging for the shell. Every line passes through `redact`, so a token, an
 * enrollment code or a URL query string never reaches the log file even when an
 * error message carries one. Messages are written by the app, never from label
 * data: the relay's own output is counts and states only.
 */

export type LogLevel = "info" | "warn" | "error";

export type Logger = (level: LogLevel, scope: string, message: string) => void;

const MAX_LINE_LENGTH = 400;

const REDACTIONS: [RegExp, string][] = [
  // ZPL: a whole label, or any stray command. Attendee names and security codes sit inside these.
  [/\^XA[\s\S]*?(?:\^XZ|$)/g, "[zpl]"],
  [/\^F[DV][^\r\n^]*/g, "[zpl]"],
  [/\^[A-Z][A-Z0-9]\S*/g, "[zpl]"],
  // Person fields in key/value text.
  [/\b(name|first_?name|last_?name|full_?name|attendee|guest|child|parent|email|phone|security_?code)(["']?\s*[:=]\s*["']?)[^,;"'}\n]+/gi, "$1$2[redacted]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\b(token|secret|password|authorization|code|serial)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2[redacted]"],
  // Query strings carry codes and tokens; keep the path.
  [/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, "$1?[redacted]"],
  // Enrollment codes.
  [/\b\d{6}\b/g, "[redacted]"],
  // Long opaque strings: tokens, keys, hashes.
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > MAX_LINE_LENGTH ? `${out.slice(0, MAX_LINE_LENGTH)}...` : out;
}

/**
 * An error as one line: its class and, when it has one, its code (`ENOTFOUND`). The message and the
 * stack are left out on purpose: they are free text that can carry whatever the failing call was
 * handling, and a log line that never contains them cannot leak it.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const code = (error as { code?: unknown }).code;
  const name = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : "Error";
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `${name} (${code})` : name;
}

export type LogSink = (line: string) => void;

export function createLogger(sink: LogSink, now: () => Date = () => new Date()): Logger {
  return (level, scope, message) => {
    // One line per entry: a message cannot forge a second log line.
    const flat = redact(message).replace(/[\r\n]+/g, " ");
    sink(`${now().toISOString()} ${level} [${scope}] ${flat}`);
  };
}

/** A logger that keeps nothing. Self-test mode uses it so it leaves no trace. */
export const silentLogger: Logger = () => undefined;

export type FileOps = {
  append(file: string, text: string): void;
  size(file: string): number;
  rename(from: string, to: string): void;
  mkdir(dir: string): void;
};

/** Appends to `file`, moving it to `file.1` once it passes `maxBytes`. A failing disk never throws into the app. */
export function createRotatingFileSink(file: string, ops: FileOps, maxBytes = 1_000_000): LogSink {
  let prepared = false;
  return (line) => {
    try {
      if (!prepared) {
        ops.mkdir(file.slice(0, Math.max(file.lastIndexOf("/"), 0)) || ".");
        prepared = true;
      }
      if (ops.size(file) > maxBytes) ops.rename(file, `${file}.1`);
      ops.append(file, `${line}\n`);
    } catch {
      // Logging is best effort.
    }
  };
}
