/**
 * Why enrolling can fail, and what the operator sees for each. Main and the
 * renderer both read this file, so the copy cannot drift between them.
 */

/** Why the cloud refused to bind this laptop to the printer the code was issued for (HTTP 409). */
export const ENROLL_CONFLICT_REASONS = [
  "target_not_found",
  "target_disabled",
  "campus_mismatch",
  "target_serial_mismatch",
  "serial_other_campus",
  "serial_duplicate_has_jobs",
  "serial_in_use",
  "printer_name_taken",
] as const;

/** `unknown` stands for a conflict the cloud did not explain, or explained with a reason this app does not know. */
export type EnrollConflictReason = (typeof ENROLL_CONFLICT_REASONS)[number] | "unknown";

export function toConflictReason(value: unknown): EnrollConflictReason {
  return (ENROLL_CONFLICT_REASONS as readonly unknown[]).includes(value) ? (value as EnrollConflictReason) : "unknown";
}

/**
 * `code_used` is a 409 `{ error: "conflict" }` with no reason: RSVP spent the code on another request that won a race.
 * It is not a printer conflict, so it has no reason and no "nothing was changed" copy.
 */
export type EnrollPlainFailure =
  | "invalid_code"
  | "code_expired"
  | "code_used"
  | "throttled"
  | "disabled"
  | "unreachable"
  | "invalid_request"
  | "printer_not_found";

export type EnrollFailure =
  | { ok: false; reason: EnrollPlainFailure }
  /** Nothing was changed and the code is still valid. */
  | { ok: false; reason: "printer_conflict"; conflict: EnrollConflictReason };

export const ENROLL_FAILURE_COPY: Record<EnrollPlainFailure, string> = {
  invalid_code: "That code did not work. Ask an admin for a new one.",
  code_expired: "That code has expired. Ask an admin for a new code.",
  code_used: "That code was already used up. Ask an admin for a new code.",
  throttled: "Too many tries. Wait a few minutes, then enter the code again.",
  disabled: "Enrolling is turned off right now. Ask an admin for help.",
  unreachable: "Could not reach Favor RSVP. Check the internet connection and try again.",
  printer_not_found: "We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.",
  invalid_request: "The app could not send that request. Update Favor Printer and try again.",
};

/** None of these names another printer or a serial: the cloud does not send them and the app must not guess. */
export const ENROLL_CONFLICT_COPY: Record<EnrollConflictReason, string> = {
  target_not_found: "The printer this code was made for is no longer in Favor RSVP. Ask an admin for a new code.",
  target_disabled: "The printer this code was made for is turned off in RSVP printing settings. Ask an admin to turn it on, then enter the code again.",
  campus_mismatch: "This code and this printer are set up for different campuses. Ask an admin to check the campus, then enter the code again.",
  target_serial_mismatch: "This code was made for a different Zebra than the one plugged in. Plug in the right one, or ask an admin for a new code.",
  serial_other_campus: "This Zebra is already set up at another campus. Ask an admin to move it, then enter the code again.",
  serial_duplicate_has_jobs: "RSVP has this Zebra listed twice and one has labels waiting. Ask an admin to tidy it up, then enter the code again.",
  serial_in_use: "This Zebra is already connected to another laptop. Ask an admin to disconnect it there, then enter the code again.",
  printer_name_taken: "Another printer in RSVP already has this name. Ask an admin to rename one, then enter the code again.",
  unknown: "Favor RSVP could not connect this printer. Nothing was changed. Ask an admin for help.",
};

export function enrollFailureCopy(failure: EnrollFailure): string {
  return failure.reason === "printer_conflict" ? ENROLL_CONFLICT_COPY[failure.conflict] : ENROLL_FAILURE_COPY[failure.reason];
}
