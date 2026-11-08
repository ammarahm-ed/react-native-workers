import { Worker } from '@ammarahmed/react-native-workers';

type Result = { name: string; pass: boolean; detail: unknown };

const once = <T>(worker: Worker, timeout = 5000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply')), timeout);
    worker.onmessage = (event: { data: T }) => {
      clearTimeout(timer);
      resolve(event.data);
    };
  });

/** What the desktop port adds: bundled workers and the app's native modules. */
export async function runDesktopTests(): Promise<Result[]> {
  const out: Result[] = [];
  const push = (name: string, pass: boolean, detail: unknown) =>
    out.push({ name, pass, detail: JSON.stringify(detail) });

  try {
    // A worker from its own file: a Metro URL in development, a bundle in the
    // app's resources in a release.
    const bundled = new Worker('./workers/echo');
    const reply = once<{ echo: { n: number }; timers: string }>(bundled);
    bundled.postMessage({ n: 7 });
    const answer = await reply;
    push(
      'a worker from its own file answers',
      answer.echo.n === 7 && answer.timers === 'function',
      answer
    );
    bundled.terminate();
  } catch (error) {
    push('a worker from its own file answers', false, String(error));
  }

  try {
    // The app's native modules, in a worker that asks for them.
    const worker = new Worker(
      {
        inline: `self.onmessage = () => {
          const constants = globalThis.__turboModuleProxy && globalThis.__turboModuleProxy('PlatformConstants');
          self.postMessage({ hasModule: !!constants });
        };`,
      },
      { nativeModules: true }
    );
    const reply = once<{ hasModule: boolean }>(worker);
    worker.postMessage(1);
    const answer = await reply;
    push('a worker reaches the app native modules', answer.hasModule, answer);
    worker.terminate();
  } catch (error) {
    push('a worker reaches the app native modules', false, String(error));
  }

  try {
    // Several workers at once, each on its own thread, each answering for itself.
    const workers = Array.from(
      { length: 8 },
      () =>
        new Worker({
          inline: `self.onmessage = (e) => {
            let sum = 0;
            for (let i = 0; i < 200000; i++) sum += i % e.data;
            self.postMessage({ id: e.data, sum });
          };`,
        })
    );
    const replies = workers.map((worker, index) => {
      const reply = once<{ id: number; sum: number }>(worker, 10000);
      worker.postMessage(index + 2);
      return reply;
    });
    const answers = await Promise.all(replies);
    const ids = answers.map((answer) => answer.id).sort((a, b) => a - b);
    push(
      'eight workers answer at once',
      ids.join(',') === '2,3,4,5,6,7,8,9',
      ids
    );
    workers.forEach((worker) => worker.terminate());
  } catch (error) {
    push('eight workers answer at once', false, String(error));
  }

  return out;
}
