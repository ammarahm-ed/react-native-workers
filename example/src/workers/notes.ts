// Autosave + derived stats for a note editor, computed off the JS thread.
//
// The editor and this worker never exchange a message about the document. They
// share one SharedStore: the host writes `doc.text` on every keystroke, this
// worker is subscribed to that path and reacts. Results go back the same way.
//
// `export {}` makes this a module, so its top-level names stay local to it.
export {};

declare const SharedStore: any;

const app: any = (globalThis as any).parent;

let store: any = null;
let unsubscribe: (() => void) | null = null;
let debounce: any = null;
let saves = 0;
// Whether the save writes its three fields inside batch(). The host toggles it
// to show the difference in how many notifications the UI receives per save.
let batched = true;

function analyse(text: string) {
  const words = text.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  return {
    chars: text.length,
    words: words.length,
    unique,
    longest: words.reduce((a, w) => (w.length > a.length ? w : a), ''),
    readingSec: Math.ceil(words.length / (200 / 60)),
  };
}

app.register('notes', {
  /**
   * Opens the store and starts watching the document. The host must await this
   * BEFORE it writes any text — a store write with no subscriber yet is simply
   * not observed, and nothing replays it.
   */
  attach(name: string) {
    store = new SharedStore(name);
    if (unsubscribe) unsubscribe();
    saves = 0;

    // subscribeIn fires only when a change touches this subtree, and hands us
    // the changed slice rather than the whole document.
    unsubscribe = store.subscribeIn('doc', ['text'], (_rel: any, text: any) => {
      const stats = analyse(typeof text === 'string' ? text : '');

      // Live counters update immediately...
      store.setIn('stats', ['live'], stats);

      // ...while the "save" is debounced.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        saves++;
        const writeAll = () => {
          store.setIn('stats', ['saved'], stats);
          store.setIn('stats', ['saves'], saves);
          store.setIn('stats', ['savedAt'], Date.now());
        };
        // Three writes either way. batch() applies them atomically and notifies
        // watchers once; without it the host sees three separate updates.
        if (batched) store.batch(writeAll);
        else writeAll();
        app.module('app').onSaved(saves);
      }, 400);
    });

    return true;
  },

  setBatched(on: boolean) {
    batched = !!on;
    return batched;
  },

  reset() {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    saves = 0;
    store.batch(() => {
      store.set('doc', { text: '' });
      store.set('stats', {});
    });
    return true;
  },

  /** Drops the store this run created — it would otherwise outlive the worker. */
  dispose(name: string) {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (debounce) clearTimeout(debounce);
    store = null;
    SharedStore.delete(name);
    return true;
  },
});
