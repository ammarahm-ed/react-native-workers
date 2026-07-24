// Web fallback: an in-page shared cell (no cross-thread sharing on web).
type Cell = { value: any; subs: Set<(v: any) => void> };
const cells = new Map<string, Cell>();

export class SharedValue<T = number> {
  private readonly _c: Cell;

  constructor(name: string, initial?: T) {
    let c = cells.get(name);
    if (!c) {
      c = { value: initial, subs: new Set() };
      cells.set(name, c);
    } else if (c.value === undefined && initial !== undefined) {
      c.value = initial;
    }
    this._c = c;
  }

  get value(): T {
    return this._c.value;
  }
  set value(v: T) {
    this._c.value = v;
    for (const cb of Array.from(this._c.subs)) cb(v);
  }

  subscribe(cb: (value: T) => void): () => void {
    this._c.subs.add(cb);
    return () => this._c.subs.delete(cb);
  }

  static delete(name: string): boolean {
    return cells.delete(name);
  }
}
