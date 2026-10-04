/**
 * The three tray icons, drawn in code. They are macOS template images: black
 * with an alpha channel only, so the menu bar tints them for light, dark and
 * tinted bars. A template cannot carry colour, so the state is in the shape:
 *
 *   green  ring with a check mark
 *   amber  ring with an exclamation mark
 *   red    solid disc with an X cut out
 *
 * They are generated here, not shipped as files, because the packaged app
 * contains only `dist/`.
 */

import { deflateSync } from "node:zlib";

import type { StatusColor } from "../../shared";

/** Menu bar icons are 18 points high: 18 px at 1x, 36 px at 2x. */
export const ICON_POINTS = 18;

type Shape = (x: number, y: number) => boolean;

const distanceToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const radius = (x: number, y: number) => Math.hypot(x - 0.5, y - 0.5);

const SHAPES: Record<StatusColor, Shape> = {
  green: (x, y) => {
    const ring = radius(x, y) <= 0.47 && radius(x, y) >= 0.37;
    const check =
      distanceToSegment(x, y, 0.29, 0.52, 0.44, 0.67) <= 0.05 || distanceToSegment(x, y, 0.44, 0.67, 0.72, 0.35) <= 0.05;
    return ring || check;
  },
  amber: (x, y) => {
    const ring = radius(x, y) <= 0.47 && radius(x, y) >= 0.37;
    const bar = x >= 0.45 && x <= 0.55 && y >= 0.25 && y <= 0.56;
    const dot = Math.hypot(x - 0.5, y - 0.69) <= 0.065;
    return ring || bar || dot;
  },
  red: (x, y) => {
    const cross =
      distanceToSegment(x, y, 0.33, 0.33, 0.67, 0.67) <= 0.055 || distanceToSegment(x, y, 0.67, 0.33, 0.33, 0.67) <= 0.055;
    return radius(x, y) <= 0.47 && !cross;
  },
};

const SAMPLES = 4;

/** Straight RGBA, black everywhere, coverage in alpha. */
export function renderIconPixels(color: StatusColor, size: number): Uint8Array {
  const shape = SHAPES[color];
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (column + (sx + 0.5) / SAMPLES) / size;
          const y = (row + (sy + 0.5) / SAMPLES) / size;
          if (shape(x, y)) covered += 1;
        }
      }
      // RGB stays 0 (black): that is what makes it a template image.
      pixels[(row * size + column) * 4 + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

export function encodePng(pixels: Uint8Array, size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG for one colour at a scale factor (1 or 2). */
export function trayIconPng(color: StatusColor, scaleFactor: 1 | 2): Buffer {
  const size = ICON_POINTS * scaleFactor;
  return encodePng(renderIconPixels(color, size), size);
}
