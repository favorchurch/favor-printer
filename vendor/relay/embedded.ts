/**
 * Entry for a relay run as a child of a host app. Never reads RELAY_* variables:
 * the parent sends everything over the message channel.
 *
 *   parent -> child  {type:"start", options} | pause | resume | stop
 *                    | {type:"testPrint", printerId} | {type:"printerAttached", attached}
 *   child -> parent  {type:"event", event} | {type:"testPrintResult", ...}
 *                    | {type:"error", code} | {type:"stopped"}
 *
 * The channel is `process.parentPort` under Electron's utilityProcess and
 * `process.send` / `process.on("message")` under Node's `fork`.
 *
 * `stop`, SIGTERM and a closed channel all end the same way: no new work, wait
 * for a send that is already writing, release the spool, post `stopped`, exit.
 */

import { consoleLogger } from "./createRelay";
import {
  parseParentMessage,
  type ChildMessage,
  type ParentMessage,
} from "./embeddedProtocol";
import { createEmbeddedRelay, type EmbeddedRelay } from "./index";
import { SpoolLockedError } from "./spool";

type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", handler: (event: { data: unknown }) => void): void;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function post(message: ChildMessage, then?: () => void) {
  if (parentPort) {
    parentPort.postMessage(message);
    then?.();
  } else if (process.send && process.connected) {
    process.send(message, () => then?.());
  } else {
    then?.();
  }
}

/** Exit once the last message has been handed to the parent. */
function exitAfter(code: number) {
  // A utilityProcess port gives no flush callback, so leave it a moment.
  if (parentPort) setTimeout(() => process.exit(code), 100);
  else process.exit(code);
}

if (!parentPort && !process.send) {
  console.error("relay/embedded.ts must be started with a message channel (fork or utilityProcess)");
  process.exit(2);
}

let relay: EmbeddedRelay | null = null;
let printerAttached = false;
let finished = false;
let queue: Promise<void> = Promise.resolve();

async function shutdown(code: number) {
  if (finished) return;
  finished = true;
  try {
    await relay?.stop();
  } catch {
    // Nothing more to do; still report that we are done.
  }
  post({ type: "stopped" }, () => exitAfter(code));
}

async function handle(message: ParentMessage) {
  switch (message.type) {
    case "start": {
      if (relay) return;
      const { printerAttached: initial, ...options } = message.options;
      printerAttached = initial ?? false;
      try {
        relay = createEmbeddedRelay({
          ...options,
          printerAttached: () => printerAttached,
          logger: consoleLogger,
          onEvent: (event) => post({ type: "event", event }),
        });
      } catch {
        post({ type: "error", code: "invalid_options" });
        return shutdown(1);
      }
      try {
        await relay.start();
      } catch (error) {
        post({
          type: "error",
          code: error instanceof SpoolLockedError ? "spool_locked" : "unexpected",
        });
        relay = null;
        return shutdown(1);
      }
      return;
    }
    case "pause":
      relay?.pause();
      return;
    case "resume":
      relay?.resume();
      return;
    case "stop":
      return shutdown(0);
    case "printerAttached":
      printerAttached = message.attached;
      return;
    case "testPrint": {
      // Not queued: a slow cloud must not hold up pause or stop.
      if (!relay) {
        post({ type: "testPrintResult", printerId: message.printerId, ok: false, error: "unexpected" });
        return;
      }
      const result = await relay.testPrint(message.printerId);
      post({
        type: "testPrintResult",
        printerId: message.printerId,
        ok: result.ok,
        ...(result.transportOutcome ? { transportOutcome: result.transportOutcome } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }
  }
}

function receive(raw: unknown) {
  const message = parseParentMessage(raw);
  if (!message) {
    post({ type: "error", code: "bad_message" });
    return;
  }
  if (message.type === "testPrint") {
    void handle(message);
    return;
  }
  // Everything else runs in order, so a `stop` sent right after `start` waits for it.
  queue = queue.then(() => handle(message)).catch(() => undefined);
}

if (parentPort) parentPort.on("message", (event) => receive(event.data));
else process.on("message", receive);

process.on("disconnect", () => void shutdown(0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(0));
}
