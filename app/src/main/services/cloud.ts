/**
 * The cloud as the app sees it: enrolling with a six-digit code, and turning
 * HTTP statuses and relay errors into the few states the UI shows.
 *
 * Enrollment contract (RSVP side, rsvp.favor.church#486):
 *   POST {apiUrl}/api/printing/relay/enroll
 *   body    { code, usbSerial, appVersion, osVersion }
 *   200     { relayId, token, label?, printer?: { name, campusId? } }
 *   409     { error: "printer_conflict", reason } -> printer_conflict with that reason
 *           (an unknown or missing reason, or any other 409, is a conflict with reason "unknown")
 *   409     { error: "conflict" }, no reason   -> code_used (RSVP spent the code after losing a race)
 *   400/422 malformed request          -> invalid_request
 *   401/403/404/410 unknown or expired -> invalid_code (the cloud does not say which)
 *   429     too many attempts          -> throttled
 *   501, or { error: "enrollment_disabled" } -> disabled
 *   other 5xx, network failure         -> unreachable
 * The status mapping is kept in `mapEnrollStatus` so a contract change is one edit.
 */

import {
  ENROLL_FAILURE_COPY,
  isEnrollmentCode,
  isUsableUsbSerial,
  toConflictReason,
  type EnrollFailure as EnrollFailureResult,
  type EnrollPlainFailure,
} from "../../shared";
import { RelayAuthError } from "../../../../vendor/relay/apiClient";
import { secureApiUrl } from "../../../../vendor/relay/config";
import type { CloudState } from "../../../../vendor/relay/status";

/** The failures that map from an HTTP status alone. A conflict also carries the cloud's reason. */
export type EnrollFailure = EnrollPlainFailure;

export type EnrolledCredentials = {
  relayId: string;
  token: string;
  /** Admin-chosen name of this laptop. */
  label: string | null;
  /** The printer the cloud bound this laptop to. Null when the cloud did not say. */
  printer: { name: string; campusId: number | null } | null;
};

export type EnrollOutcome =
  | { ok: true; credentials: EnrolledCredentials }
  | (EnrollFailureResult & { /** HTTP status, when the cloud answered. */ status?: number });

export type EnrollRequest = {
  apiUrl: string;
  code: string;
  usbSerial: string | null;
  appVersion: string;
  osVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export { ENROLL_FAILURE_COPY };

export function mapEnrollStatus(status: number, errorCode?: string): EnrollFailure {
  if (status === 501 || errorCode === "enrollment_disabled") return "disabled";
  if (status === 429) return "throttled";
  if (status === 400 || status === 422) return "invalid_request";
  if ([401, 403, 404, 410].includes(status)) return "invalid_code";
  return "unreachable";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseCredentials(body: unknown): EnrolledCredentials | null {
  if (!isRecord(body)) return null;
  const { relayId, token, label } = body;
  if (typeof relayId !== "string" || !relayId.trim()) return null;
  if (typeof token !== "string" || !token.trim()) return null;
  return { relayId, token, label: typeof label === "string" && label.trim() ? label : null, printer: parsePrinter(body.printer) };
}

/** Lenient: a missing or odd printer never fails an enrollment that otherwise worked. */
function parsePrinter(value: unknown): EnrolledCredentials["printer"] {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  const { campusId } = value;
  return { name: value.name, campusId: typeof campusId === "number" && Number.isInteger(campusId) ? campusId : null };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Never throws. The returned token goes to the secret store and nowhere else. */
export async function enroll(request: EnrollRequest): Promise<EnrollOutcome> {
  if (!isEnrollmentCode(request.code)) return { ok: false, reason: "invalid_code" };
  // The server rejects anything else with a 400, so do not send it.
  if (!isUsableUsbSerial(request.usbSerial)) return { ok: false, reason: "printer_not_found" };

  let baseUrl: string;
  try {
    baseUrl = secureApiUrl(request.apiUrl).replace(/\/+$/, "");
  } catch {
    return { ok: false, reason: "invalid_request" };
  }

  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(`${baseUrl}/api/printing/relay/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: request.code,
        usbSerial: request.usbSerial,
        appVersion: request.appVersion,
        osVersion: request.osVersion,
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const body = await readJson(response);
  if (response.ok) {
    const credentials = parseCredentials(body);
    return credentials ? { ok: true, credentials } : { ok: false, reason: "unreachable", status: response.status };
  }
  if (response.status === 409) {
    if (isRecord(body) && body.error === "conflict" && body.reason === undefined) return { ok: false, reason: "code_used", status: response.status };
    const conflict = isRecord(body) && body.error === "printer_conflict" ? toConflictReason(body.reason) : "unknown";
    return { ok: false, reason: "printer_conflict", conflict, status: response.status };
  }
  const errorCode = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
  return { ok: false, reason: mapEnrollStatus(response.status, errorCode), status: response.status };
}

/** What an HTTP answer to a relay call says about the cloud. 401 means the laptop was removed. */
export function cloudStateForStatus(status: number): CloudState {
  if (status === 401) return "revoked";
  if (status >= 500) return "unreachable";
  return "ok";
}

/** What a failed relay call says about the cloud: only an auth error is a revocation. */
export function cloudStateForError(error: unknown): CloudState {
  return error instanceof RelayAuthError ? "revoked" : "unreachable";
}
