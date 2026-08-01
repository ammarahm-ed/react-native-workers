// Worker-defined React Native components — the reusable machinery. Components
// live in `workers/nativecomponents.ts`; this is the part you'd ship as a library.
//
// A component becomes a real RN host component by registering an `RCTViewManager`
// subclass at runtime (Obj-C, via NativeScript's `extend`), so Fabric mounts it
// through its legacy-interop layer.
//
//   • Props flow through RN's OWN native pipeline. Each prop is declared with a
//     `+propConfig_<name>` CLASS method. `extend` only adds *instance* methods,
//     so we add each as an instance method and copy its IMP onto the metaclass
//     (`class_addMethod(object_getClass(cls), …)`) — making it a class method RN
//     reads. RN then calls our `-set_<name>:forView:withDefaultView:` custom
//     setter with the value. No RPC for props.
//
//   • Events also flow through RN's OWN pipeline. RN hands the view a native
//     `RCTBubblingEventBlock`; NativeScript can't call it directly (no metadata
//     signature), so we invoke it through the Obj-C runtime instead — see the
//     "Native events" section below. No RPC for events.
//
//   • Children flow through RN's OWN pipeline too. Fabric's legacy-interop layer
//     mounts each React child into the view manager's view with
//     `insertReactSubview:atIndex:` + `didUpdateReactSubviews` (`UIView+React.h`),
//     whose default implementation just `addSubview:`s them — so a container
//     component gets nested React children for free. Overriding
//     `childrenView()` re-parents them into a native subview instead.
//
// The objc-runtime C functions (`sel_registerName`, `class_addMethod`,
// `imp_implementationWithBlock`, …) are all in the regenerated interop metadata.
import NativeScript from '@nativescript/react-native';

declare const parent: any;

const g = globalThis as any;

/**
 * The interop's `void` type marker, resolved LAZILY.
 *
 * `interop` is installed by `NativeScript.init()`, which runs in the importing
 * module — after this one has been evaluated. Capturing the marker at module
 * load therefore yields `undefined`, every method gets declared as returning an
 * object, and the runtime then tries to convert a JS `undefined` return into an
 * Obj-C object. That crashes inside the callback trampoline, a long way from
 * here, with no JS frame to point at.
 */
function objcVoidType(): any {
  return g.interop?.types?.void;
}

export type Props = Record<string, any>;

/** A component: one instance per mounted view. */
export abstract class NativeComponent {
  /** Publish under a different name than the class. */
  static componentName?: string;
  /** Prop names RN routes to `update()` natively. */
  static props: string[] = [];
  /** Event prop names (`on…`) delivered to React callbacks. */
  static events: string[] = [];

  /** The UIView `create()` returned. Set before `update()` runs. */
  view: any;

  /** Build the UIKit view (on the main thread). Wire control events here. */
  abstract create(): any;
  /** Apply props — merged, so read whatever you need off `props`. */
  update(_props: Props): void {}
  /** Teardown when React unmounts. */
  dispose(): void {}

  /** Fire an event to the matching `on<Event>` React prop; `payload` → `nativeEvent`.
   *  Goes through RN's own native event pipeline — no bridge. Requires the view to
   *  have been built with `hostView()` so RN's dispatching block was captured. */
  emit(event: string, payload: Props = {}): void {
    const handler = eventHandlers.get(this.view)?.[event];
    // No handler yet means React hasn't attached an `on<Event>` prop — like a
    // native component with no listener, the event is simply dropped.
    if (handler) fireNativeBlock(handler, payload);
  }

  /** Where React children mount. Defaults to the view itself — override to nest
   *  them inside a native subview (a `UIVisualEffectView`'s `contentView`, a
   *  scroll view's content, …). Only consulted for views built with `hostView()`. */
  childrenView(): any {
    return this.view;
  }

  /** Called after React mounted or unmounted children, with the new child count. */
  childrenChanged(_count: number): void {}

  /** Called after EVERY update of this view, once RN has (re-)parented its
   *  children into `childrenView()`. A component that moves children somewhere
   *  else — into recycled cells, say — puts them back here. */
  childrenUpdated(_count: number): void {}

  /** The view class to build in `create()` so this component's declared `events`
   *  are delivered through RN's native pipeline and its React children are routed
   *  through `childrenView()`:
   *  `const view = this.hostView(UISwitch).alloc().initWithFrame(…)`. */
  hostView(Base: any): any {
    return defineHostView(
      Base,
      (this.constructor as ComponentClass).events ?? []
    );
  }

  /** Wire a UIControl event to a callback for this instance's lifetime. */
  onControl(control: any, events: number, handler: () => void): void {
    const target = controlTargetClass().alloc().init();
    controlHandlers.set(target, handler);
    retainer.retain(target);
    control.addTargetActionForControlEvents(
      target,
      'workerHandleAction',
      events
    );
  }

