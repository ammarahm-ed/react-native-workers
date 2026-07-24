// A search service that lives entirely in a worker.
//
// This is the shape most apps want: the worker OWNS the data and the expensive
// index, the host asks it questions and gets typed answers back. Nothing large
// crosses between runtimes — only the query and the handful of results.
//
// It exercises both directions of the JSModule bridge:
//   worker -> host   `parent.module('app')` to fetch the corpus and log
//   host   -> worker `search()` / `stats()` called as promises
//   worker -> host   `mod.emit(...)` events while indexing
declare const parent: any;

type Doc = { id: number; title: string; body: string };

let docs: Doc[] = [];
// term -> document ids. Built once, then every query is a set lookup.
const termIndex = new Map<string, Set<number>>();
let indexedAt = 0;

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

const mod = parent.register('search', {
  /**
   * Pulls the corpus from the HOST (a worker->host call) and indexes it,
   * emitting progress as it goes. The host never blocks: it awaits a promise
   * and renders the events as they arrive.
   */
  async build() {
    const started = Date.now();
    // Worker calling back into a module the host registered.
    docs = await parent.module('app').fetchDocs();

    termIndex.clear();
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!;
      for (const term of tokenize(doc.title + ' ' + doc.body)) {
        let bucket = termIndex.get(term);
        if (!bucket) termIndex.set(term, (bucket = new Set()));
        bucket.add(doc.id);
      }
      // Report progress without the host having to poll for it.
      if (i % 250 === 0) {
        mod.emit('progress', { done: i, total: docs.length });
      }
    }
    indexedAt = Date.now() - started;
    mod.emit('progress', { done: docs.length, total: docs.length });
    parent.module('app').log(`indexed ${docs.length} docs in ${indexedAt}ms`);
    return { docs: docs.length, terms: termIndex.size, ms: indexedAt };
  },

  /** AND-search across terms. Returns only what the UI needs to render. */
  search(query: string) {
    const started = Date.now();
    const terms = tokenize(query);
    if (terms.length === 0) return { hits: [], ms: 0, scanned: 0 };

    let ids: Set<number> | null = null;
    for (const term of terms) {
      const bucket = termIndex.get(term) ?? new Set<number>();
      ids =
        ids === null
          ? new Set(bucket)
          : new Set([...ids].filter((id: number) => bucket.has(id)));
    }

    const hits = [...(ids ?? [])]
      .slice(0, 20)
      .map((id) => docs.find((d) => d.id === id))
      .filter(Boolean)
      .map((d: any) => ({
        id: d.id,
        title: d.title,
        snippet: d.body.slice(0, 70),
      }));

    return { hits, ms: Date.now() - started, scanned: ids?.size ?? 0 };
  },

  stats() {
    return { docs: docs.length, terms: termIndex.size, indexedAt };
  },
});
