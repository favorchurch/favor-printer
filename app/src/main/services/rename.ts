/**
 * Renames this laptop or its bound printer in the cloud registry, through the
 * vendored relay client. A rename changes only the name: it never enrolls,
 * never clears the pairing, and never touches the token.
 *
 * The vendored `rename` throws the same error for every non-2xx answer, so the
 * HTTP status is read from the response here. That is how a duplicate name (409)
 * and a rejected name (400) reach the volunteer as their own reasons.
 */

import { RelayApiClient, RelayAuthError } from "../../../../vendor/relay/apiClient";
import { secureApiUrl } from "../../../../vendor/relay/config";
import type { RelayRenameRequest } from "../../../../vendor/relay/protocol";
import type { StoredCredentials } from "./secretStore";

export type RenameCloudFailure = "name_taken" | "invalid_name" | "not_found" | "revoked" | "unreachable";

export type RenameCloudOutcome =
  | { ok: true; label: string | null; printerName: string | null }
  | { ok: false; reason: RenameCloudFailure };

export type RenameCloudOptions = {
  apiUrl: string;
  credentials: StoredCredentials;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Never throws. The token goes into the request header and is never returned or logged. */
export async function renameInCloud(request: RelayRenameRequest, options: RenameCloudOptions): Promise<RenameCloudOutcome> {
  let status: number | null = null;
  const fetchImpl = options.fetch ?? fetch;
  let baseUrl: string;
  try {
    baseUrl = secureApiUrl(options.apiUrl);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const api = new RelayApiClient({
    baseUrl,
    relayId: options.credentials.relayId,
    token: options.credentials.token,
    timeoutMs: options.timeoutMs,
    fetch: async (url, init) => {
      const response = await fetchImpl(url, init);
      status = response.status;
      return response;
    },
  });

  try {
    const reply = await api.rename(request);
    return {
      ok: true,
      label: "label" in request ? (reply.label ?? null) : null,
      printerName: "printerId" in request ? (reply.printer?.name ?? null) : null,
    };
  } catch (error) {
    if (error instanceof RelayAuthError) return { ok: false, reason: "revoked" };
    if (status === 409) return { ok: false, reason: "name_taken" };
    if (status === 400 || status === 422) return { ok: false, reason: "invalid_name" };
    if (status === 404) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "unreachable" };
  }
}
