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

/** An error as one redacted line. Stack traces are dropped: they can embed argument text. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return redact(typeof error === "string" ? error : "Unknown error");
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
