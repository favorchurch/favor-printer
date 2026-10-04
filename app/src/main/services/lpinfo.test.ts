import { describe, expect, it } from "vitest";

import { parseLpinfo, parseUsbUri } from "./lpinfo";

const ZD421 = "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123";
const ZD621 = "usb://Zebra%20Technologies/ZTC%20ZD621-300dpi%20ZPL?serial=D2J190800999";

const listing = (...lines: string[]) =>
  ["network http", "network https", "network ipp", "network lpd", ...lines, "network socket"].join("\n");

describe("parseLpinfo", () => {
  it("finds no device in empty output", () => {
    expect(parseLpinfo("")).toEqual([]);
  });

  it("finds no device when only network backends are listed", () => {
    expect(parseLpinfo(listing())).toEqual([]);
  });

  it("finds one Zebra", () => {
    expect(parseLpinfo(listing(`direct ${ZD421}`))).toEqual([
      { id: ZD421, deviceUri: ZD421, usbSerial: "D2J190800123", model: "ZD421-203dpi ZPL" },
    ]);
  });

  it("finds several Zebras in the order CUPS listed them", () => {
    const devices = parseLpinfo(listing(`direct ${ZD621}`, `direct ${ZD421}`));
    expect(devices.map((device) => device.usbSerial)).toEqual(["D2J190800999", "D2J190800123"]);
    expect(new Set(devices.map((device) => device.id)).size).toBe(2);
  });

  it("ignores USB devices that are not Zebras", () => {
    const hp = "usb://HP/LaserJet%20Pro%20M404?serial=PHBHK12345";
    const dymo = "usb://DYMO/LabelWriter%20450?serial=1234";
    expect(parseLpinfo(listing(`direct ${hp}`, `direct ${dymo}`))).toEqual([]);
    expect(parseLpinfo(listing(`direct ${hp}`, `direct ${ZD421}`, `direct ${dymo}`))).toHaveLength(1);
  });

  it("ignores lines that are not direct usb:// URIs", () => {
    const lines = [
      "direct hp",
      `network ${ZD421}`,
      "direct usb:/malformed",
      "file cups-brf:/",
      "network socket://192.168.1.50:9100",
      "",
    ].join("\n");
    expect(parseLpinfo(lines)).toEqual([]);
  });

  it("accepts a short make name and any letter case", () => {
    const devices = parseLpinfo("direct usb://Zebra/ZD620?serial=X1\ndirect usb://ZEBRA%20Technologies/ZD410?serial=X2");
    expect(devices.map((device) => device.model)).toEqual(["ZD620", "ZD410"]);
  });

  it("decodes URL-encoded serials", () => {
    const [device] = parseLpinfo("direct usb://Zebra%20Technologies/ZTC%20ZD421?serial=D2J%2F190%20800");
    expect(device.usbSerial).toBe("D2J/190 800");
  });

  it("keeps a literal plus sign in a serial", () => {
    const [device] = parseLpinfo("direct usb://Zebra%20Technologies/ZTC%20ZD421?serial=AB+CD");
    expect(device.usbSerial).toBe("AB+CD");
  });

  it("keeps a malformed escape instead of throwing", () => {
    const [device] = parseLpinfo("direct usb://Zebra%20Technologies/ZTC%20ZD421?serial=AB%E0%A4%A");
    expect(device.usbSerial).toBe("AB%E0%A4%A");
  });

  it("reports a null serial when the URI has none, or an empty one", () => {
    const devices = parseLpinfo(
      "direct usb://Zebra%20Technologies/ZTC%20ZD421\ndirect usb://Zebra%20Technologies/ZTC%20ZD621?serial=\n",
    );
    expect(devices.map((device) => device.usbSerial)).toEqual([null, null]);
  });

  it("reads the serial when other query parameters come first", () => {
    const [device] = parseLpinfo("direct usb://Zebra%20Technologies/ZTC%20ZD421?foo=1&serial=ABC&bar=2");
    expect(device.usbSerial).toBe("ABC");
  });

  it("lists a device once", () => {
    expect(parseLpinfo(listing(`direct ${ZD421}`, `direct ${ZD421}`))).toHaveLength(1);
  });

  it("handles Windows line endings", () => {
    expect(parseLpinfo(`network ipp\r\ndirect ${ZD421}\r\n`)).toHaveLength(1);
  });
});

describe("parseUsbUri", () => {
  it("splits make, model and serial", () => {
    expect(parseUsbUri(ZD421)).toEqual({ make: "Zebra Technologies", model: "ZTC ZD421-203dpi ZPL", serial: "D2J190800123" });
  });

  it("rejects other schemes", () => {
    expect(parseUsbUri("socket://10.0.0.5:9100")).toBeNull();
    expect(parseUsbUri("usb://onlymake")).toBeNull();
  });
});
