// Runs inside a UIWorker — i.e. a Hermes runtime living on the platform main
// thread. Every call below reaches UIKit synchronously: no dispatch_async, no
// runOnUiThread, no method queue (see react-native-uiworker-demo for why that
// requires a Cxx TurboModule rather than an ObjC one).
//
// The demo screen spawns this SAME file twice — once as a UIWorker and once as a
// background Worker — to show the difference: `info()` reports which thread it
// landed on, and the UI methods throw off the main thread rather than corrupting
// UIKit state.
import { getUIWorkerDemo } from 'react-native-uiworker-demo';

declare const parent: any;
declare const SharedValue: any;

const demo = getUIWorkerDemo();

// `parent.register` is the same registration `new JSModule(...)` performs, but
// without constructing an object purely for its side effect.
parent.register('uidemo', {
  info() {
    return { onMain: demo.isOnMainThread(), thread: demo.threadName() };
  },

  alert(title: string, message: string) {
    demo.showAlert(title, message);
    return true;
  },

  statusBar(hidden: boolean) {
    demo.setStatusBarHidden(hidden);
    return hidden;
  },

  brightness() {
    return demo.getBrightness();
  },

  setBrightness(value: number) {
    demo.setBrightness(value);
    return demo.getBrightness();
  },

  vibrate() {
    demo.vibrate();
    return true;
  },

  /**
   * Animate a mounted view straight from this runtime. The loop lives entirely
   * on the main thread: each tick reads a shared cell (a lock-free atomic, no
   * message hop) and writes the view's transform through a direct native call.
   * The app's JS thread is not involved once this starts.
   */
  animate(tag: number, running: string) {
    const flag = new SharedValue(running, 0);
    const frames = new SharedValue(running + ':frames', 0);
    const start = Date.now();
    let timer: any = null;

    const tick = () => {
      // Stop if asked to, or if React unmounted the view underneath us.
      if (flag.value !== 1 || !demo.viewExists(tag)) {
        if (timer !== null) clearInterval(timer);
        timer = null;
        demo.setViewTransform(tag, {});
        demo.setViewOpacity(tag, 1);
        return;
      }
      const t = (Date.now() - start) / 1000;
      demo.setViewTransform(tag, {
        translateX: Math.sin(t * 2) * 90,
        rotate: t * 2,
        scale: 1 + Math.sin(t * 3) * 0.25,
      });
      demo.setViewOpacity(tag, 0.65 + Math.sin(t * 3) * 0.35);
      frames.value = frames.value + 1;
    };

    flag.value = 1;
    frames.value = 0;
    timer = setInterval(tick, 16);
    return true;
  },

  /**
   * Time N direct native round-trips. Each iteration is JS -> JSI -> C++ -> ObjC
   * and back with a real return value, so this measures actual call cost rather
   * than queue latency.
   */
  benchmark(n: number) {
    const start = Date.now();
    let onMain = true;
    for (let i = 0; i < n; i++) {
      onMain = demo.isOnMainThread();
    }
    const ms = Date.now() - start;
    return { n, ms, perCallUs: (ms * 1000) / n, onMain };
  },
});
