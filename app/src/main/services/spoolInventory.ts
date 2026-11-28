import { readdirSync } from "node:fs";

/**
 * Read-only look at the relay's spool folder for the install-on-quit gate. True only when the folder is absent or holds
 * no entries of any kind: a job record, send marker, temp file, lock, unknown file or subfolder all count. Any other read
 * error (unreadable, not a folder) is false, so an unreadable spool keeps an update deferred. Unlike FileSpool, this never
 * creates the folder and never deletes, renames or writes anything in it.
 */
export function spoolAbsentOrEmpty(dir: string, list: (folder: string) => string[] = (folder) => readdirSync(folder)): boolean {
  try {
    return list(dir).length === 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