  /** Build an Obj-C delegate from JS (e.g. a MKMapViewDelegate), retained. */
  delegate<T extends object>(
    protocols: string | string[],
    methods: Partial<T>
  ): T {
    return NativeScript.createDelegate<T>(protocols as any, methods, {
      retainer,
    });
  }
}

type ComponentClass = (new () => NativeComponent) & {
  componentName?: string;
  props?: string[];
  events?: string[];
};

export type Descriptor = { name: string; props: string[]; events: string[] };

const retainer = NativeScript.createRetainer();
const instances = new WeakMap<any, NativeComponent>(); // view → instance
const propState = new WeakMap<any, Props>(); // view → accumulated props
const registered = new Map<string, Descriptor>();

/**
 * Native props arrive as Obj-C values (an `NSArray` for `pins`, `NSNumber` for a
 * bool, …). NativeScript passes primitives through as JS values already;
 * round-trip only containers, through JSON, so components always see plain JS.
 */
function toJS(value: any): any {
  if (value == null || typeof value !== 'object') return value;
  try {
    const data = NSJSONSerialization.dataWithJSONObjectOptionsError(
      NSArray.arrayWithArray([value]),
      0,
      null
    );
    const json = NSString.alloc().initWithDataEncoding(data, 4 /* UTF-8 */);
    return JSON.parse(String(json))[0];
  } catch {
    return value;
  }
}

/** Copy an instance method's IMP onto the metaclass, making it a class method. */
function promoteToClassMethod(cls: any, selector: string): void {
  const sel = g.sel_registerName(selector);
  const method = g.class_getInstanceMethod(cls, sel);
  g.class_addMethod(
    g.object_getClass(cls),
    sel,
    g.method_getImplementation(method),
    g.method_getTypeEncoding(method)
  );
}

// ── Native events via the Obj-C runtime ───────────────────────────────────
// RN's event pipeline hands the *view* a native-origin `RCTBubblingEventBlock`
// through a `set<Event>:` setter. NativeScript can't *call* that block directly
// (a runtime-supplied block has no metadata signature to build a call from), but
// the Obj-C runtime can: `imp_implementationWithBlock` turns a real native block
// into a method IMP, and messaging that method invokes the block. So we
//   (a) CAPTURE RN's block by giving the view `set<Event>:` methods (added with
//       `extend` — a supported inbound conversion that yields a JS wrapper still
//       carrying the raw block pointer), then
//   (b) FIRE it by promoting that raw pointer to an IMP on the payload dict's
//       class and sending the selector, so the runtime calls `block(payloadDict)`.
// The event then flows through RN's own dispatcher to the React `on<Event>` prop —
// no bridge, identical to a codegen'd native component's events.
const eventHandlers = new WeakMap<any, Record<string, any>>(); // view → { event: RN block }
let classCounter = 0;
let fireSel: any;
const hostViewCache = new Map<string, any>();
const childCounts = new WeakMap<any, number>(); // view → last React child count

function eventSetter(event: string): string {
  return `set${event[0]!.toUpperCase()}${event.slice(1)}:`; // onValueChange → setOnValueChange:
}

/** A subclass of `Base` that (a) captures RN's dispatching block for each event —
 *  RN's `createEventSetter` KVC-calls `set<Event>:` on the view, and the block
 *  arrives as a JS wrapper we stash keyed by the view — and (b) routes React
 *  children through the component's `childrenView()`. Cached per (base, events). */
export function defineHostView(Base: any, events: string[]): any {
  const key = `${Base?.name ?? '?'}:${events.join(',')}`;
  let Sub = hostViewCache.get(key);
  if (Sub) return Sub;
  const methods: Record<string, any> = {};
  const exposed: Record<string, any> = {};

  // React children. Fabric's interop layer has already recorded them with the
  // default `insertReactSubview:atIndex:` (so RN's own bookkeeping stays intact);
  // this is the hook that decides where they actually land. Re-`addSubview:`ing
  // every child in order also settles their z-order, exactly like RN's default.
  //
  // RN calls this at the end of EVERY update of the view, not just when the
  // children changed, so `childrenChanged()` is only forwarded when the count
  // actually moved — otherwise a component that reacts to it (by emitting an
  // event, say) would drive an endless render loop.
  methods.didUpdateReactSubviews = function (this: any) {
    const instance = instances.get(this);
    const container = instance?.childrenView() ?? this;
    const children = this.reactSubviews(); // NSArray, RN's own child list
    const count = children ? children.count : 0;
    for (let i = 0; i < count; i++) {
      container.addSubview(children.objectAtIndex(i));
    }
    if (instance && childCounts.get(this) !== count) {
      childCounts.set(this, count);
      instance.childrenChanged(count);
    }
    instance?.childrenUpdated(count);
  };
  exposed.didUpdateReactSubviews = { returns: objcVoidType(), params: [] };

  for (const event of events) {
    const selector = eventSetter(event); // one colon = one param
    methods[selector] = function (this: any, handler: any) {
      let map = eventHandlers.get(this);
      if (!map) eventHandlers.set(this, (map = {}));
      map[event] = handler;
    };
    exposed[selector] = { returns: objcVoidType(), params: [g.NSObject] };
  }
  Sub = Base.extend(methods, {
    name: `RNWHostView_${classCounter++}`,
    exposedMethods: exposed,
  });
  hostViewCache.set(key, Sub);
  return Sub;
}

