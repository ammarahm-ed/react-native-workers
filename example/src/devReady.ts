/**
 * Readiness markers for tooling.
 *
 * Screens are asynchronous by nature here — every one of them starts a worker
 * and only becomes interesting once that worker has answered. Anything driving
 * the app from the outside (docs screenshots, a CI smoke run) otherwise has to
 * guess with a sleep. These markers replace the guess:
 *
 *   [RNW-READY] sensor              → the screen mounted and rendered
 *   [RNW-READY] sensor:data         → the interesting content has landed
 *
 * The marker goes out through Hermes' `nativeLoggingHook`, which lands in the
 * platform log (`xcrun simctl launch --console-pty` / `adb logcat`) no matter
 * how the React Native `console` happens to be routed in this version — in
 * bridgeless dev builds `console.log` goes to the DevTools channel and never
 * reaches a terminal. `console.log` is the fallback if the hook is absent.
 *
 * Dev-only: release builds emit nothing.
 */
export const READY_MARKER = '[RNW-READY]';

/**
 * @param id    Screen id, as in `screens/index.ts` (or `home` for the list).
 * @param phase Optional sub-phase, e.g. `data` once async content has arrived.
 */
export function markReady(id: string, phase?: string) {
  if (!__DEV__) return;
  const line = `${READY_MARKER} ${phase ? `${id}:${phase}` : id}`;
  const hook = (globalThis as any).nativeLoggingHook;
  if (typeof hook === 'function') hook(line, 3 /* info */);
  else console.log(line);
}
