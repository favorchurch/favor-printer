/**
 * The cloud as the app sees it: enrolling with a six-digit code, and turning
 * HTTP statuses and relay errors into the few states the UI shows.
 *
 * Enrollment contract (RSVP side, rsvp.favor.church#486):
 *   POST {apiUrl}/api/printing/relay/enroll
 *   body    { code, usbSerial, appVersion, osVersion }
 *   200     { relayId, token, label? }
 *   400/422 malformed request          -> invalid_request
 *   401/403/404/410 unknown or expired -> invalid_code (the cloud does not say which)
 *   429     too many attempts          -> throttled
 *   501, or { error: "enrollment_disabled" } -> disabled
 *   other 5xx, network failure         -> unreachable
 * The status mapping is kept in `mapEnrollStatus` so a contract change is one edit.
 */

import { isEnrollmentCode, isUsableUsbSerial, type EnrollResult } from "../../shared";
import { RelayAuthError } from "../../../../vendor/relay/apiClient";
import { secureApiUrl } from "../../../../vendor/relay/config";
import type { CloudState } from "../../../../vendor/relay/status";

export type EnrollFailure = Extract<EnrollResult, { ok: false }>["reason"];

export type EnrolledCredentials = {
  relayId: string;
  token: string;
  /** Admin-chosen name of this laptop. */
  label: string | null;
};

export type EnrollOutcome = { ok: true; credentials: EnrolledCredentials } | { ok: false; reason: EnrollFailure; /** HTTP status, when the cloud answered. */ status?: number };

export type EnrollRequest = {
  apiUrl: string;
  code: string;
  usbSerial: string | null;
  appVersion: string;
  osVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export const ENROLL_FAILURE_COPY: Record<EnrollFailure, string> = {
  invalid_code: "That code did not work. It may have expired. Ask an admin for a new one.",
  throttled: "Too many tries. Wait a few minutes, then enter the code again.",
  disabled: "Enrolling is turned off right now. Ask an admin for help.",
  unreachable: "Could not reach Favor RSVP. Check the internet connection and try again.",
  printer_not_found: "We can't see your Zebra printer. Check it's on and plugged in, then try again.",
  invalid_request: "The app could not send that request. Update Favor Printer and try again.",
};

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
  return { relayId, token, label: typeof label === "string" && label.trim() ? label : null };
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
