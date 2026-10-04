/**
 * Raw TCP 9100 transport to a Zebra printer.
 *
 * The result separates "definitely nothing was written" from "bytes may have
 * gone out", because the cloud only retries the first kind. The line is drawn at
 * `hooks.beforeWrite`: everything that fails before it is `unsent`, everything
 * after it that is not a clean flush is `ambiguous`.
 */

import net from "node:net";

import type { PrinterTarget } from "./protocol";

export type SendHooks = {
  /** Runs once the connection is open. Resolve `false` to abort without writing. */
  beforeWrite(): Promise<boolean>;
};

export type SendResult =
  | { kind: "sent" }
  /** The connection never opened; no bytes were written. */
  | { kind: "unsent"; error: string }
  /** `beforeWrite` declined or threw; no bytes were written. */
  | { kind: "aborted" }
  /** Bytes may have been written and the flush was not confirmed. */
  | { kind: "ambiguous"; error: string };

export type ProbeResult = {
  reachable: boolean;
  error?: string;
  /** The transport reached the queue but cannot read printer status (USB via CUPS). */
  status?: "status_unknown";
};

export interface PrinterTransport {
  /** True when the transport never sees printer status, so health is `status_unknown`. */
  readonly statusUnknown?: boolean;
  send(target: PrinterTarget, zpl: string, hooks: SendHooks): Promise<SendResult>;
  probe(target: PrinterTarget): Promise<ProbeResult>;
}

export type TcpTransportOptions = {
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function connect(target: PrinterTarget, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`connect to ${target.host}:${target.port} timed out`)),
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      // A later reset must never surface as an uncaught exception. Callers
      // learn about it from `socket.destroyed` and their own handlers.
      socket.on("error", () => undefined);
      resolve(socket);
    });
  });
}

export function createTcpTransport(options: TcpTransportOptions = {}): PrinterTransport {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const writeTimeoutMs = options.writeTimeoutMs ?? 10_000;

  return {
    async send(target, zpl, hooks) {
      let socket: net.Socket;
      try {
        socket = await connect(target, connectTimeoutMs);
      } catch (error) {
        return { kind: "unsent", error: message(error) };
      }

      try {
        if (!(await hooks.beforeWrite())) {
          socket.destroy();
          return { kind: "aborted" };
        }
      } catch {
        socket.destroy();
        return { kind: "aborted" };
      }

      // The connection dropped while we were telling the cloud. Nothing was
      // written, but the cloud already believes a send started, so say so.
      if (socket.destroyed) {
        return { kind: "ambiguous", error: "connection closed before the write" };
      }

      return new Promise<SendResult>((resolve) => {
        let settled = false;
        const settle = (result: SendResult) => {
          if (settled) return;
          settled = true;
          socket.setTimeout(0);
          socket.destroy();
          resolve(result);
        };
        const fail = (error: Error) => settle({ kind: "ambiguous", error: error.message });

        socket.once("error", fail);
        socket.once("close", () => fail(new Error("connection closed before the write completed")));
        socket.setTimeout(writeTimeoutMs, () => fail(new Error("write timed out")));
        // The callback fires once the data and the FIN are flushed to the kernel.
        socket.end(zpl, "utf8", (error?: Error | null) =>
          error ? fail(error) : settle({ kind: "sent" }),
        );
      });
    },

    async probe(target) {
      try {
        (await connect(target, Math.min(connectTimeoutMs, 3_000))).destroy();
        return { reachable: true };
      } catch (error) {
        return { reachable: false, error: message(error) };
      }
    },
  };
}
