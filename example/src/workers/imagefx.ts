// An image pipeline running off the JS thread.
//
// The pixels live in a SharedBuffer — one block of native memory both runtimes
// put a typed-array view over. Filtering 192x192 RGBA means touching 147k bytes;
// as messages that would be a structured clone per pass in each direction. Here
// nothing is copied: the worker writes the same memory the host allocated.
//
// Only the finished PNG crosses the bridge, because that is the only thing the
// host actually needs — a string it can hand to <Image>.
// `export {}` makes this a module, so its top-level names stay local. Worker
// files otherwise share one global scope in the typechecker and collide.
export {};

declare const SharedBuffer: any;

const app: any = (globalThis as any).parent;

let W = 0;
let H = 0;
let src: Uint8Array | null = null;
let dst: Uint8Array | null = null;

// ---------------------------------------------------------------- filters
// Each reads `src` and writes `dst`. Straight scalar loops — the point is that
// they are slow enough to matter, and that being slow costs the UI nothing.

function grayscale(s: Uint8Array, d: Uint8Array) {
  for (let i = 0; i < s.length; i += 4) {
    const g = (s[i]! * 0.299 + s[i + 1]! * 0.587 + s[i + 2]! * 0.114) | 0;
    d[i] = g;
    d[i + 1] = g;
    d[i + 2] = g;
    d[i + 3] = s[i + 3]!;
  }
}

function invert(s: Uint8Array, d: Uint8Array) {
  for (let i = 0; i < s.length; i += 4) {
    d[i] = 255 - s[i]!;
    d[i + 1] = 255 - s[i + 1]!;
    d[i + 2] = 255 - s[i + 2]!;
    d[i + 3] = s[i + 3]!;
  }
}

function sepia(s: Uint8Array, d: Uint8Array) {
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i]!;
    const g = s[i + 1]!;
    const b = s[i + 2]!;
    d[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
    d[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
    d[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
    d[i + 3] = s[i + 3]!;
  }
}

/** Separable box blur, `passes` times — approximates a gaussian and is the
 *  heaviest filter here on purpose. */
function blur(s: Uint8Array, d: Uint8Array, radius: number, passes: number) {
  d.set(s);
  const tmp = new Uint8Array(d.length);
  for (let p = 0; p < passes; p++) {
    boxPass(d, tmp, radius, true);
    boxPass(tmp, d, radius, false);
  }
}

function boxPass(
  s: Uint8Array,
  d: Uint8Array,
  radius: number,
  horizontal: boolean
) {
  const outer = horizontal ? H : W;
  const inner = horizontal ? W : H;
  const step = horizontal ? 4 : W * 4;
  const lineStep = horizontal ? W * 4 : 4;

  for (let o = 0; o < outer; o++) {
    const base = o * lineStep;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < inner; i++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = i + k;
          if (j < 0 || j >= inner) continue;
          sum += s[base + j * step + c]!;
          n++;
        }
        d[base + i * step + c] = (sum / n) | 0;
      }
    }
    for (let i = 0; i < inner; i++) {
      d[base + i * step + 3] = s[base + i * step + 3]!;
    }
  }
}

