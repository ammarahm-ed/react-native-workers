// NativeScript's Obj-C interop (`@nativescript/react-native`) driven from a
// UIWorker: the whole iOS SDK, callable from JS, with no per-API native module
// to write.
//
// This file runs in a `UIWorker`, so its JS lives ON the platform main thread.
// That is what makes everything below plain code: the interop layer gates UIKit
// on `NSThread.isMainThread`, which is true here, so every Obj-C message is a
// direct synchronous send — no `runOnUI`, no `dispatch_sync`, no queue hop, and
// values come straight back on the next line.
//
// On React Native's own JS thread the same code would have to be wrapped in
// `NativeScript.runOnUI()`, which dispatches every individual native call to the
// main queue and hands you a promise instead of a value.
//
// `NativeScript.init()` installs the interop host object onto *the calling
// runtime*, which is exactly the shape a worker needs — nothing here is
// worker-specific plumbing.
import NativeScript from '@nativescript/react-native';

declare const parent: any;
declare const SharedValue: any;

const installed = NativeScript.init();

/** The window RN is rendering into. */
function keyWindow(): any {
  const app = UIApplication.sharedApplication;
  const key = app.keyWindow;
  if (key) return key;
  const windows = app.windows;
  return windows && windows.count > 0 ? windows.objectAtIndex(0) : null;
}

/**
 * Fabric stamps each mounted component view with its React tag
 * (`RCTComponentViewRegistry.mm`: `componentViewDescriptor.view.tag = tag`), so
 * `findNodeHandle()` on the JS side and `viewWithTag()` here name the same view
 * — no UIManager, no view registry, no native module in between.
 */
function hostView(tag: number): any {
  const window = keyWindow();
  const view = window ? window.viewWithTag(tag) : null;
  if (!view) {
    throw new Error(`no mounted view for tag ${tag}`);
  }
  return view;
}

/** The controller a modal should be presented from. */
function topViewController(): any {
  let current = keyWindow()?.rootViewController ?? null;
  while (current?.presentedViewController) {
    current = current.presentedViewController;
  }
  return current;
}

/** Our UIKit subtree, keyed by the React tag it was attached to. */
const attached = new Map<number, any>();
const timers = new Map<number, any>();
const retainer = NativeScript.createRetainer();

