import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchApp, type DesktopApp } from '@react-native-gpui/testing';

// Measures what is left of the process after many workers were created and
// terminated. Run it by hand against a bundle built from teardown.js:
//   RN_GPUI_TEST_BINARY=... RN_GPUI_TEST_BUNDLE=<teardown bundle> npx vitest run ... teardown
let app: DesktopApp;

beforeAll(async () => {
  app = await launchApp({ disableAnimations: true, timeout: 120000 });
});

afterAll(async () => {
  await app.close();
});

const phase = async () => {
  const tree = JSON.stringify(await app.tree());
  return tree.match(/phase:([A-Za-z0-9-]+)/u)?.[1] ?? '';
};

const pid = () =>
  Number(
    execFileSync('pgrep', ['-n', '-f', process.env.RN_GPUI_TEST_BINARY ?? 'workers-desktop-example'], {
      encoding: 'utf8',
    }).trim(),
  );

const sample = (process_: number) => {
  const threads = execFileSync('ps', ['-M', '-p', String(process_)], { encoding: 'utf8' })
    .trim()
    .split('\n').length - 1;
  const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(process_)], { encoding: 'utf8' }).trim());
  return { threads, rssMb: Math.round(rss / 1024) };
};

test('threads and memory after 200 create/terminate cycles, twice', async () => {
  const seen: Record<string, { threads: number; rssMb: number }> = {};
  const wanted = ['baseline', 'running-1', 'settled-1', 'settled-2'];
  const deadline = Date.now() + 240000;
  const process_ = pid();
  while (Date.now() < deadline) {
    const current = await phase();
    if (wanted.includes(current) && !seen[current]) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      seen[current] = sample(process_);
    }
    if (current === 'done' || current.startsWith('FAILED')) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const peak: number[] = [];
  require('node:fs').writeFileSync('/tmp/teardown-result.json', JSON.stringify({ seen, peak }, null, 1));
  expect(Object.keys(seen)).toEqual(wanted);
});
