import fs from "node:fs";
import path from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { Redis } from "@upstash/redis";

export const config = {
  runtime: "nodejs",
};

// Upstash Redis REST credentials (same names Redis.fromEnv() reads, and the
// ones shown on the database page in the Upstash console).
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------------------------------------------------------------------------
// Digit sprites
// ---------------------------------------------------------------------------
//
// /public holds one GIF per decimal digit (0.gif .. 9.gif). Each sprite is a
// complete picture with a transparent background that may itself be animated,
// with its own frame count and its own per-frame delays, so the composed
// counter keeps every character animating at the speed it was authored at.

const SPRITE_DIR = path.join(process.cwd(), "public");

// Upper bound, in centiseconds, for the composed loop. Every sprite is sampled
// with `t % its own duration`, so a character with a longer cycle simply starts
// over - the payload stays small and each request stays cheap.
const MAX_LOOP_CS = 300;

// Upper bound for the number of frames written, after identical consecutive
// states have been merged into a single frame with a longer delay.
const MAX_FRAMES = 120;

// Sentinel used for "no pixel here" while compositing (a real pixel is a
// 24-bit r<<16|g<<8|b value, which is never negative).
const TRANSPARENT = -1;

type SpriteFrame = {
  /** Full-canvas 24-bit pixels, TRANSPARENT where the frame has no pixel. */
  canvas: Int32Array;
  /** Frame delay in centiseconds. */
  delay: number;
};

type Sprite = {
  width: number;
  height: number;
  frames: SpriteFrame[];
  /** Start time (centiseconds) of each frame inside the sprite's own loop. */
  starts: number[];
  /** Total length of the sprite's own loop, in centiseconds. */
  duration: number;
};

const spriteCache = new Map<string, Sprite>();

/** Reads a GIF sub-block chain (used by every extension block). */
function readSubBlocks(buf: Buffer, start: number): { data: Buffer; next: number } {
  const parts: Buffer[] = [];
  let i = start;
  for (;;) {
    const size = buf[i];
    if (size === undefined) throw new Error("Truncated GIF sub-block chain");
    i += 1;
    if (size === 0) break;
    parts.push(buf.subarray(i, i + size));
    i += size;
  }
  return { data: Buffer.concat(parts), next: i };
}

/** GIF-flavoured LZW decoder: the inverse of lzwEncode() at the bottom. */
function lzwDecode(minCodeSize: number, data: Buffer): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out: number[] = [];
  let dict: number[][] = [];
  let codeSize = minCodeSize + 1;

  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([], []); // clear code and end code are never expanded
    codeSize = minCodeSize + 1;
  };
  reset();

  let bitPos = 0;
  let prev: number[] | null = null;

  while (bitPos + codeSize <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }

    if (code === clearCode) {
      reset();
      prev = null;
      continue;
    }
    if (code === endCode) break;

    // The decoder trails the encoder by one entry, so `code` may name the
    // entry that is about to be added.
    let entry: number[] | null = null;
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    if (!entry || entry.length === 0) {
      throw new Error(`Corrupt LZW stream (code ${code})`);
    }
    for (const px of entry) out.push(px);

    if (prev && dict.length < 4096) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }

  return Uint8Array.from(out);
}

/** Undoes GIF row interlacing (four passes over the rows). */
function deinterlace(raw: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(raw.length);
  const passes: [number, number][] = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ];
  let src = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      out.set(raw.subarray(src * width, src * width + width), y * width);
      src += 1;
    }
  }
  return out;
}

/**
 * Decodes a sprite GIF and renders every one of its frames onto a full-size
 * canvas. Sprites are usually delta-encoded (a frame only stores the rectangle
 * that changed) with disposal methods, so every frame is replayed on top of a
 * running canvas exactly like a viewer would.
 */
