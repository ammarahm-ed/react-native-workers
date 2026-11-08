declare const self: any;

// A worker that ships as its own bundle: echoes what it is sent and says what
// it can see.
self.onmessage = (event: { data: unknown }) => {
  self.postMessage({
    echo: event.data,
    timers: typeof setTimeout,
    promises: typeof Promise,
  });
};