function pixelate(s: Uint8Array, d: Uint8Array, block: number) {
  for (let by = 0; by < H; by += block) {
    for (let bx = 0; bx < W; bx += block) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = by; y < Math.min(by + block, H); y++) {
        for (let x = bx; x < Math.min(bx + block, W); x++) {
          const i = (y * W + x) * 4;
          r += s[i]!;
          g += s[i + 1]!;
          b += s[i + 2]!;
          n++;
        }
      }
      r = (r / n) | 0;
      g = (g / n) | 0;
      b = (b / n) | 0;
      for (let y = by; y < Math.min(by + block, H); y++) {
        for (let x = bx; x < Math.min(bx + block, W); x++) {
          const i = (y * W + x) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = s[i + 3]!;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- PNG encode
// A minimal encoder: RGBA, no interlacing, and deflate "stored" blocks so there
// is no compressor to write. Bigger output than a real encoder, but it is a
// handful of lines and every platform decodes it.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function encodePng(pixels: Uint8Array): string {
  // Raw scanlines: one filter byte (0 = None) per row, then the row's RGBA.
  const raw = new Uint8Array(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const o = y * (1 + W * 4);
    raw[o] = 0;
    raw.set(pixels.subarray(y * W * 4, (y + 1) * W * 4), o + 1);
  }

  // zlib stream with stored deflate blocks (max 65535 bytes each).
  const blocks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let p = 0;
  z[p++] = 0x78;
  z[p++] = 0x01;
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    z[p++] = i + len >= raw.length ? 1 : 0; // BFINAL, BTYPE=00
    z[p++] = len & 0xff;
    z[p++] = (len >> 8) & 0xff;
    z[p++] = ~len & 0xff;
    z[p++] = (~len >> 8) & 0xff;
    z.set(raw.subarray(i, i + len), p);
    p += len;
  }
  const ad = adler32(raw);
  z[p++] = (ad >>> 24) & 0xff;
  z[p++] = (ad >>> 16) & 0xff;
  z[p++] = (ad >>> 8) & 0xff;
  z[p++] = ad & 0xff;

  const out = new Uint8Array(8 + 25 + (12 + z.length) + 12);
  let q = 0;
  const u8 = (v: number) => {
    out[q++] = v & 0xff;
  };
  const u32 = (v: number) => {
    out[q++] = (v >>> 24) & 0xff;
    out[q++] = (v >>> 16) & 0xff;
    out[q++] = (v >>> 8) & 0xff;
    out[q++] = v & 0xff;
  };
  const chunk = (type: string, body: () => void) => {
    u32(0); // length, patched below
    const lenAt = q - 4;
    const typeAt = q;
    for (let i = 0; i < 4; i++) u8(type.charCodeAt(i));
    body();
    const dataLen = q - typeAt - 4;
    out[lenAt] = (dataLen >>> 24) & 0xff;
    out[lenAt + 1] = (dataLen >>> 16) & 0xff;
    out[lenAt + 2] = (dataLen >>> 8) & 0xff;
    out[lenAt + 3] = dataLen & 0xff;
    u32(crc32(out, typeAt, q));
  };

  for (const b of [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) u8(b);
  chunk('IHDR', () => {
    u32(W);
    u32(H);
    u8(8); // bit depth
    u8(6); // colour type: RGBA
    u8(0);
    u8(0);
    u8(0);
  });
  chunk('IDAT', () => {
    out.set(z, q);
    q += z.length;
  });
  chunk('IEND', () => {});

  return base64(out.subarray(0, q));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    s +=
      B64[(n >> 18) & 63]! +
      B64[(n >> 12) & 63]! +
      B64[(n >> 6) & 63]! +
      B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    s +=
      B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return s;
}

// ---------------------------------------------------------------- module

app.register('imagefx', {
  /**
   * Opens the two shared blocks by name and paints a source image into one.
   * The host allocated them; we get views over the very same bytes.
   */
  init(srcName: string, dstName: string, width: number, height: number) {
    W = width;
    H = height;
    const bytes = W * H * 4;
    src = new Uint8Array(new SharedBuffer(srcName, bytes).arrayBuffer);
    dst = new Uint8Array(new SharedBuffer(dstName, bytes).arrayBuffer);

    // A synthetic photo: colour field plus a few discs, enough structure that
    // every filter is visibly different.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let r = (x / W) * 255;
        let g = (y / H) * 255;
        let b = 200 - ((x + y) / (W + H)) * 200;
        for (const c of [
          { cx: 0.3, cy: 0.35, rad: 0.2, col: [255, 220, 60] },
          { cx: 0.68, cy: 0.3, rad: 0.14, col: [40, 160, 255] },
          { cx: 0.5, cy: 0.72, rad: 0.22, col: [230, 60, 120] },
        ]) {
          const dx = x / W - c.cx;
          const dy = y / H - c.cy;
          if (dx * dx + dy * dy < c.rad * c.rad) {
            r = c.col[0]!;
            g = c.col[1]!;
            b = c.col[2]!;
          }
        }
        src[i] = r | 0;
        src[i + 1] = g | 0;
        src[i + 2] = b | 0;
        src[i + 3] = 255;
      }
    }
    dst.set(src);
    return { bytes, png: encodePng(src) };
  },

  /**
   * Runs a filter over the shared pixels and returns the encoded result.
   * `filterMs` is the pixel work alone; `encodeMs` is turning it into something
   * <Image> can show. Neither happened on the JS thread.
   */
  apply(filter: string) {
    if (!src || !dst) throw new Error('call init() first');
    const t0 = Date.now();
    switch (filter) {
      case 'grayscale':
        grayscale(src, dst);
        break;
      case 'invert':
        invert(src, dst);
        break;
      case 'sepia':
        sepia(src, dst);
        break;
      case 'blur':
        blur(src, dst, 4, 3);
        break;
      case 'pixelate':
        pixelate(src, dst, 12);
        break;
      default:
        dst.set(src);
    }
    const t1 = Date.now();
    const png = encodePng(dst);
    return { filter, filterMs: t1 - t0, encodeMs: Date.now() - t1, png };
  },

  /** Frees the shared pixel blocks — the largest allocation in this example. */
  release(srcName: string, dstName: string) {
    src = null;
    dst = null;
    SharedBuffer.delete(srcName);
    SharedBuffer.delete(dstName);
    return true;
  },
});