function decodeSprite(buf: Buffer): Sprite {
  const signature = buf.subarray(0, 6).toString("ascii");
  if (signature !== "GIF89a" && signature !== "GIF87a") {
    throw new Error("Digit sprite is not a GIF");
  }

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const screenFlags = buf[10];

  let i = 13;
  let gct: Uint8Array | null = null;
  if (screenFlags & 0x80) {
    const size = 3 * (1 << ((screenFlags & 7) + 1));
    gct = buf.subarray(i, i + size);
    i += size;
  }

  const raw: RawSpriteFrame[] = [];
  let gce = { delay: 0, disposal: 0, transparentIndex: -1 };

  while (i < buf.length) {
    const block = buf[i];

    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      // Extension: 0x21 <label> <sub-blocks...>. A Graphics Control Extension
      // (0xf9) carries the delay, the disposal method and the transparency.
      if (buf[i + 1] === 0xf9 && buf[i + 2] === 4) {
        const packed = buf[i + 3];
        gce = {
          delay: buf.readUInt16LE(i + 4),
          disposal: (packed >> 2) & 0x07,
          transparentIndex: packed & 0x01 ? buf[i + 6] : -1,
        };
      }
      i = readSubBlocks(buf, i + 2).next;
      continue;
    }

    if (block === 0x2c) {
      const frameWidth = buf.readUInt16LE(i + 5);
      const frameHeight = buf.readUInt16LE(i + 7);
      const frameFlags = buf[i + 9];

      let j = i + 10;
      let palette: Uint8Array | null = gct;
      if (frameFlags & 0x80) {
        const size = 3 * (1 << ((frameFlags & 7) + 1));
        palette = buf.subarray(j, j + size);
        j += size;
      }
      if (!palette) throw new Error("Digit sprite has no color table");

      const minCodeSize = buf[j];
      const { data, next } = readSubBlocks(buf, j + 1);
      let indices = lzwDecode(minCodeSize, data);
      if (frameFlags & 0x40) {
        indices = deinterlace(indices, frameWidth, frameHeight);
      }

      raw.push({
        left: buf.readUInt16LE(i + 1),
        top: buf.readUInt16LE(i + 3),
        width: frameWidth,
        height: frameHeight,
        indices,
        palette,
        transparentIndex: gce.transparentIndex,
        delay: gce.delay,
        disposal: gce.disposal,
      });
      i = next;
      continue;
    }

    throw new Error(`Unexpected GIF block 0x${block.toString(16)}`);
  }

  if (raw.length === 0) throw new Error("Digit sprite has no frames");
  return renderSprite(width, height, raw);
}

/** One image block of a sprite, straight out of the GIF file. */
type RawSpriteFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  indices: Uint8Array;
  palette: Uint8Array;
  transparentIndex: number;
  delay: number;
  disposal: number;
};

/**
 * Replays the image blocks of a sprite the way a viewer does - drawing every
 * frame onto a running canvas and applying its disposal method - and stores the
 * resulting full-size canvases together with the timing of the sprite's own
 * loop.
 */
function renderSprite(
  width: number,
  height: number,
  raw: RawSpriteFrame[]
): Sprite {
  const frames: SpriteFrame[] = [];
  let canvas = new Int32Array(width * height).fill(TRANSPARENT);

  for (const frame of raw) {
    const before = frame.disposal === 3 ? canvas.slice() : null;

    for (let y = 0; y < frame.height; y++) {
      const dy = frame.top + y;
      if (dy >= height) break;
      for (let x = 0; x < frame.width; x++) {
        const dx = frame.left + x;
        if (dx >= width) break;
        const index = frame.indices[y * frame.width + x];
        if (index === frame.transparentIndex) continue;
        const o = index * 3;
        if (o + 2 >= frame.palette.length) continue;
        canvas[dy * width + dx] =
          (frame.palette[o] << 16) |
          (frame.palette[o + 1] << 8) |
          frame.palette[o + 2];
      }
    }

    frames.push({ canvas: canvas.slice(), delay: frame.delay });

    if (frame.disposal === 2) {
      // Restore to background: the frame's rectangle goes back to transparent.
      for (let y = 0; y < frame.height; y++) {
        const dy = frame.top + y;
        if (dy >= height) break;
        for (let x = 0; x < frame.width; x++) {
          const dx = frame.left + x;
          if (dx >= width) break;
          canvas[dy * width + dx] = TRANSPARENT;
        }
      }
    } else if (frame.disposal === 3 && before) {
      canvas = before;
    }
  }

  const starts: number[] = [];
  let elapsed = 0;
  for (const frame of frames) {
    starts.push(elapsed);
    // A zero delay would make a frame unreachable; treat it as one tick.
    elapsed += Math.max(1, frame.delay);
  }

  return { width, height, frames, starts, duration: elapsed };
}

/** Loads (and caches for the lifetime of the instance) one digit sprite. */
function loadSprite(digit: string): Sprite {
  const cached = spriteCache.get(digit);
  if (cached) return cached;

  const file = path.join(SPRITE_DIR, `${digit}.gif`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw new Error(
      `Missing digit sprite ${file} (expected 0.gif .. 9.gif in /public)`
    );
  }

  const sprite = decodeSprite(buf);
  spriteCache.set(digit, sprite);
  return sprite;
}

/** Greatest common divisor, used to pick the timeline sampling step. */
function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Composes the counter GIF for a decimal string: one sprite per digit, drawn
 * left to right on a transparent canvas, each advancing through its own frames
 * on its own clock.
 */
