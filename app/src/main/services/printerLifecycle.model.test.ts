/**
 * Model test for the printer lifecycle: a stateful fake CUPS, driven by random
 * sequences of plug, unplug, queue changes, lpstat and lpadmin failures, scans
 * and set-ups. After every step the service must agree with a small model, and
 * CUPS must never hold more than one queue for the Zebra.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PrinterDevice } from "../../shared";
import { BINARIES, type CommandResult } from "./command";
import { createPrinterService, type PrinterService } from "./printerService";
import { fail, ok } from "./testing/fakes";
import { propertyParams } from "../../shared/testing/property";

const SERIAL = "D2J190800123";
const URI = `usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=${SERIAL}`;
const DEVICE: PrinterDevice = { id: URI, deviceUri: URI, usbSerial: SERIAL, model: "ZD421-203dpi ZPL" };
const CREATED_QUEUE = `Favor_${SERIAL}`;

type Model = {
  attached: boolean;
  lpstatBroken: boolean;
  lpadminRefuses: boolean;
  queue: { name: string; enabled: boolean } | null;
};

/** What CUPS holds. lpadmin really changes it, so a bad set-up shows up as a duplicate or a missing queue. */
class FakeCups {
  attached = false;
  lpstatBroken = false;
  lpadminRefuses = false;
  readonly queues = new Map<string, { uri: string; enabled: boolean }>();

  run = async (file: string, args: readonly string[]): Promise<CommandResult> => {
    if (file === BINARIES.lpinfo) return ok(["network ipp", ...(this.attached ? [`direct ${URI}`] : [])].join("\n"));
    if (file === BINARIES.lpstat) {
      if (this.lpstatBroken) return fail(1, "lpstat: Bad file descriptor");
      if (this.queues.size === 0) return fail(1, "lpstat: No destinations added.");
      const lines = [...this.queues].map(([name, queue]) =>
        args[0] === "-v"
          ? `device for ${name}: ${queue.uri}`
          : `printer ${name} ${queue.enabled ? "is idle.  enabled" : "disabled"} since Sat 04 Oct 2026 10:00:00 PHT`,
      );
      return ok(lines.join("\n"));
    }
    if (file === BINARIES.lpadmin) {
      if (this.lpadminRefuses) return fail(1, "lpadmin: Forbidden");
      const name = args[args.indexOf("-p") + 1];
      const uri = args.includes("-v") ? args[args.indexOf("-v") + 1] : this.queues.get(name)?.uri;
      if (!uri) return fail(1, "lpadmin: The printer or class does not exist.");
      this.queues.set(name, { uri, enabled: args.includes("-E") });
      return ok("");
    }
    throw new Error(`unexpected command ${file}`);
  };
}

type Real = { cups: FakeCups; service: PrinterService };

type Command = fc.AsyncCommand<Model, Real>;

const command = (name: string, step: (model: Model, real: Real) => void | Promise<void>, check: (model: Model) => boolean = () => true): Command => ({
  check,
  async run(model, real) {
    await step(model, real);
    // Never two queues for one Zebra, whatever happened.
    expect(real.cups.queues.size).toBeLessThanOrEqual(1);
  },
  toString: () => name,
});

const setFlag = (flag: "attached" | "lpstatBroken" | "lpadminRefuses", value: boolean) =>
  command(`${flag}=${value}`, (model, real) => {
    model[flag] = value;
    real.cups[flag] = value;
  });

const disableQueue = command(
  "disable queue",
  (model, real) => {
    model.queue!.enabled = false;
    real.cups.queues.get(model.queue!.name)!.enabled = false;
  },
  (model) => model.queue !== null,
);

const deleteQueue = command(
  "delete queue",
  (model, real) => {
    real.cups.queues.delete(model.queue!.name);
    model.queue = null;
  },
  (model) => model.queue !== null,
);

/** A queue someone made by hand, under a name of their own. */
const addHandMadeQueue = (enabled: boolean) =>
  command(
    `hand-made queue enabled=${enabled}`,
    (model, real) => {
      real.cups.queues.set("My_Zebra", { uri: URI, enabled });
      model.queue = { name: "My_Zebra", enabled };
    },
    (model) => model.queue === null,
  );

const scan = command("scan", async (model, real) => {
  const outcome = await real.service.scan(null);
  if (!model.attached) {
    expect(outcome).toEqual({ scan: { kind: "none" }, queue: null, listFailed: false });
    return;
  }
  const found = { kind: "found", devices: [DEVICE], selectedId: URI };
  if (model.lpstatBroken) {
    expect(outcome).toEqual({ scan: { ...found, queue: "disabled" }, queue: null, listFailed: true });
  } else if (!model.queue) {
    expect(outcome).toEqual({ scan: { ...found, queue: "missing" }, queue: null, listFailed: false });
  } else {
    const state = model.queue.enabled ? "ready" : "disabled";
    expect(outcome).toEqual({ scan: { ...found, queue: state }, queue: model.queue.name, listFailed: false });
  }
});

const setUp = command("setUp", async (model, real) => {
  const outcome = await real.service.setUp(DEVICE);
  if (model.lpstatBroken) {
    expect(outcome).toEqual({ ok: false, reason: "failed", queue: null });
  } else if (model.queue?.enabled) {
    expect(outcome).toEqual({ ok: true, queue: model.queue.name });
  } else if (model.lpadminRefuses) {
    expect(outcome).toEqual({ ok: false, reason: "permission", queue: null });
  } else {
    model.queue = { name: model.queue?.name ?? CREATED_QUEUE, enabled: true };
    expect(outcome).toEqual({ ok: true, queue: model.queue.name });
  }
  // CUPS now holds exactly what the model says.
  expect([...real.cups.queues].map(([name, queue]) => ({ name, enabled: queue.enabled, uri: queue.uri }))).toEqual(
    model.queue ? [{ ...model.queue, uri: URI }] : [],
  );
});

const commands = [
  fc.boolean().map((value) => setFlag("attached", value)),
  fc.boolean().map((value) => setFlag("lpstatBroken", value)),
  fc.boolean().map((value) => setFlag("lpadminRefuses", value)),
  fc.boolean().map(addHandMadeQueue),
  fc.constant(disableQueue),
  fc.constant(deleteQueue),
  fc.constant(scan),
  fc.constant(setUp),
];

describe("printer lifecycle model", () => {
  it("scan and setUp agree with the model through any sequence of CUPS events", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 30 }), async (sequence) => {
        const cups = new FakeCups();
        await fc.asyncModelRun(
          () => ({
            model: { attached: false, lpstatBroken: false, lpadminRefuses: false, queue: null },
            real: { cups, service: createPrinterService({ run: cups.run }) },
          }),
          sequence,
        );
      }),
      propertyParams(150),
    );
  });
});
