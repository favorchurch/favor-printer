import { crc32, inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { StatusColor } from "../../shared";
import { encodePng, ICON_POINTS, renderIconPixels, trayIconPng } from "./trayIcons";

const COLORS: StatusColor[] = ["green", "amber", "red"];

/** Splits a PNG into chunks and checks the framing. */
function readPng(png: Buffer) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    expect(stored).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

function decode(png: Buffer) {
  const chunks = readPng(png);
  const header = chunks.find((chunk) => chunk.type === "IHDR")!.data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (stride + 1)]).toBe(0);
    raw.copy(pixels, row * stride, row * (stride + 1) + 1, (row + 1) * (stride + 1));
  }
  return { chunks, header, width, height, pixels };
}

describe("tray icons", () => {
  it.each(COLORS)("%s is a valid RGBA PNG at 1x and 2x", (color) => {
    for (const scale of [1, 2] as const) {
      const { width, height, header, chunks } = decode(trayIconPng(color, scale));
      expect([width, height]).toEqual([ICON_POINTS * scale, ICON_POINTS * scale]);
      expect([header[8], header[9]]).toEqual([8, 6]);
      expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    }
  });

  it.each(COLORS)("%s is template safe: black everywhere, shape only in alpha", (color) => {
    const { pixels } = decode(trayIconPng(color, 2));
    let drawn = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      expect([pixels[i], pixels[i + 1], pixels[i + 2]]).toEqual([0, 0, 0]);
      if (pixels[i + 3] > 0) drawn += 1;
    }
    expect(drawn).toBeGreaterThan(40);
    // Corners are empty: the icon does not fill its square.
    expect(pixels[3]).toBe(0);
    expect(pixels[pixels.length - 1]).toBe(0);
  });

  it("uses a different shape for each state, so it reads without colour", () => {
    const alphas = COLORS.map((color) => Buffer.from(renderIconPixels(color, 36)).toString("base64"));
    expect(new Set(alphas).size).toBe(3);
  });

  it("is symmetric left to right apart from the check mark", () => {
    const size = 36;
    const amber = renderIconPixels("amber", size);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size / 2; column += 1) {
        const left = amber[(row * size + column) * 4 + 3];
        const right = amber[(row * size + (size - 1 - column)) * 4 + 3];
        expect(Math.abs(left - right)).toBeLessThanOrEqual(16);
      }
    }
  });

  it("draws red as a solid disc where the other states are open rings", () => {
    const size = 36;
    const alphaAtCentreOffset = (color: StatusColor) => renderIconPixels(color, size)[(Math.floor(size * 0.5) * size + Math.floor(size * 0.3)) * 4 + 3];
    // Left of centre, outside the glyph: the red disc is filled there, the rings are not.
    expect(alphaAtCentreOffset("red")).toBeGreaterThan(200);
    expect(alphaAtCentreOffset("amber")).toBe(0);
  });

  it("encodes any pixel buffer to a PNG that decodes back to it", () => {
    const pixels = Uint8Array.from({ length: 2 * 2 * 4 }, (_, i) => (i * 37) % 256);
    expect(decode(encodePng(pixels, 2)).pixels).toEqual(Buffer.from(pixels));
  });
});
