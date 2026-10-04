import { describe, expect, it } from "vitest";

import type { PrinterDevice } from "../../shared";
import {
  assertQueueName,
  findQueue,
  isSameDevice,
  isValidQueueName,
  parseLpstatDevices,
  parseLpstatPrinters,
  queueNameFor,
} from "./queue";

const URI_A = "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123";
const URI_B = "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800999";

const device = (overrides: Partial<PrinterDevice> = {}): PrinterDevice => ({
  id: URI_A,
  deviceUri: URI_A,
  usbSerial: "D2J190800123",
  model: "ZD421-203dpi ZPL",
  ...overrides,
});

describe("queue name validation", () => {
  it.each(["Zebra_ZD421", "Favor_D2J190800123", "a.b-c_d", "Z"])("accepts %j", (name) => {
    expect(isValidQueueName(name)).toBe(true);
    expect(assertQueueName(name)).toBe(name);
  });

  it.each([
    "",
    "   ",
    "-p",
    "--help",
    "has space",
    "semi;colon",
    "$(reboot)",
    "back`tick`",
    "a/b",
    "a|b",
    "new\nline",
    "Zebraé",
    "x".repeat(128),
  ])("rejects %j", (name) => {
    expect(isValidQueueName(name)).toBe(false);
    expect(() => assertQueueName(name)).toThrow();
  });

  it("accepts the longest name CUPS allows", () => {
    expect(isValidQueueName("x".repeat(127))).toBe(true);
  });
});

describe("queueNameFor", () => {
  it("names the queue after the serial", () => {
    expect(queueNameFor(device())).toBe("Favor_D2J190800123");
  });

  it("falls back to the model when there is no serial", () => {
    expect(queueNameFor(device({ usbSerial: null }))).toBe("Favor_ZD421-203dpi_ZPL");
  });

  it("reduces unsafe characters", () => {
    expect(queueNameFor(device({ usbSerial: "D2J/1 8;x" }))).toBe("Favor_D2J_1_8_x");
  });

  it("uses a fixed name when nothing usable is left", () => {
    expect(queueNameFor(device({ usbSerial: "///" }))).toBe("Favor_Zebra");
  });

  it("always produces a name the relay accepts, however long the serial", () => {
    const name = queueNameFor(device({ usbSerial: "S".repeat(300) }));
    expect(name.length).toBeLessThanOrEqual(127);
    expect(isValidQueueName(name)).toBe(true);
  });
});

describe("parseLpstatDevices", () => {
  it("reads queue names and device URIs", () => {
    const output = [`device for Favor_D2J190800123: ${URI_A}`, "device for Office_Laser: ipp://printer.local/ipp/print"].join("\n");
    expect(parseLpstatDevices(output)).toEqual([
      { queue: "Favor_D2J190800123", deviceUri: URI_A },
      { queue: "Office_Laser", deviceUri: "ipp://printer.local/ipp/print" },
    ]);
  });

  it("returns nothing for the no-queues message", () => {
    expect(parseLpstatDevices("lpstat: No destinations added.\n")).toEqual([]);
    expect(parseLpstatDevices("")).toEqual([]);
  });
});

describe("parseLpstatPrinters", () => {
  it("tells enabled from disabled queues", () => {
    const output = [
      "printer Favor_D2J190800123 is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT",
      "printer Old_Zebra disabled since Sat 04 Oct 2026 09:00:00 PHT -",
      "\treason unknown",
      "printer Busy now printing Busy-12.  enabled since Sat 04 Oct 2026 08:00:00 PHT",
    ].join("\n");
    expect([...parseLpstatPrinters(output)]).toEqual([
      ["Favor_D2J190800123", true],
      ["Old_Zebra", false],
      ["Busy", true],
    ]);
  });

  it("returns nothing when there are no queues", () => {
    expect(parseLpstatPrinters("lpstat: No destinations added.").size).toBe(0);
  });
});