/** Fire a native-origin block via the Obj-C runtime. A block's first argument is
 *  its own receiver, so we message the payload dict — the runtime calls
 *  `block(payloadDict)`. */
function fireNativeBlock(handler: any, payload: Props): void {
  const body = NSMutableDictionary.alloc().init();
  for (const key of Object.keys(payload))
    body.setObjectForKey(payload[key], key as any);
  // Pass the RAW block pointer, not the JS wrapper — imp_implementationWithBlock
  // does _Block_copy, which only works on a real native block.
  const raw = handler.__nativeApiPointerObject ?? handler;
  const imp = g.imp_implementationWithBlock(raw);
  if (!fireSel) fireSel = g.sel_registerName('rnw__fireEvent');
  g.class_replaceMethod(g.object_getClass(body), fireSel, imp, 'v@:');
  (body as any).performSelector(fireSel);
}

let TargetClass: any;
const controlHandlers = new WeakMap<object, () => void>();
function controlTargetClass() {
  if (!TargetClass) {
    TargetClass = g.NSObject.extend(
      {
        workerHandleAction(this: object) {
          controlHandlers.get(this)?.();
        },
      },
      {
        name: 'RNWorkersControlTarget',
        exposedMethods: {
          workerHandleAction: { returns: objcVoidType(), params: [] },
        },
      }
    );
  }
  return TargetClass;
}

/**
 * Register component classes with React Native. Returns descriptors the host uses
 * to build each component's view config.
 */
export function registerComponents(classes: ComponentClass[]): Descriptor[] {
  for (const Component of classes) {
    const name = Component.componentName ?? Component.name;
    if (registered.has(name)) continue;
    const props = Component.props ?? [];
    const events = Component.events ?? [];

    const methods: Record<string, any> = {
      view() {
        const instance = new Component();
        const view = instance.create();
        instance.view = view;
        instances.set(view, instance);
        return view;
      },
    };
    const exposed: Record<string, any> = {};
    for (const prop of props) {
      methods[`propConfig_${prop}`] = () =>
        NSArray.arrayWithArray(['id', '__custom__']);
      // RN calls this per changed prop; accumulate so `update()` sees full props.
      methods[`set_${prop}:forView:withDefaultView:`] = (
        json: any,
        view: any
      ) => {
        const instance = instances.get(view);
        if (!instance) return;
        let state = propState.get(view);
        if (!state) propState.set(view, (state = {}));
        state[prop] = toJS(json);
        // RN calls this from Obj-C, so an exception here unwinds through the
        // interop trampoline and aborts the process. Report it instead.
        try {
          instance.update(state);
        } catch (err: any) {
          const message = `[worker-component] ${name}.${prop}: ${err?.message ?? err}`;
          const hook = (globalThis as any).__rnwComponentError;
          if (typeof hook === 'function') hook(message);
          else console.error(message);
        }
      };
      exposed[`propConfig_${prop}`] = { returns: NSObject, params: [] };
      exposed[`set_${prop}:forView:withDefaultView:`] = {
        returns: objcVoidType(),
        params: [NSObject, NSObject, NSObject],
      };
    }
    // Events: declare each as a plain RCTBubblingEventBlock (NOT __custom__), so RN
    // builds its event setter and hands the *view* a dispatching block via
    // `set<Event>:` — which `installEventSetters` captures.
    for (const event of events) {
      methods[`propConfig_${event}`] = () =>
        NSArray.arrayWithArray(['RCTBubblingEventBlock']);
      exposed[`propConfig_${event}`] = { returns: NSObject, params: [] };
    }

    const Manager = g.RCTViewManager.extend(methods, {
      name: `${name}Manager`,
      exposedMethods: exposed,
    });
    for (const prop of props)
      promoteToClassMethod(Manager, `propConfig_${prop}`);
    for (const event of events)
      promoteToClassMethod(Manager, `propConfig_${event}`);

    g.RCTRegisterModule(Manager);
    registered.set(name, { name, props, events });
  }
  return [...registered.values()];
}

/** Expose the component descriptors to the host (a one-time query, not per-prop). */
export function serveComponents(): void {
  parent.register('nativecomponents', {
    list: () => [...registered.values()],
  });
}
