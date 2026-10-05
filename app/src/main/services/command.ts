/**
 * The only place this app starts a process. Every command is a file plus an
 * argument list, run with `execFile`: nothing is ever parsed by a shell, so a
 * device URI or queue name cannot be read as anything but an argument.
 *
 * The runner never rejects. A process that cannot start, times out or exits
 * non-zero comes back as data, so callers decide what each outcome means.
 */

import { execFile } from "node:child_process";

export type CommandResult = {
  /** Exit code, or null when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CommandOptions = { timeoutMs?: number };

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Absolute paths: a packaged app starts with a minimal PATH. */
export const BINARIES = {
  // macOS installs the CUPS admin tools lpinfo and lpadmin in /usr/sbin.
  lpinfo: "/usr/sbin/lpinfo",
  lpstat: "/usr/bin/lpstat",
  lpadmin: "/usr/sbin/lpadmin",
  launchctl: "/bin/launchctl",
} as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

type ExecFileError = Error & { code?: unknown; killed?: boolean };

/** The slice of `child_process.execFile` the runner uses. Tests replace it. */
export type ExecFile = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => unknown;

export function createCommandRunner(execFileImpl: ExecFile = execFile as unknown as ExecFile): CommandRunner {
  return (file, args, options = {}) =>
    new Promise<CommandResult>((resolve) => {
      try {
        execFileImpl(
          file,
          [...args],
          {
            encoding: "utf8",
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: false });
              return;
            }
            resolve({
              code: typeof error.code === "number" ? error.code : null,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? "") || (typeof error.code === "number" ? "" : error.message),
              timedOut: error.killed === true,
            });
          },
        );
      } catch (error) {
        resolve({
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
        });
      }
    });
}
