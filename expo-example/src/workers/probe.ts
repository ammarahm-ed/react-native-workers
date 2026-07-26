// Worker-side probe. Reports, from INSIDE a worker runtime, what native-module
// surfaces are reachable:
//   1. Do workers run at all under Expo?
//   2. Are standard RN TurboModules/Cxx modules reachable? (this library's own
//      `ReactNativeWorkers` Cxx module is the canary.)
//   3. Is the Expo Modules API installed and callable DIRECTLY in the worker —
//      constants read synchronously, sync + async functions invoked natively,
//      dynamic PROPERTIES read live, and module EVENTS delivered into the worker.

declare const self: any;
const g = globalThis as any;

function getModule(name: string): any {
  try {
    if (typeof g.__rnworkersGetModule === 'function') {
      return g.__rnworkersGetModule(name);
    }
  } catch {}
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ExpoProbe = {
  installed: boolean;
  how: string;
  keys?: string[];
  constant?: string;
  asyncCall?: string;
  syncCall?: string;
  property?: string;
  event?: string;
};

async function probeExpo(): Promise<ExpoProbe> {
  const expo = g.expo;
  if (!expo || !expo.modules) {
    return { installed: false, how: 'global.expo.modules absent' };
  }
  const keys = Object.keys(expo.modules).slice(0, 16);

  // Constant, read synchronously (ExpoDevice.osName is a Constant).
  let constant = 'no constant read';
  try {
    const device = expo.modules.ExpoDevice;
    if (device) {
      constant = `ExpoDevice.osName=${String(device.osName)} isDevice=${String(device.isDevice)}`;
    }
  } catch (err: any) {
    constant = `threw: ${String(err?.message ?? err)}`;
  }

  // Async function (Promise), forwarded via AppContext.callFunction.
  let asyncCall = 'no async fn';
  try {
    const device = expo.modules.ExpoDevice;
    if (device && typeof device.getDeviceTypeAsync === 'function') {
      const t = await device.getDeviceTypeAsync();
      asyncCall = `ExpoDevice.getDeviceTypeAsync()=${String(t)}`;
    }
  } catch (err: any) {
    asyncCall = `threw: ${String(err?.message ?? err)}`;
  }

  // Sync function — MUST return the value directly (a string), NOT a Promise.
  let syncCall = 'no sync fn';
  try {
    const crypto = expo.modules.ExpoCrypto;
    if (crypto && typeof crypto.randomUUID === 'function') {
      const uuid = crypto.randomUUID();
      const isPromise = uuid && typeof uuid.then === 'function';
      syncCall = isPromise
        ? `WRONG: randomUUID() returned a Promise (sync detection failed)`
        : `ExpoCrypto.randomUUID()=${String(uuid)} (sync string ✓)`;
    }
  } catch (err: any) {
    syncCall = `threw: ${String(err?.message ?? err)}`;
  }

  // Dynamic PROPERTY — read live from the main runtime via the bridge. RNWProbe
  // exposes a static `answer` (== 42) and a dynamic `nowMs` (changes each read).
  let property = 'no property';
  try {
    const probe = expo.modules.RNWProbe;
    if (probe) {
      const answer = probe.answer;
      const first = probe.nowMs;
      await delay(15);
      const second = probe.nowMs;
      const dynamicOk =
        typeof first === 'number' &&
        typeof second === 'number' &&
        second >= first;
      property =
        answer === 42 && dynamicOk
          ? `answer=${answer} nowMs live (${first} → ${second}) ✓`
          : `WRONG: answer=${String(answer)} nowMs=${String(first)}/${String(second)}`;
    } else {
      property = 'RNWProbe module absent (build the local module)';
    }
  } catch (err: any) {
    property = `threw: ${String(err?.message ?? err)}`;
  }

  // EVENTS — subscribe in the worker, fire from the worker, expect delivery back
  // into the worker with the native payload intact.
  let event = 'no event';
  try {
    const probe = expo.modules.RNWProbe;
    if (probe && typeof probe.addListener === 'function') {
      const received = new Promise<any>((resolve, reject) => {
        const sub = probe.addListener('onTick', (payload: any) => {
          try {
            sub?.remove?.();
          } catch {}
          resolve(payload);
        });
        setTimeout(() => reject(new Error('event timed out')), 3000);
      });
      // Give the main-runtime listener registration a moment to land, then fire.
      await delay(250);
      const emitResult = probe.emitTick(7);
      const payload = await received;
      const ok = payload && payload.count === 7 && payload.label === 'tick';
      event = ok
        ? `onTick received in worker: ${JSON.stringify(payload)} (emit=${String(emitResult)}) ✓`
        : `WRONG payload: ${JSON.stringify(payload)}`;
    } else {
      event = 'RNWProbe module absent (build the local module)';
    }
  } catch (err: any) {
    event = `threw: ${String(err?.message ?? err)}`;
  }

  return {
    installed: true,
    how: 'global.expo.modules',
    keys,
    constant,
    asyncCall,
    syncCall,
    property,
    event,
  };
}

self.onmessage = async (e: MessageEvent) => {
  if (e.data !== 'probe') return;
  const workersMod = getModule('ReactNativeWorkers');
  const expo = await probeExpo();

  console.log('[probe] worker started');
  console.log('[probe] typeof globalThis.expo =', typeof g.expo);
  console.log('[probe] expo.modules present =', !!(g.expo && g.expo.modules));
  console.log('[probe] expo result =', JSON.stringify(expo));

  self.postMessage({
    workerAlive: true,
    rnTurboModule: {
      resolved: !!workersMod,
      // The library's own Cxx TurboModule is reachable INSIDE the worker (this is
      // what lets nested workers be created from a worker).
      reachable: !!workersMod && typeof workersMod.createWorker === 'function',
    },
    expoModules: expo,
  });
};
