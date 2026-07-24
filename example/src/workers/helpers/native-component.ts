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
//   • Events use the worker's RPC channel. RN's event pipeline hands the view an
//     `RCTBubblingEventBlock` to call, but NativeScript can't invoke a
//     native-origin block (it has no metadata signature for it), so we route
//     events over the bridge instead, keyed by the mounted view's React tag.
//
// The objc-runtime C functions (`sel_registerName`, `class_addMethod`, …) are all
// in the regenerated interop metadata.
import NativeScript from '@nativescript/react-native';

declare const parent: any;

const g = globalThis as any;
const objcVoid = g.interop?.types?.void;

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

  /** Fire an event to the matching `on<Event>` React prop; `payload` → `nativeEvent`. */
  emit(event: string, payload: Props = {}): void {
    parent
      .module('host')
      .dispatchEvent({ tag: reactTag(this.view), event, payload });
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

/** The React tag of the interop wrapper hosting our view — for event routing. */
function reactTag(view: any): number | null {
  for (let v = view; v; v = v.superview) {
    const tag = v.tag;
    if (tag && tag > 0) return tag;
  }
  return null;
}

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
          workerHandleAction: { returns: objcVoid, params: [] },
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
        instance.update(state);
      };
      exposed[`propConfig_${prop}`] = { returns: NSObject, params: [] };
      exposed[`set_${prop}:forView:withDefaultView:`] = {
        returns: objcVoid,
        params: [NSObject, NSObject, NSObject],
      };
    }

    const Manager = g.RCTViewManager.extend(methods, {
      name: `${name}Manager`,
      exposedMethods: exposed,
    });
    for (const prop of props)
      promoteToClassMethod(Manager, `propConfig_${prop}`);

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