parent.register('nativescript', {
  info() {
    const api = (globalThis as any).__nativeScriptNativeApi;
    const device = UIDevice.currentDevice;
    const screen = UIScreen.mainScreen;
    return {
      installed,
      onMain: NativeScript.isMainThread(),
      backend: NativeScript.getRuntimeBackend(),
      classes: api?.metadata?.classNames?.().length ?? 0,
      model: String(device.model),
      system: `${device.systemName} ${device.systemVersion}`,
      scale: screen.scale,
    };
  },

  /**
   * React Native's own Obj-C API, called from the worker.
   *
   * The metadata `@nativescript/react-native` ships is generated from the bare
   * iOS SDK — it has no `RCT*` in it at all. This app regenerates it against its
   * own CocoaPods headers (`scripts/generate-nativescript-metadata.mjs`), so
   * RN's classes and C functions get lazy globals and typed signatures like any
   * system framework. Without that they are still reachable through
   * `NativeScript.getClass()`, which falls back to `objc_lookUpClass` and
   * derives signatures from the Obj-C runtime's own type encodings — but with no
   * globals and no types.
   *
   * `RCTKeyWindow()` is a plain C function out of `RCTUtils.h`: proof the
   * regenerated metadata carries RN's functions, not just its classes.
   */
  reactNative() {
    const api = (globalThis as any).__nativeScriptNativeApi;
    const names: string[] = api?.metadata?.classNames?.() ?? [];
    const rct = names.filter((n) => n.startsWith('RCT'));
    const g = globalThis as any;

    // A C function out of RCTUtils.h, resolved from the regenerated metadata and
    // called straight from the worker. Reading `.bounds` off the result proves
    // the returned UIWindow came back as a usable native object, not a handle.
    const window =
      typeof g.RCTKeyWindow === 'function' ? g.RCTKeyWindow() : null;
    const bounds = window?.bounds;

    return {
      rctClasses: rct.length,
      sample: rct.slice(0, 4),
      // 'function' only when the metadata actually covers React Native — with
      // the stock SDK-only metadata there is no `RCTView` global at all.
      rctViewGlobal: typeof g.RCTView,
      keyWindow: bounds
        ? `${Math.round(bounds.size.width)}×${Math.round(bounds.size.height)}`
        : null,
    };
  },

  /**
   * Build a real UIKit subtree and mount it inside a React-rendered view.
   *
   * Every line is a direct Obj-C message send from JS: alloc/init, layer
   * configuration, `addSubview:`. No bridge, no shadow tree, no native module —
   * and React never learns about any of it.
   */
  attach(tag: number) {
    const host = hostView(tag);
    if (attached.has(tag)) {
      return { ok: true, already: true, subviews: host.subviews.count };
    }

    const bounds = host.bounds;
    const card = UIView.alloc().initWithFrame(bounds);
    card.autoresizingMask =
      UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
    card.layer.cornerRadius = 14;
    card.clipsToBounds = true;

    // A gradient drawn by Core Animation, configured from JS.
    const gradient = CAGradientLayer.layer();
    gradient.frame = card.bounds;
    gradient.colors = NSArray.arrayWithArray([
      UIColor.systemIndigoColor.CGColor,
      UIColor.systemTealColor.CGColor,
    ]);
    gradient.startPoint = CGPointMake(0, 0);
    gradient.endPoint = CGPointMake(1, 1);
    card.layer.addSublayer(gradient);

    const label = UILabel.alloc().initWithFrame(card.bounds);
    label.autoresizingMask =
      UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
    label.text = 'UIKit, built in a worker';
    label.textAlignment = NSTextAlignment.Center;
    label.textColor = UIColor.whiteColor;
    label.font = UIFont.boldSystemFontOfSize(17);
    card.addSubview(label);

    host.addSubview(card);

    // UIKit holds views strongly through the hierarchy, but our own handles are
    // ours to keep alive.
    retainer.retain(card);
    attached.set(tag, { card, gradient, label });

    return {
      ok: true,
      already: false,
      subviews: host.subviews.count,
      size: `${Math.round(bounds.size.width)}×${Math.round(bounds.size.height)}`,
    };
  },

  detach(tag: number) {
    this.stop(tag);
    const entry = attached.get(tag);
    if (!entry) return { ok: false };
    entry.card.removeFromSuperview();
    retainer.release(entry.card);
    attached.delete(tag);
    return { ok: true };
  },

  /**
   * Drive an animation frame-by-frame from this runtime.
   *
   * The loop is: timer fires on the main thread → JS computes → Obj-C setters
   * run inline → Core Animation commits at the end of the runloop turn. The
   * app's JS thread is never involved, so this keeps running at full rate even
   * while the JS thread is blocked.
   */
  animate(tag: number, running: string) {
    const entry = attached.get(tag);
    if (!entry) throw new Error('attach() first');

    const flag = new SharedValue(running, 0);
    const frames = new SharedValue(running + ':frames', 0);
    const start = Date.now();

    const tick = () => {
      // Stop when asked, or when React unmounted the host view underneath us.
      if (flag.value !== 1 || !entry.card.superview) {
        this.stop(tag);
        return;
      }
      const t = (Date.now() - start) / 1000;
      entry.card.transform = CGAffineTransformMakeRotation(
        Math.sin(t * 1.5) * 0.12
      );
      entry.label.alpha = 0.55 + Math.sin(t * 3) * 0.45;
      entry.gradient.startPoint = CGPointMake(
        0.5 + Math.sin(t) * 0.5,
        0.5 + Math.cos(t) * 0.5
      );
      frames.value = frames.value + 1;
    };

    flag.value = 1;
    frames.value = 0;
    timers.set(tag, setInterval(tick, 16));
    return true;
  },

  stop(tag: number) {
    const timer = timers.get(tag);
    if (timer != null) {
      clearInterval(timer);
      timers.delete(tag);
    }
    const entry = attached.get(tag);
    if (entry) {
      entry.card.transform = CGAffineTransformIdentity;
      entry.label.alpha = 1;
    }
    return true;
  },

  /**
   * A real UIAlertController, presented from the worker and awaited there.
   *
   * The interesting part is the button handler. `actionWithTitle:style:handler:`
   * takes an Obj-C block, and the interop wraps this JS closure into one — so
   * UIKit calls straight back into this runtime when a button is tapped. The
   * call arrives on the main thread, which is where this runtime already lives,
   * so the handler runs inline with no hop and can settle a promise directly.
   *
   * That promise is the method's return value, and the worker RPC layer awaits
   * it, so `await module.alert(...)` on the React side stays pending for as long
   * as the alert is on screen and resolves with the button the user tapped.
   * Presenting and reading the result is one call, with no callback plumbing
   * across the runtime boundary.
   */
  alert(title: string, message: string, buttons: string[] = ['OK']) {
    const presenter = topViewController();
    if (!presenter) throw new Error('no view controller to present from');
    if (presenter.presentedViewController) {
      throw new Error('something is already presented');
    }

    return new Promise((resolve) => {
      const started = Date.now();
      const controller =
        UIAlertController.alertControllerWithTitleMessagePreferredStyle(
          title,
          message,
          UIAlertControllerStyle.Alert
        );

      // Keep the controller — and with it the blocks holding these closures —
      // alive for as long as it is on screen.
      retainer.retain(controller);

      const settle = (index: number) => {
        retainer.release(controller);
        resolve({
          index,
          button: buttons[index],
          onMain: NativeScript.isMainThread(),
          ms: Date.now() - started,
        });
      };

      buttons.forEach((label, i) => {
        const style =
          buttons.length > 1 && i === buttons.length - 1
            ? UIAlertActionStyle.Cancel
            : UIAlertActionStyle.Default;
        controller.addAction(
          UIAlertAction.actionWithTitleStyleHandler(label, style, () =>
            settle(i)
          )
        );
      });

      presenter.presentViewControllerAnimatedCompletion(controller, true, null);
    });
  },

  /**
   * Time N Obj-C round-trips: JS → JSI → libffi → objc_msgSend and back, with a
   * real return value each time. Because this runtime is already on the main
   * thread there is nothing to dispatch, so this measures the actual cost of the
   * interop call rather than queue latency.
   */
  benchmark(n: number) {
    const device = UIDevice.currentDevice;
    const start = Date.now();
    let last = '';
    for (let i = 0; i < n; i++) {
      last = device.systemVersion;
    }
    const ms = Date.now() - start;
    return {
      n,
      ms,
      perCallUs: Math.round(((ms * 1000) / n) * 100) / 100,
      sample: String(last),
    };
  },
});
