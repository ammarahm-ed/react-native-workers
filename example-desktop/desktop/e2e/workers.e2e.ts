import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchApp, type DesktopApp } from '@react-native-gpui/testing';

let app: DesktopApp;

beforeAll(async () => {
  app = await launchApp({
    disableAnimations: true,
    timeout: 120000,
    logFile: process.env.RN_GPUI_E2E_LOG,
  });
});

afterAll(async () => {
  await app.close();
});

const texts = async () => {
  const tree = JSON.stringify(await app.tree());
  return [...tree.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map(
    (match) => match[1]
  );
};

test('every worker check passes: start, messages both ways, transfer, terminate, errors, several workers', async () => {
  const deadline = Date.now() + 90000;
  let lines: string[] = [];
  while (Date.now() < deadline) {
    lines = await texts();
    if (lines.includes('PASS') || lines.includes('FAIL')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const failures = lines.filter((line) => line.startsWith('FAIL - '));
  expect(failures).toEqual([]);
  expect(lines).toContain('PASS');
  // Every suite ran: the conformance suite alone has dozens of checks.
  expect(
    lines.filter((line) => line.startsWith('ok - ')).length
  ).toBeGreaterThan(30);
});