describe("isSameDevice", () => {
  it("matches identical URIs", () => {
    expect(isSameDevice(URI_A, URI_A)).toBe(true);
  });

  it("matches the same serial when the rest of the URI differs", () => {
    expect(isSameDevice(URI_A, "usb://Zebra%20Technologies/ZTC%20ZD421?serial=D2J190800123")).toBe(true);
  });

  it("separates two printers with different serials", () => {
    expect(isSameDevice(URI_A, URI_B)).toBe(false);
  });

  it("does not match a URI with a serial to one without", () => {
    expect(isSameDevice(URI_A, "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL")).toBe(false);
  });

  it("does not match equal serials across a Zebra and a non-Zebra URI", () => {
    const zebra = "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=SN12345";
    const other = "usb://DYMO/LabelWriter%20450?serial=SN12345";
    expect(isSameDevice(zebra, other)).toBe(false);
    expect(isSameDevice(other, zebra)).toBe(false);
  });

  it("does not bind a non-Zebra queue that has the Zebra's serial", () => {
    const zebra = device({ deviceUri: "usb://Zebra%20Technologies/ZTC%20ZD421?serial=SN12345", usbSerial: "SN12345" });
    const found = findQueue(
      zebra,
      [{ queue: "Label_Printer", deviceUri: "usb://DYMO/LabelWriter%20450?serial=SN12345" }],
      new Map([["Label_Printer", true]]),
    );
    expect(found).toEqual({ state: "missing", queue: null });
  });

  it("matches the same make in any letter case, and any two Zebra spellings", () => {
    expect(isSameDevice("usb://ACME/Model%20A?serial=S1", "usb://acme/Model%20B?serial=S1")).toBe(true);
    expect(isSameDevice("usb://Zebra/ZD620?serial=S1", "usb://Zebra%20Technologies/ZTC%20ZD620?serial=S1")).toBe(true);
  });

  it("does not match different makes that are both unlike Zebra", () => {
    expect(isSameDevice("usb://HP/Laser?serial=S1", "usb://DYMO/Label?serial=S1")).toBe(false);
  });

  it("does not match a non-USB URI", () => {
    expect(isSameDevice(URI_A, "ipp://printer.local/ipp/print")).toBe(false);
  });
});

describe("findQueue (reuse vs create)", () => {
  it("reuses an enabled queue bound to the device, whatever it is called", () => {
    const found = findQueue(device(), [{ queue: "My_Zebra", deviceUri: URI_A }], new Map([["My_Zebra", true]]));
    expect(found).toEqual({ state: "ready", queue: "My_Zebra" });
  });

  it("reports a disabled queue", () => {
    const found = findQueue(device(), [{ queue: "My_Zebra", deviceUri: URI_A }], new Map([["My_Zebra", false]]));
    expect(found).toEqual({ state: "disabled", queue: "My_Zebra" });
  });

  it("reports missing when no queue points at the device", () => {
    const found = findQueue(device(), [{ queue: "Other_Zebra", deviceUri: URI_B }], new Map([["Other_Zebra", true]]));
    expect(found).toEqual({ state: "missing", queue: null });
    expect(findQueue(device(), [], new Map())).toEqual({ state: "missing", queue: null });
  });

  it("prefers the enabled queue when several point at the device", () => {
    const found = findQueue(
      device(),
      [
        { queue: "Old", deviceUri: URI_A },
        { queue: "New", deviceUri: URI_A },
      ],
      new Map([
        ["Old", false],
        ["New", true],
      ]),
    );
    expect(found).toEqual({ state: "ready", queue: "New" });
  });

  it("never reports ready for a queue whose enabled state is unknown", () => {
    // lpstat -p did not list the queue, so nothing says it is enabled.
    const found = findQueue(device(), [{ queue: "My_Zebra", deviceUri: URI_A }], new Map());
    expect(found).toEqual({ state: "disabled", queue: "My_Zebra" });
    expect(found.state).not.toBe("ready");
  });

  it("does not let another queue's enabled state stand in for an unlisted one", () => {
    const found = findQueue(
      device(),
      [{ queue: "My_Zebra", deviceUri: URI_A }],
      new Map([["Some_Other_Queue", true]]),
    );
    expect(found.state).toBe("disabled");
  });

  it("is ready only when lpstat -p said enabled", () => {
    const devices = [{ queue: "My_Zebra", deviceUri: URI_A }];
    expect(findQueue(device(), devices, new Map([["My_Zebra", true]])).state).toBe("ready");
    expect(findQueue(device(), devices, new Map([["My_Zebra", false]])).state).toBe("disabled");
    expect(findQueue(device(), devices, new Map()).state).toBe("disabled");
  });
});