function composeCounterGif(digits: string): Buffer {
  const sprites = [...digits].map(loadSprite);

  const width = sprites.reduce((sum, sprite) => sum + sprite.width, 0);
  const height = Math.max(...sprites.map((sprite) => sprite.height));
  if (width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error(`Composed sprite size out of range: ${width}x${height}`);
  }

  // --- palette -------------------------------------------------------------
  // Output index 0 is the transparent index. Its color is deliberately white:
  // GIF has no real alpha, so viewers that flatten transparency onto the
  // palette color (or fill the canvas with the background color) must land on
  // the same white the digit sprites themselves use as their transparent
  // color - otherwise those viewers show a black box behind the characters.
  // The sprites' own colors follow it and colors shared by several sprites are
  // stored once.
  const colors: number[] = [0xffffff];
  const colorLookup = new Map<number, number>();

  const indexOfColor = (rgb: number): number => {
    const known = colorLookup.get(rgb);
    if (known !== undefined) return known;

    let index: number;
    if (colors.length < 256) {
      index = colors.length;
      colors.push(rgb);
    } else {
      // Only reachable with an oversized palette: reuse the closest color.
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      index = 1;
      let best = Infinity;
      for (let c = 1; c < colors.length; c++) {
        const dr = ((colors[c] >> 16) & 0xff) - r;
        const dg = ((colors[c] >> 8) & 0xff) - g;
        const db = (colors[c] & 0xff) - b;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < best) {
          best = distance;
          index = c;
        }
      }
    }

    colorLookup.set(rgb, index);
    return index;
  };

  // Per (sprite, frame) translation table from sprite pixel to output index.
  const luts = new Map<string, Map<number, number>>();
  const lutFor = (position: number, frame: number): Map<number, number> => {
    const key = `${position}:${frame}`;
    let lut = luts.get(key);
    if (!lut) {
      lut = new Map<number, number>();
      lut.set(TRANSPARENT, 0);
      for (const rgb of sprites[position].frames[frame].canvas) {
        if (rgb !== TRANSPARENT && !lut.has(rgb)) lut.set(rgb, indexOfColor(rgb));
      }
      luts.set(key, lut);
    }
    return lut;
  };

  // --- timeline ------------------------------------------------------------
  // Sample on a grid that every frame delay divides, so a character changes
  // frame exactly when its own file says it should. Identical consecutive
  // states collapse into a single frame with a longer delay.
  let step =
    sprites.reduce(
      (acc, sprite) =>
        sprite.frames.reduce((a, frame) => gcd(a, Math.max(1, frame.delay)), acc),
      0
    ) || 10;

  const loop = Math.min(
    Math.max(...sprites.map((sprite) => sprite.duration)),
    MAX_LOOP_CS
  );
  if (loop / step > MAX_FRAMES) {
    step *= Math.ceil(loop / step / MAX_FRAMES);
  }

  const frameAt = (sprite: Sprite, t: number): number => {
    const local = t % sprite.duration;
    for (let f = sprite.starts.length - 1; f >= 0; f--) {
      if (local >= sprite.starts[f]) return f;
    }
    return 0;
  };

  const runs: { state: number[]; delay: number }[] = [];
  const steps = Math.max(1, Math.round(loop / step));
  for (let k = 0; k < steps; k++) {
    const t = k * step;
    const state = sprites.map((sprite) => frameAt(sprite, t));
    const last = runs[runs.length - 1];
    if (last && last.state.every((value, n) => value === state[n])) {
      last.delay += step;
    } else {
      runs.push({ state, delay: step });
    }
  }

  // Build the translation tables - and with them the complete color list - for
  // every frame that will actually be written, so the global color table can be
  // sized before it is emitted.
  for (const run of runs) {
    for (let p = 0; p < sprites.length; p++) lutFor(p, run.state[p]);
  }

  let gctBits = 1;
  while (1 << gctBits < colors.length) gctBits += 1;
  const gctEntries = 1 << gctBits;
  const minCodeSize = Math.max(2, gctBits);

  // --- encode --------------------------------------------------------------
  const lsd = Buffer.from([
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x80 | (gctBits - 1),
    0, // background color index (the transparent index)
    0, // pixel aspect ratio
  ]);

  const gct = Buffer.alloc(gctEntries * 3);
  colors.forEach((rgb, index) => {
    gct[index * 3] = (rgb >> 16) & 0xff;
    gct[index * 3 + 1] = (rgb >> 8) & 0xff;
    gct[index * 3 + 2] = rgb & 0xff;
  });

  const loopExt = Buffer.from([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // NETSCAPE2.0
    0x03, 0x01, 0x00, 0x00, // loop count 0: forever
    0x00, // block terminator
  ]);

  const parts: Buffer[] = [Buffer.from("GIF89a", "ascii"), lsd, gct, loopExt];
  const canvas = new Uint8Array(width * height);

  for (const run of runs) {
    canvas.fill(0); // 0 is the transparent index
    let x0 = 0;
    for (let p = 0; p < sprites.length; p++) {
      const sprite = sprites[p];
      const source = sprite.frames[run.state[p]].canvas;
      const lut = lutFor(p, run.state[p]);
      for (let y = 0; y < sprite.height; y++) {
        const dst = y * width + x0;
        const src = y * sprite.width;
        for (let x = 0; x < sprite.width; x++) {
          canvas[dst + x] = lut.get(source[src + x]) ?? 0;
        }
      }
      x0 += sprite.width;
    }

    // Graphics Control Extension: dispose to background, transparent index 0.
    const delay = Math.min(65535, Math.max(1, run.delay));
    parts.push(
      Buffer.from([
        0x21, 0xf9, 0x04, 0x09,
        delay & 0xff, (delay >> 8) & 0xff,
        0x00, // transparent color index
        0x00, // block terminator
      ]),
      // Full-canvas image descriptor, no local color table, not interlaced.
      Buffer.from([
        0x2c, 0, 0, 0, 0,
        width & 0xff, (width >> 8) & 0xff,
        height & 0xff, (height >> 8) & 0xff,
        0x00,
      ]),
      Buffer.from([minCodeSize]),
      packSubBlocks(lzwEncode(canvas, minCodeSize))
    );
  }

  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

