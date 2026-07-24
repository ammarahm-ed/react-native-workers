// Map-reduce over a large log, using nested workers.
//
// This worker is a COORDINATOR. It owns the corpus, splits it into ranges, and
// spawns child workers — real Hermes runtimes on real threads, so this is
// genuine parallelism, not interleaving. Each child opens the same SharedBuffer
// by name and parses its own byte range; only the small partial counts come
// back. The 3MB of log text is never copied to anyone.
//
// Splitting on bytes means chunk edges land mid-line, so each child aligns
// itself: skip to after the first newline, and run past its end to finish the
// last line it started. Every line is parsed exactly once.
export {};

declare const SharedBuffer: any;
declare const Worker: any;

const app: any = (globalThis as any).parent;

const PATHS = [
  '/api/users',
  '/api/orders',
  '/static/app.js',
  '/health',
  '/api/search?q=workers',
];

let bufName = '';
let capacity = 0;
let used = 0;

// Each child parses a byte range of the shared corpus and returns its tallies.
// ES5 on purpose: this is a source string, not a compiled module.
const CHILD = `
self.onmessage = function (e) {
  var d = e.data;
  var v = new Uint8Array(new SharedBuffer(d.name, d.capacity).arrayBuffer);
  var t0 = Date.now();

  var i = d.start;
  var stop = d.end;
  // A chunk that does not start the file begins mid-line; that partial line
  // belongs to the previous chunk, so skip past it.
  if (i > 0) { while (i < d.used && v[i - 1] !== 10) i++; }
  // Finish the line running past our end, so no line is split between chunks.
  while (stop < d.used && v[stop - 1] !== 10) stop++;

  var lines = 0, bytes = 0, ok = 0, missing = 0, error = 0, max = 0;
  while (i < stop) {
    var st = (v[i] - 48) * 100 + (v[i + 1] - 48) * 10 + (v[i + 2] - 48);
    i += 4;
    var b = 0;
    while (i < stop && v[i] !== 32) { b = b * 10 + (v[i] - 48); i++; }
    i++;
    while (i < stop && v[i] !== 10) i++;
    i++;
    lines++; bytes += b;
    if (b > max) max = b;
    if (st === 200) ok++; else if (st === 404) missing++; else error++;
  }

  self.postMessage({
    lines: lines, bytes: bytes, ok: ok, missing: missing, error: error,
    max: max, ms: Date.now() - t0, scanned: stop - d.start
  });
};
`;

function parseChunk(start: number, end: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = new Worker({ inline: CHILD });
    const timer = setTimeout(() => {
      child.terminate();
      reject(new Error('chunk timed out'));
    }, 30000);
    child.onmessage = (e: any) => {
      clearTimeout(timer);
      child.terminate();
      resolve(e.data);
    };
    child.onerror = (e: any) => {
      clearTimeout(timer);
      child.terminate();
      reject(new Error(e.message));
    };
    child.postMessage({ name: bufName, capacity, used, start, end });
  });
}

const mod = app.register('parse', {
  /** Generates the corpus straight into shared memory. */
  prepare(name: string, lines: number) {
    bufName = name;
    capacity = lines * 40;
    const v = new Uint8Array(new SharedBuffer(name, capacity).arrayBuffer);

    let p = 0;
    const putNum = (n: number) => {
      const s = String(n);
      for (let k = 0; k < s.length; k++) v[p++] = s.charCodeAt(k);
    };
    const putStr = (s: string) => {
      for (let k = 0; k < s.length; k++) v[p++] = s.charCodeAt(k);
    };

    for (let i = 0; i < lines; i++) {
      // status bytes path\n — fixed shape so the child can scan it bytewise.
      putNum(i % 17 === 0 ? 404 : i % 53 === 0 ? 500 : 200);
      v[p++] = 32;
      putNum(200 + ((i * 37) % 9000));
      v[p++] = 32;
      putStr(PATHS[i % PATHS.length]!);
      v[p++] = 10;
    }
    used = p;
    return { lines, capacity, used };
  },

  /**
   * Parses the corpus across `n` child workers. n=1 is the honest baseline:
   * same code, same chunking, one runtime.
   */
  async run(n: number) {
    const t0 = Date.now();
    const chunk = Math.ceil(used / n);
    let finished = 0;

    const parts = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        parseChunk(i * chunk, Math.min(used, (i + 1) * chunk)).then((r) => {
          finished++;
          mod.emit('progress', { finished, total: n });
          return r;
        })
      )
    );

    // The reduce step. Trivial here, which is the point — the expensive part
    // was the scan, and that happened on n threads at once.
    const total = parts.reduce(
      (a, r) => ({
        lines: a.lines + r.lines,
        bytes: a.bytes + r.bytes,
        ok: a.ok + r.ok,
        missing: a.missing + r.missing,
        error: a.error + r.error,
        max: Math.max(a.max, r.max),
      }),
      { lines: 0, bytes: 0, ok: 0, missing: 0, error: 0, max: 0 }
    );

    const ms = Date.now() - t0;
    return {
      n,
      ms,
      total,
      // Slowest child: with an even split this is roughly ms minus spawn cost,
      // and the gap between them is what the fan-out actually costs.
      slowestChildMs: Math.max(...parts.map((r: any) => r.ms)),
      mbPerSec: used / 1024 / 1024 / (ms / 1000),
    };
  },

  dispose() {
    SharedBuffer.delete(bufName);
    return true;
  },
});
