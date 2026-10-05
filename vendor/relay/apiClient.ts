/**
 * Outbound-only HTTP client for the cloud relay API. The relay never listens.
 *
 * Failure classes matter to the caller:
 *   RelayNetworkError  cloud unreachable or 5xx: keep local state, retry later
 *   RelayAuthError     401: credentials rejected or revoked, keep local state
 *   "stale" results    the cloud no longer recognises this claim: drop the entry
 */

import type {
  ClaimResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  RelayConfigResponse,
  RelayTestPrintResponse,
  ReportOutcome,
} from "./protocol";

export class RelayNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayNetworkError";
  }
}

export class RelayAuthError extends Error {
  constructor() {
    super("cloud rejected the relay credentials (401)");
    this.name = "RelayAuthError";
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  relayId: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type JobCallResult = { kind: "ok"; status: string } | { kind: "stale" };

export class RelayApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async post(path: string, body: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/printing/relay${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.token}`,
          "x-relay-id": this.options.relayId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new RelayNetworkError(error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) throw new RelayAuthError();
    if (response.status >= 500) {
      throw new RelayNetworkError(`cloud answered ${response.status}`);
    }
    return response;
  }

  async claim(printerIds: string[], limit: number): Promise<ClaimResponse> {
    const response = await this.post("/claim", { printerIds, limit });
    if (!response.ok) throw new RelayNetworkError(`claim answered ${response.status}`);
    return (await response.json()) as ClaimResponse;
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const response = await this.post("/heartbeat", request);
    if (!response.ok) throw new RelayNetworkError(`heartbeat answered ${response.status}`);
    return (await response.json()) as HeartbeatResponse;
  }

  /** What this relay is enrolled to serve. The Favor Printer app asks instead of reading env vars. */
  async config(): Promise<RelayConfigResponse> {
    const response = await this.post("/config", {});
    if (!response.ok) throw new RelayNetworkError(`config answered ${response.status}`);
    return (await response.json()) as RelayConfigResponse;
  }

  /**
   * Ask the cloud for a test label for one of this relay's printers. It makes no
   * job: the relay prints the returned ZPL itself, outside the job state machine.
   */
  async testPrint(printerId: string): Promise<RelayTestPrintResponse> {
    const response = await this.post("/test-print", { printerId });
    if (!response.ok) throw new RelayNetworkError(`test print answered ${response.status}`);
    return (await response.json()) as RelayTestPrintResponse;
  }

  private async jobCall(path: string, body: unknown): Promise<JobCallResult> {
    const response = await this.post(path, body);
    if (response.ok) {
      const { status } = (await response.json()) as { status: string };
      return { kind: "ok", status };
    }
    // 404/403/409: the cloud has moved on from this claim. Retrying cannot help.
    if ([403, 404, 409].includes(response.status)) return { kind: "stale" };
    throw new RelayNetworkError(`cloud answered ${response.status}`);
  }

  /** Tell the cloud the printer connection is open and a write is about to start. */
  sending(jobId: string, claimToken: string) {
    return this.jobCall(`/jobs/${jobId}/sending`, { claimToken });
  }

  report(jobId: string, claimToken: string, outcome: ReportOutcome, error?: string) {
    return this.jobCall(`/jobs/${jobId}/report`, { claimToken, outcome, error });
  }
}