function parseSlug(raw: unknown): string {

  if (typeof raw !== "string") {
    throw new Error("Invalid slug type");
  }
  let s = raw.startsWith("/") ? raw.slice(1) : raw;
  s = s.split("?")[0];
  // The .gif rewrite in next.config.mjs / vercel.json already drops the
  // extension, but stay tolerant when the API route is called directly
  // (/api/counter/ken/profile-views.gif).
  s = s.replace(/\.gif$/i, "");
  s = s.replace(/\/+$/, "");
  if (!s) throw new Error("Empty slug");
  return s;
}

function toRedisKey(slug: string): string {
  return slug.replace(/\//g, ":");
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method !== "GET") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const slugRaw = req.query.slug as string | string[] | undefined;
    if (!slugRaw) {
      res.status(400).send("Bad Request: missing slug");
      return;
    }

    // Catch-all route: /api/counter/ken/profile-views → ["ken", "profile-views"]
    const slug = parseSlug(
      Array.isArray(slugRaw) ? slugRaw.join("/") : slugRaw
    );
    const redisKey = toRedisKey(slug);

    let count: number;
    try {
      count = await redis.incr(redisKey);
    } catch (redisErr) {
      console.error("Redis INCR failed for key:", redisKey, redisErr);
      res.status(503).send("Counter service unavailable");
      return;
    }

    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      res.status(500).send("Unexpected counter value");
      return;
    }

    // Compose the counter GIF from the digit sprites in /public.
    let gif: Buffer;
    try {
      gif = composeCounterGif(String(count));
    } catch (renderErr) {
      console.error("GIF composition failed for count:", count, renderErr);
      res.status(500).send("Counter rendering unavailable");
      return;
    }

    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(200).send(gif);
  } catch (err) {
    console.error("Unhandled error in counter handler:", err);
    res.status(500).send("Internal server error");
  }
}

/** Splits an LZW byte stream into GIF sub-blocks (max 255 bytes each) with the
 * zero-length terminator that ends the chain. */
function packSubBlocks(data: Buffer): Buffer {
  const out: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const size = Math.min(255, data.length - offset);
    out.push(size);
    for (let i = 0; i < size; i++) out.push(data[offset + i]);
    offset += size;
  }
  out.push(0x00);
  return Buffer.from(out);
}

/**
 * Minimal GIF-flavoured LZW encoder (GIF89a appendix F): starts at
 * minCodeSize + 1 bits, grows the code width as the dictionary fills and
 * resets it before the 12-bit ceiling (4096 codes) is exceeded.
 */
function lzwEncode(pixels: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const bytes: number[] = [];
  const dict = new Map<string, number>();

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitBuffer = 0;
  let bitCount = 0;

  function emit(code: number) {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  }

  function codeFor(prefix: string | number): number {
    return typeof prefix === "number" ? prefix : dict.get(prefix)!;
  }

  emit(clearCode);

  if (pixels.length > 0) {
    let prefix: string | number = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i];
      const combined: string = `${prefix}|${k}`;
      if (dict.has(combined)) {
        prefix = combined;
        continue;
      }
      emit(codeFor(prefix));
      if (nextCode < 4096) {
        // The width has to grow *before* the entry that would not fit the
        // current width is created: the decoder lags one entry behind the
        // encoder, so widening after the insert desynchronises the stream.
        if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize += 1;
        dict.set(combined, nextCode);
        nextCode += 1;
      } else {
        // Dictionary full: start over with a clear code.
        emit(clearCode);
        dict.clear();
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
    emit(codeFor(prefix));
  }

  emit(endCode);

  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  return Buffer.from(bytes);
}
