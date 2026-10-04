import type { AppSnapshot } from "../../../shared";

export function snapshotFor(patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    version: "0.1.0",
    status: { color: "green", headline: "Ready to print", detail: null },
    enrolled: true,
    label: null,
    paused: false,
    openAtLogin: true,
    channel: "stable",
    update: { kind: "idle" },
    recentJobs: { sent: 0, failed: 0, ambiguous: 0 },
    setupStep: null,
    printer: { kind: "none" },
    legacyRelayLoaded: false,
    warnings: ["Keep the lid open while printing. Closing the lid can stop labels from printing."],
    ...patch,
  };
}
