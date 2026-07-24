// Web fallback: an in-page shared buffer (no cross-thread sharing on web).
const buffers = new Map<string, ArrayBuffer>();

export class SharedBuffer {
  readonly arrayBuffer: ArrayBuffer;
  readonly byteLength: number;

  constructor(name: string, byteLength: number) {
    let b = buffers.get(name);
    if (!b) {
      b = new ArrayBuffer(byteLength);
      buffers.set(name, b);
    }
    this.arrayBuffer = b;
    this.byteLength = b.byteLength;
  }

  withLock<T>(fn: () => T): T {
    return fn(); // single-threaded on web
  }

  static delete(name: string): boolean {
    return buffers.delete(name);
  }
}
